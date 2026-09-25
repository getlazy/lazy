/**
 * Credential NAMES — the vocabulary the credential store, the daemon credential
 * gate and `[agents.<name>] credential` all share.
 *
 * TWO KINDS OF NAME, one namespace:
 *
 *  - A PROVIDER ({@link Provider}) is one of the services lazy knows by name:
 *    it has a label, the credential kinds it issues, the env vars those kinds
 *    are carried in, and instructions for obtaining one. Providers are what the
 *    daemon credential gate reasons about, and what a profile's credential
 *    DEFAULTS to (from its endpoint's hostname).
 *  - A NAMED credential is any other name a user picks — `credential =
 *    "work-openai"`, stored with `lazy auth set work-openai`. lazy knows nothing
 *    about it beyond "here is a secret, send it to this profile's upstream", so
 *    its spec is synthesized ({@link namedSpec}) rather than tabulated.
 *
 * Named credentials exist for the case providers cannot express: two profiles
 * on the SAME provider that must be billed to DIFFERENT keys — two OpenAI orgs,
 * a personal and a work Anthropic account. Two profiles that name no credential
 * and resolve to the same provider still share one key, which is the common
 * case and stays zero-configuration.
 *
 * A provider is "whoever needs to be paid/authenticated for this traffic", not
 * "an env var". That distinction is the whole point of this module: the gate
 * used to ask "is CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set?", which is
 * a question about one vendor's spelling rather than about what the project
 * actually configured. A project whose roles all run against a local Ollama
 * needs no credential at all; a project with the builder on Anthropic and its
 * agents on Ollama needs exactly one. Both answers fall out of the role targets
 * — see {@link requiredProviders}.
 *
 * Adding a provider is a change HERE and nowhere else: the store, the gate, the
 * hydration step and `lazy auth` all iterate this table.
 */

import type { ResolvedConfig, RoleTarget } from '../config/types';
import {
  type AgentProfile,
  BUILDER_PROFILE_NAME,
  DEFAULT_AGENT_PROFILE_NAME,
  agentProfileOrThrow,
  agentProfilesFor,
  profileCredentialName,
  resolveAgentProfiles,
} from '../config/agent-profiles';
import { isChatGptEndpoint } from '../utils/openai-compat';

/** Every provider lazy knows by name. */
export type Provider = 'anthropic' | 'chatgpt' | 'cursor' | 'ollama' | 'openai' | 'openrouter';

export const PROVIDERS: readonly Provider[] = ['anthropic', 'chatgpt', 'cursor', 'ollama', 'openai', 'openrouter'] as const;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * A credential name: a {@link Provider}, or any user-chosen name.
 *
 * Typed as a bare string on purpose — the store holds whatever name a profile
 * references, and a closed union here would make the store's keys and lazy.toml
 * disagree. Shape is validated once, where the name is written
 * (`src/config/agent-profiles.ts` and `lazy auth set`), so everything
 * downstream can treat it as an opaque account name.
 */
export type CredentialName = string;

/**
 * Which credential a provider holds — and therefore which env var it is
 * injected into, and which wire shape the client will emit.
 *
 *   oauth   → CLAUDE_CODE_OAUTH_TOKEN → `Authorization: Bearer …`
 *   api-key → ANTHROPIC_API_KEY       → `x-api-key: …`
 *
 * Mirrors `UserCredentialKind` in src/daemon/user-credentials.ts, which is the
 * team-mode (control-plane) store for the same secrets. Kept as a separate type
 * rather than imported so this module has no dependency on the daemon: the
 * values must stay in step, and `test/unit/credential-store.test.ts` asserts it.
 */
export type CredentialKind = 'oauth' | 'api-key';

export const CREDENTIAL_KINDS: readonly CredentialKind[] = ['oauth', 'api-key'] as const;

interface ProviderSpec {
  /** Human-facing name for messages. */
  label: string;
  /** Kinds this provider accepts, in the order `lazy auth set` offers them. */
  kinds: readonly CredentialKind[];
  /** Env var carrying each kind. Also the env vars consulted as a fallback. */
  envVar: Record<CredentialKind, string | null>;
  /** How to obtain one, for actionable errors. */
  howToGet: string;
  /**
   * True when LAZY renews this credential itself, rewriting the stored secret.
   *
   * Such a credential must NOT be hydrated into the daemon's environment (see
   * ../credentials/hydrate.ts), and the reason is the RENEWAL LOOP, not any
   * precedence rule. Renewal reads the current secret, exchanges it upstream —
   * which retires the old one there and then — and writes the new one back to
   * the store. A hydrated copy inserts a second, unwritable home for that
   * secret into the loop: the renewing resolver would be handed the startup
   * copy, exchange a refresh token the store no longer holds, and have nowhere
   * to put the result. The credential then works until the first renewal and is
   * permanently dead after it, with nothing saying why.
   *
   * (It used to be enough to say "an env value outranks the store". That is no
   * longer true of hydration's own copies — resolution now prefers the store
   * for them, see ../credentials/hydrated-env.ts — and this rule is unaffected,
   * because it never depended on which one wins. Such a credential's resolver
   * reads and rewrites the store directly, so hydration buys it nothing and
   * costs it everything.)
   */
  selfRefreshing?: boolean;
  /**
   * True when the running DAEMON reads this credential out of its own
   * environment rather than from the store, so a newly stored one only reaches
   * it after a restart.
   *
   * Anthropic is the one: the proxy resolves it through `getAuthEnvVars()`, and
   * launches read the same variables. Every other credential is resolved from
   * the store LIVE — per request in src/proxy/credential-deps.ts, per launch in
   * src/agent/credentials.ts — so telling a user to restart the daemon for one
   * of those interrupts every running task to achieve nothing. `lazy auth`
   * reads this to say which of the two it is instead of asserting the stricter
   * one for everything.
   */
  daemonEnv?: boolean;
}

const SPECS: Record<Provider, ProviderSpec> = {
  anthropic: {
    label: 'Anthropic',
    kinds: ['oauth', 'api-key'],
    envVar: {
      oauth: 'CLAUDE_CODE_OAUTH_TOKEN',
      'api-key': 'ANTHROPIC_API_KEY',
    },
    howToGet: 'run `claude setup-token` for an OAuth token, or use an Anthropic API key',
    daemonEnv: true,
  },
  /**
   * A ChatGPT Plus/Pro SUBSCRIPTION, which the Codex agent can run on instead of
   * a metered OpenAI API key.
   *
   * A PROVIDER of its own rather than a second kind on `openai`, because the two
   * are billed by different services at different hosts: an API key pays
   * api.openai.com, a subscription pays chatgpt.com/backend-api/codex. A profile
   * has exactly one `endpoint`, so folding both into one slot would mean
   * inferring the host from whichever credential happened to be stored — and
   * `defaultCredentialFor` already picks the slot from the endpoint's hostname,
   * which gets this right for free. Keeping them apart also lets a project hold
   * both at once and choose per task.
   *
   * `oauth` is its only kind: the subscription issues no API key. The secret is
   * the token SET (access + refresh + account id) as compact JSON — see
   * ./chatgpt-tokens.ts.
   */
  chatgpt: {
    label: 'ChatGPT subscription',
    kinds: ['oauth'],
    envVar: {
      oauth: 'CHATGPT_AUTH',
      'api-key': null,
    },
    howToGet:
      'run `codex login` (or `codex login --device-auth` on a headless host), then `lazy auth import chatgpt`',
    // A ChatGPT access token lives hours and lazy renews it from the refresh
    // token, rewriting the store. See `selfRefreshing` above for why that makes
    // hydrating this one actively destructive.
    selfRefreshing: true,
  },
  cursor: {
    label: 'Cursor',
    kinds: ['api-key'],
    envVar: {
      oauth: null,
      'api-key': 'CURSOR_API_KEY',
    },
    howToGet: 'copy an API key from the Cursor dashboard, or run `cursor-agent login` for host runs',
  },
  ollama: {
    label: 'Ollama',
    kinds: ['api-key'],
    envVar: {
      oauth: null,
      'api-key': 'OLLAMA_API_KEY',
    },
    howToGet: 'create an API key at https://ollama.com and run `lazy auth set ollama`',
  },
  openai: {
    label: 'OpenAI',
    kinds: ['api-key'],
    envVar: {
      oauth: null,
      'api-key': 'OPENAI_API_KEY',
    },
    howToGet: 'create an API key at https://platform.openai.com/api-keys and run `lazy auth set openai`',
  },
  openrouter: {
    label: 'OpenRouter',
    kinds: ['api-key'],
    envVar: {
      oauth: null,
      'api-key': 'OPENROUTER_API_KEY',
    },
    howToGet: 'create an API key at https://openrouter.ai/keys and run `lazy auth set openrouter`',
  },
};

/**
 * The env var a NAMED credential's api-key form is carried in.
 *
 * Mechanical from the name, so a CI job can export one without lazy having to
 * know the name in advance — the same escape hatch every provider has, and the
 * reason `resolveCredential` can keep "env wins over the store" as one rule
 * rather than two. The oauth form takes an `_OAUTH` suffix so the two kinds stay
 * distinguishable: the proxy derives a named credential's HEADER from its kind,
 * so a token found under the api-key name really must be an api key.
 */
export function namedCredentialEnvVar(name: CredentialName, kind: CredentialKind): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return kind === 'oauth' ? `LAZY_CREDENTIAL_${slug}_OAUTH` : `LAZY_CREDENTIAL_${slug}`;
}

/**
 * The synthesized spec for a name lazy does not know.
 *
 * Both kinds are offered because a named credential's whole purpose is a SECOND
 * key on a service lazy already knows — and Anthropic issues both forms, so
 * refusing oauth here would make "my other Claude account" unexpressible.
 */
function namedSpec(name: CredentialName): ProviderSpec {
  return {
    label: name,
    kinds: ['api-key', 'oauth'],
    envVar: {
      'api-key': namedCredentialEnvVar(name, 'api-key'),
      oauth: namedCredentialEnvVar(name, 'oauth'),
    },
    howToGet:
      `store the API key for the endpoint that uses it: \`lazy auth set ${name}\``,
  };
}

function specFor(name: CredentialName): ProviderSpec {
  return isProvider(name) ? SPECS[name] : namedSpec(name);
}

/** Human-facing name for messages — a provider's label, or the name itself. */
export function credentialLabel(name: CredentialName): string {
  return specFor(name).label;
}

/** Kinds this credential accepts, in the order `lazy auth set` offers them. */
export function credentialKinds(name: CredentialName): readonly CredentialKind[] {
  return specFor(name).kinds;
}

/** How to obtain this credential, for actionable errors. */
export function credentialHowToGet(name: CredentialName): string {
  return specFor(name).howToGet;
}

/**
 * Does lazy renew this credential itself, rewriting the stored secret?
 *
 * The one thing that answers it is the provider table — see `selfRefreshing`
 * there for why hydration must skip these. A NAMED credential answers false:
 * lazy knows nothing about a name it did not define, so it never renews one.
 * (A named credential pointed at the ChatGPT backend IS renewed by the proxy
 * resolver, which reaches the store directly and is therefore unaffected by
 * hydration — hydration only ever fills a PROVIDER's env var.)
 */
export function credentialSelfRefreshing(name: CredentialName): boolean {
  return specFor(name).selfRefreshing === true;
}

/**
 * Does a RUNNING daemon have to be restarted to pick this credential up?
 *
 * See `daemonEnv` above: true only for the credential the daemon reads from its
 * environment. A NAMED credential answers false — nothing hydrates one, and
 * both the proxy and the launch path read it from the store per use.
 */
export function credentialNeedsDaemonRestart(name: CredentialName): boolean {
  return specFor(name).daemonEnv === true;
}

/**
 * The `lazy auth …` subcommand that stores this credential — without the `lazy`.
 *
 * Almost always `set <name>`. A ChatGPT subscription is the exception: its
 * secret is the multi-field session `codex login` wrote to a file, so `import`
 * is both the command that works and the one a user can actually follow. Naming
 * `set` there would send them pasting a JSON blob at a masked prompt.
 *
 * @param profileName - The agent profile this credential is being set up FOR,
 *   when there is one. `lazy auth` resolves an agent name to the credential it
 *   bills ({@link resolveCredentialTarget}), so naming the profile gives a user
 *   who chose `--agent codex-subscription` a command in the vocabulary they
 *   already have, instead of one naming a credential they have never heard of.
 */
export function credentialSetupCommand(name: CredentialName, profileName?: string): string {
  const verb = name === 'chatgpt' ? 'import' : 'set';
  return `auth ${verb} ${profileName ?? name}`;
}

/**
 * The env var a credential of this kind is carried in, or null when the
 * credential has no such kind (e.g. Cursor has no OAuth form).
 */
export function envVarFor(name: CredentialName, kind: CredentialKind): string | null {
  return specFor(name).envVar[kind];
}

/** Every env var that can carry this credential, in precedence order. */
export function envVarsFor(name: CredentialName): string[] {
  const spec = specFor(name);
  return spec.kinds.map((kind) => spec.envVar[kind]).filter((v): v is string => v !== null);
}

/**
 * The provider whose credential a resolved role target needs, or null when it
 * needs none.
 *
 * The answer is READ, not derived: a profile resolves its own credential slot
 * at config load (`defaultCredentialFor` in src/config/agent-profiles.ts), from
 * an explicit `credential = "..."` or from the endpoint's hostname, and a role
 * target is a flattened profile. Re-deriving it here from the endpoint would be
 * a second rule that can disagree with the one the proxy actually bills by.
 *
 * `none` — a local model server ignores auth, so nothing is required and
 * nothing is sent. A daemon whose roles are all local needs no credential.
 *
 * A credential slot that is not a known provider is a NAMED credential
 * (`credential = "work-openai"`), which the store holds under that name; there
 * is no provider-level gate for one, so it answers null here.
 */
export function providerForTarget(target: Pick<RoleTarget, 'credential'>): Provider | null {
  return isProvider(target.credential) ? target.credential : null;
}

/**
 * Which providers must have a credential for THIS project's configuration.
 *
 * Reads the EFFECTIVE role targets — the profile each role DEFAULTS to, which
 * `loadConfig` has already resolved from `[models.roles.*] agent`, else
 * `[agent] agent_id`, else the built-in `claude-code` profile. An all-local
 * setup needs none and is let through; a mixed setup still needs its Anthropic
 * token.
 *
 * Deliberately the ROLE DEFAULTS, not every profile the project declares.
 * Declaring `[agents.work-codex]` is not a statement that any task runs it
 * today, and refusing to start the daemon over a profile nothing has selected
 * would make adding a profile a breaking change. A task that DOES select one
 * resolves its credential at launch and fails there, naming the profile — the
 * same treatment Cursor already gets.
 *
 * Cursor is NOT included for that reason: a Cursor key is resolved per launch
 * (src/agent/credentials.ts) and a missing one warns at launch; gating daemon
 * startup on it would refuse a daemon for every task that is not a Cursor task.
 */
export function requiredProviders(config: ResolvedConfig): Provider[] {
  const providers = new Set<Provider>();
  for (const role of ['builder', 'agent'] as const) {
    const provider = providerForTarget(config.models.roles[role]);
    if (provider) providers.add(provider);
  }
  return [...providers];
}

/** Where a name typed at `lazy auth` actually reads and writes. */
export interface CredentialTarget {
  /** The store key. */
  credential: CredentialName;
  /** The agent profile the name turned out to be, when it was one. */
  viaProfile?: string;
}

/**
 * The credential a name typed at `lazy auth <verb> <name>` refers to.
 *
 * WHY A NAME CAN BE A PROFILE. lazy has two vocabularies that a user has every
 * reason to expect to be one: agent profiles (`codex-subscription`, `codex-api`)
 * and credentials (`chatgpt`, `openai`). They are genuinely different things —
 * a ChatGPT subscription is a SERVICE that any harness can be pointed at, not a
 * property of codex — so the credential vocabulary is not renamed to match. But
 * "the agent is called codex-subscription, so why am I importing chatgpt?" is a
 * fair question, and the answer a user should get is the credential that
 * profile bills, not a credential stored under a name nothing reads.
 *
 * That last part is the bug this closes: `lazy auth import codex` used to store
 * a ChatGPT session under the name `codex`, which no profile bills (the `codex`
 * profile bills `openai`), so it was accepted, reported as stored, and never
 * used by anything.
 *
 * Resolution order, first match wins:
 *  1. a provider name — the vocabulary lazy defines;
 *  2. a name ALREADY IN THE STORE — an existing entry is evidence of intent,
 *     and a profile that happens to share its spelling is not. Without this,
 *     the hop is destructive for anyone who stored a credential under a
 *     profile-shaped name before it resolved to anything (`lazy auth import
 *     codex` did exactly that, silently): `rm` would report nothing to remove
 *     while the entry stayed put and unreachable, and `set` would overwrite the
 *     credential the profile bills instead of the one they meant;
 *  3. a name some profile already names as its `credential` — a NAMED
 *     credential in use keeps its meaning even if a profile shares its spelling;
 *  4. an agent PROFILE name — resolves to the credential that profile bills;
 *  5. anything else — itself, so storing a named credential before the profile
 *     that will reference it still works.
 *
 * @param storedNames - Names the credential index already holds. Passed in
 *   rather than read here so this stays a pure rule over both vocabularies —
 *   the store is the caller's to open, and `lazy auth` is the only caller.
 */
export function resolveCredentialTarget(
  config: ResolvedConfig | null,
  name: CredentialName,
  storedNames: ReadonlySet<string> = new Set(),
): CredentialTarget {
  if (isProvider(name) || storedNames.has(name) || !config) return { credential: name };

  const profiles = agentProfilesFor(config);
  for (const profile of profiles.values()) {
    if (profileCredentialName(profile) === name) return { credential: name };
  }

  const profile = profiles.get(name);
  if (!profile) return { credential: name };

  const credential = profileCredentialName(profile);
  if (!credential) {
    throw new Error(
      `The "${name}" agent profile bills no credential — its endpoint is a local model server, ` +
      `which needs none. There is nothing to store for it.`,
    );
  }
  return { credential, viaProfile: name };
}

/**
 * Agent profiles that bill this credential, sorted. For messages that have to
 * explain a credential in the vocabulary the user came in with.
 */
export function profilesBilling(config: ResolvedConfig | null, credential: CredentialName): string[] {
  return billingProfiles(config, credential).map((p) => p.name).sort();
}

/**
 * Can this credential hold a ChatGPT subscription SESSION — the thing
 * `lazy auth import` stores?
 *
 * The `chatgpt` provider can, by definition. Another PROVIDER cannot: an
 * OpenAI, OpenRouter, Ollama or Cursor key is an opaque string, and importing a
 * session into one of those slots stores something no upstream will accept,
 * with the failure landing hours later as an unexplained 401.
 *
 * A NAMED credential answers from the profiles that bill it — a name pointed at
 * the ChatGPT backend holds a session whatever it is called, which is the same
 * rule the proxy resolves by (`resolverForSlot` in src/proxy/credential-deps.ts).
 * A name NOTHING bills answers true: lazy knows nothing about it, and refusing
 * it would make "store the session now, write the profile later" impossible.
 */
export function credentialTakesChatGptSession(
  config: ResolvedConfig | null,
  credential: CredentialName,
): boolean {
  if (credentialHoldsChatGptSession(config, credential)) return true;
  // Not established, but not refused either: an unknown NAME is the user's own.
  return !isProvider(credential) && billingProfiles(config, credential).length === 0;
}

/**
 * Is this credential KNOWN to hold a ChatGPT session? The same question
 * {@link credentialTakesChatGptSession} asks, minus its benefit of the doubt —
 * for `lazy auth refresh`, which must not fire a renewal round trip at a slot
 * that merely might be one.
 */
export function credentialHoldsChatGptSession(
  config: ResolvedConfig | null,
  credential: CredentialName,
): boolean {
  if (credential === 'chatgpt') return true;
  if (isProvider(credential)) return false;
  return billingProfiles(config, credential).some((p) => isChatGptEndpoint(p.endpoint));
}

function billingProfiles(config: ResolvedConfig | null, credential: CredentialName): AgentProfile[] {
  if (!config) return [];
  return [...agentProfilesFor(config).values()].filter(
    (p) => profileCredentialName(p) === credential,
  );
}

/** One credential the project's configured profiles bill, and who bills it. */
export interface RequiredCredential {
  /** Credential name — a provider (`anthropic`) or a user-chosen one (`work-openai`). */
  name: CredentialName;
  /** Profiles whose `credential` slot names it, sorted. Never empty. */
  requiredBy: string[];
}

/**
 * Every credential this project's CONFIGURED profiles bill — the DIAGNOSTIC
 * question, as {@link requiredProviders} is the GATE's.
 *
 * Same rule for what one profile needs (its resolved `credential` slot, read
 * and never re-derived), different scope. The gate reads the two ROLE DEFAULTS
 * because refusing to START a daemon over a profile nothing has selected would
 * make declaring one a breaking change. A report has no such cost, and the
 * opposite blind spot: a task that selects `[agents.work-codex]` refuses to
 * launch when its credential is missing, and `lazy doctor` is where a user
 * expects to learn that BEFORE the task does. So this walks every profile the
 * configuration REFERENCES:
 *
 *  - the profile each role defaults to (`[models.roles.*] agent`, else
 *    `[agent] agent_id`, else the built-in default),
 *  - every profile `[agent.by_type]` selects,
 *  - every `[agents.<name>]` block — declaring one is a statement of intent.
 *
 * Built-ins nothing names are left out on purpose: they exist implicitly for
 * every project, so counting them would make a plain claude-code project
 * "require" OpenAI and Cursor keys it will never present.
 *
 * `none` is excluded — nothing can be present for it. Cursor is INCLUDED: the
 * gate's reason for skipping it (a missing key must not refuse a daemon) is a
 * statement about refusing, not about reporting. Named credentials appear
 * under their own name, exactly as `lazy auth set` stores them.
 *
 * Order: providers in {@link PROVIDERS} order, then named credentials
 * alphabetically — the order `lazy auth list` prints, so the two surfaces read
 * alike.
 */
export function requiredCredentials(config: ResolvedConfig): RequiredCredential[] {
  const profiles = agentProfilesFor(config);
  const referenced = new Set<string>([
    config.models.roles.builder.profile,
    config.models.roles.agent.profile,
    ...Object.values(config.agent.by_type ?? {}).filter((name): name is string => !!name),
    ...[...profiles.values()].filter((p) => !p.builtin).map((p) => p.name),
  ]);
  return collectRequiredCredentials(profiles, referenced);
}

/**
 * What a project with NO loadable configuration requires: the credentials of
 * the built-in profiles the two roles default to. `lazy doctor` uses this when
 * lazy.toml will not parse, so the credential check still answers for the
 * profiles a daemon started against that file would fall back to.
 */
export function defaultRequiredCredentials(): RequiredCredential[] {
  const profiles = resolveAgentProfiles(undefined, () => {});
  return collectRequiredCredentials(profiles, new Set([BUILDER_PROFILE_NAME, DEFAULT_AGENT_PROFILE_NAME]));
}

function collectRequiredCredentials(
  profiles: Map<string, AgentProfile>,
  referenced: Set<string>,
): RequiredCredential[] {
  const requiredBy = new Map<CredentialName, Set<string>>();
  for (const name of referenced) {
    // Every referenced name was validated at config load (roles, by_type and
    // declared blocks all resolve through agentProfileOrThrow), so a miss here
    // is a loader bug — say so rather than quietly reporting less.
    const profile = agentProfileOrThrow(profiles, name, 'requiredCredentials');
    const credential = profileCredentialName(profile);
    if (!credential) continue;
    const users = requiredBy.get(credential) ?? new Set<string>();
    users.add(profile.name);
    requiredBy.set(credential, users);
  }
  const rank = (name: CredentialName): number => {
    const i = (PROVIDERS as readonly string[]).indexOf(name);
    return i < 0 ? PROVIDERS.length : i;
  };
  return [...requiredBy.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, users]) => ({ name, requiredBy: [...users].sort() }));
}
