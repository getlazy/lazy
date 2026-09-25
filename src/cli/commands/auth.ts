/**
 * `lazy auth` — store, inspect and remove model-provider credentials.
 *
 * WHY THIS EXISTS. Before it, lazy's model credential lived in exactly one
 * place: the environment of whatever shell started the daemon. That made
 * switching providers an exercise in env surgery, and made `lazy upgrade` — which
 * restarts the daemon from the invoking shell — abort with "no authentication
 * credential found" whenever that shell did not happen to export a token. The
 * credential was on the machine; it just was not in that terminal.
 *
 * `lazy auth set <provider>` puts it in OS secure storage (macOS Keychain,
 * libsecret on Linux; a 0600 file outside the repo on headless hosts), per
 * project and per provider. The daemon loads it at startup, so no shell needs to
 * carry it any more.
 *
 * ENV STILL WINS, everywhere. An exported variable overrides the store, so an
 * existing env-var setup keeps working exactly as it did and this is purely
 * additive. `lazy auth list` says which source is actually in effect, because
 * "I stored a key and it is still using the old one" is otherwise a genuinely
 * confusing half hour.
 *
 * SECRETS NEVER IN ARGV. Like `lazy system agent set-key`, the secret is read
 * from a masked prompt or piped stdin only. A credential passed as an argument
 * is in shell history and visible in `ps` to every user on the machine; there is
 * no way to make that safe, so the form is not offered.
 *
 * DELIBERATE ASYMMETRY: no MCP counterpart. Writing credentials is a human
 * decision and agents must never do it. See public-docs/surface-asymmetries.md.
 */

import { requireLazyRoot } from '../helpers';
import { loadConfig } from '../../config/loader';
import {
  type CredentialName,
  type CredentialKind,
  PROVIDERS,
  isProvider,
  credentialKinds,
  credentialLabel,
  credentialHowToGet,
  credentialSelfRefreshing,
  credentialNeedsDaemonRestart,
  credentialSetupCommand,
  credentialTakesChatGptSession,
  credentialHoldsChatGptSession,
  profilesBilling,
  resolveCredentialTarget,
  type CredentialTarget,
  envVarsFor,
  envVarFor,
  requiredProviders,
} from '../../credentials/providers';
import type { ResolvedConfig } from '../../config/types';
import {
  credentialHint,
  credentialPresence,
  deleteCredential,
  purgeOrphanCredential,
  readCredentialIndex,
  setCredential,
} from '../../credentials/store';
import { agentProfilesFor, NO_CREDENTIAL } from '../../config/agent-profiles';
import { unreferencedCredentialAdvice } from '../../config/agent-profile-advice';
import { BACKEND_DESCRIPTIONS } from '../../credentials/backends';
import { readFile } from 'fs/promises';
import { isTTY, promptSecret } from '../editor';
import { getHome } from '../../utils/home';
import {
  accessTokenExpiry,
  codexAuthJsonPath,
  parseChatGptTokens,
  serializeChatGptTokens,
} from '../../credentials/chatgpt-tokens';
import { CHATGPT_CREDENTIAL, resolveChatGptSession } from '../../credentials/chatgpt-session';
import { theme } from '../../render/theme';

/**
 * What to say about the daemon after storing this credential — and it must be
 * TRUE, because the advice costs a daemon restart that interrupts every running
 * task.
 *
 * Only the Anthropic credential is read from the daemon's ENVIRONMENT, where a
 * restart is genuinely the way in. Everything else is resolved from the store
 * per request (the proxy) or per launch (agent credentials), so it lands on the
 * next turn with nothing to restart.
 *
 * REPLACEMENT USED TO BE A HEDGE and no longer is. A provider credential that
 * was already stored when the daemon started is hydrated into its environment
 * then, and this line used to warn that the startup copy would win until a
 * restart. Resolution now tells hydration's own copies from a user's export and
 * keeps preferring the store for them (see ../../credentials/hydrated-env.ts),
 * so the answer is the same whether or not something was already stored — which
 * is why nothing here needs to know.
 *
 * @param session - True when what was just stored is a refreshable SESSION
 *   whatever it is called — `lazy auth import` knows this about its own output,
 *   where {@link credentialSelfRefreshing} can only answer for the name.
 */
function effectAdvice(credential: CredentialName, session = false): string[] {
  if (credentialNeedsDaemonRestart(credential)) {
    return ['The daemon loads it at startup — restart it to pick this up now: lazy daemon restart'];
  }
  return [
    session || credentialSelfRefreshing(credential)
      ? 'In effect on the next turn — this session is read from the store per request, so no daemon restart is needed.'
      : 'In effect on the next turn — lazy reads this credential from the store per use, so no daemon restart is needed.',
  ];
}

/**
 * The project's configuration, or null when it will not load.
 *
 * NULL IS A SUPPORTED ANSWER. `lazy auth set` must work in a project whose
 * lazy.toml is currently broken — often the very thing being fixed — so the
 * config is an ENRICHMENT here (which profile bills which credential), never a
 * precondition. Everything downstream treats null as "lazy knows only the
 * provider vocabulary", which is exactly how this command behaved before
 * profiles were consulted at all.
 */
async function tryLoadConfig(root: string): Promise<ResolvedConfig | null> {
  try {
    return await loadConfig(root);
  } catch {
    // Deliberately silent: `lazy doctor` is the surface that explains a broken
    // lazy.toml, and a credential command must not turn one into a failure.
    return null;
  }
}

/**
 * Resolve the name the user typed to the credential it means, announcing a
 * profile → credential hop.
 *
 * The announcement is the whole point of allowing the hop: `lazy auth import
 * codex-subscription` storing under `chatgpt` silently would be the "clever"
 * version. Saying which credential it wrote teaches the vocabulary instead.
 *
 * A NAME ALREADY IN THE STORE IS A STORE KEY, and outranks the agent-profile
 * reading. Without that rule the hop becomes destructive on exactly the people
 * this release affects: anyone who stored a credential under a profile-shaped
 * name before it resolved to anything — `lazy auth import codex` did that, and
 * did it silently — would find `lazy auth rm codex` reporting nothing to remove
 * while their entry stayed put, unreachable by name, and `lazy auth set codex`
 * overwriting the `openai` key instead of the thing they meant. An existing
 * entry is evidence of intent; a profile with the same spelling is not.
 */
async function resolveTarget(
  root: string,
  config: ResolvedConfig | null,
  name: CredentialName,
): Promise<CredentialTarget> {
  const stored = new Set((await readCredentialIndex(root)).map(e => e.provider));
  try {
    return resolveCredentialTarget(config, name, stored);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\nNothing was stored.`);
    process.exit(1);
  }
}

/**
 * Say which credential a profile name resolved to — AFTER whatever validation
 * the verb does, so a command that goes on to refuse never announces a write it
 * is about to reject.
 */
function announceTarget(target: CredentialTarget): CredentialName {
  if (target.viaProfile) {
    console.log(theme.separator(
      `The "${target.viaProfile}" agent profile bills the "${target.credential}" credential — using that.`,
    ));
  }
  return target.credential;
}

/** The env var (if any) currently carrying a usable credential. */
function envSourceFor(credential: CredentialName): string | null {
  for (const name of envVarsFor(credential)) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return name;
  }
  return null;
}

/**
 * Every credential worth a line: the providers lazy knows, plus every name an
 * `[agents.<name>]` profile references, plus every name already in the store.
 *
 * The union matters in both directions. A named credential a profile references
 * but nobody has stored yet is exactly the one a user needs to be told about;
 * one in the store that no profile references any more is how they find a key
 * to remove.
 */
function credentialsToList(
  config: Awaited<ReturnType<typeof loadConfig>>,
  stored: readonly string[],
): { names: string[]; usedBy: Map<string, string[]> } {
  const usedBy = new Map<string, string[]>();
  for (const profile of agentProfilesFor(config).values()) {
    if (profile.credential === NO_CREDENTIAL) continue;
    const list = usedBy.get(profile.credential) ?? [];
    list.push(profile.name);
    usedBy.set(profile.credential, list);
  }
  const names = new Set<string>([...PROVIDERS, ...usedBy.keys(), ...stored]);
  // Providers first, in their declared order, then everything else alphabetically —
  // so the familiar list does not shuffle when a project adds a named credential.
  const extra = [...names].filter(n => !isProvider(n)).sort();
  return { names: [...PROVIDERS, ...extra], usedBy };
}

async function listView(root: string): Promise<void> {
  const config = await loadConfig(root);
  const required = new Set<string>(requiredProviders(config));
  const index = await readCredentialIndex(root);
  const { names, usedBy } = credentialsToList(config, index.map(e => e.provider));

  console.log(`Credentials for ${root}\n`);

  for (const provider of names) {
    const env = envSourceFor(provider);
    const stored = await credentialPresence(root, provider);
    const users = usedBy.get(provider) ?? [];
    const marker = required.has(provider)
      ? theme.success('● required by this project')
      : users.length > 0
        ? theme.success(`● used by ${users.map(p => `[agents.${p}]`).join(', ')}`)
        : '  not required by this project';

    console.log(`${provider}  ${marker}`);
    if (env) {
      console.log(`  ${theme.label('In effect:')}  environment (${env})`);
    } else if (stored) {
      console.log(`  ${theme.label('In effect:')}  store (${stored.backend})`);
    } else {
      console.log(`  ${theme.label('In effect:')}  ${theme.warning('none')} — ${credentialHowToGet(provider)}`);
    }
    if (stored) {
      const hint = stored.hint ? ` …${stored.hint}` : '';
      console.log(
        `  ${theme.label('Stored:')}     ${stored.kind}${hint} in ${stored.backend}, updated ${stored.updatedAt}` +
        (env ? theme.separator('  (overridden by the environment)') : ''),
      );
    } else {
      console.log(`  ${theme.label('Stored:')}     none — store one with: lazy ${credentialSetupCommand(provider)}`);
    }
    console.log('');
  }

  console.log(theme.separator(
    'The environment always wins over the store, so an existing export keeps working unchanged.',
  ));
}

/**
 * Read the secret from a masked prompt or piped stdin.
 *
 * See the module header: there is deliberately no argv form.
 */
async function obtainSecret(provider: CredentialName, kind: CredentialKind): Promise<string> {
  if (isTTY()) {
    return promptSecret(`${credentialLabel(provider)} ${kind}`);
  }
  const piped = (await new Response(process.stdin as unknown as ReadableStream).text()).split('\n')[0] ?? '';
  return piped.trim();
}

/**
 * Same shape rule the `[agents.<name>] credential` key enforces
 * (src/config/agent-profiles.ts). Duplicated as a regex rather than imported so
 * this command has no reason to load the config: `lazy auth set` must work in a
 * project whose lazy.toml is currently broken — often the very thing being
 * fixed. Exported so test/unit/credential-store.test.ts can assert the two
 * accept and reject exactly the same names.
 */
export const CREDENTIAL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseCredentialName(value: string | undefined, verb: string): CredentialName {
  if (!value) {
    console.error(
      `Usage: lazy auth ${verb} <name>\n` +
      `Providers: ${PROVIDERS.join(', ')}\n` +
      `Or any name an [agents.<profile>] block references as credential = "<name>".`,
    );
    process.exit(1);
  }
  if (!CREDENTIAL_NAME_RE.test(value)) {
    console.error(
      `Invalid credential name "${value}". Use lowercase letters, digits, and . _ - ` +
      `(starting with a letter or digit), up to 64 characters.`,
    );
    process.exit(1);
  }
  return value;
}

async function setView(root: string, providerArg: string | undefined, rest: string[]): Promise<void> {
  const typed = parseCredentialName(providerArg, 'set');
  const provider = announceTarget(await resolveTarget(root, await tryLoadConfig(root), typed));

  // A secret typed as an argument is already in shell history and in `ps`. Say
  // both things outright rather than silently ignoring the extra word — the
  // user would otherwise believe it was stored AND leave the secret exposed.
  const positional = rest.filter(a => !a.startsWith('--'));
  if (positional.length > 0) {
    console.error(
      `lazy auth set takes no credential argument — the secret is read from a masked prompt\n` +
      `or piped stdin only. A credential on the command line is recorded in your shell history\n` +
      `and is visible in \`ps\` to every user on this machine.\n` +
      `Nothing was stored. If what you typed was a real credential, ROTATE IT, then run:\n` +
      `  lazy auth set ${provider}\n` +
      `  # or: pass show ${provider} | lazy auth set ${provider}`,
    );
    process.exit(1);
  }

  const kinds = credentialKinds(provider);
  let kind = kinds[0];
  const kindIdx = rest.indexOf('--kind');
  if (kindIdx !== -1) {
    const requested = rest[kindIdx + 1];
    if (!requested || !kinds.includes(requested as CredentialKind)) {
      console.error(
        `Invalid --kind for ${provider}. Valid kinds: ${kinds.join(', ')}.`,
      );
      process.exit(1);
    }
    kind = requested as CredentialKind;
  }

  const secret = await obtainSecret(provider, kind);
  if (!secret.trim()) {
    console.error(
      'No credential provided. Type it at the masked prompt, or pipe it in ' +
      `(e.g. \`pass show ${provider} | lazy auth set ${provider}\`).`,
    );
    process.exit(1);
  }

  // A ChatGPT subscription is a structured SESSION, not an opaque string, and
  // `import` validates it. Both commands reach the same store entry, so `set`
  // must apply the same rule — otherwise any string can be stored here and every
  // surface will then report a configured credential that nothing can use, with
  // the failure landing hours later as an unexplained 401. Validated, not
  // refused outright: someone piping a session from their own password manager
  // is doing a reasonable thing.
  if (provider === CHATGPT_CREDENTIAL) {
    try {
      parseChatGptTokens(secret, `the ${provider} credential you provided`);
    } catch (err) {
      console.error(
        `${err instanceof Error ? err.message : String(err)}\n` +
        `Nothing was stored. The usual way in reads the file \`codex login\` wrote:\n` +
        `  lazy auth import ${provider}`,
      );
      process.exit(1);
    }
  }

  const entry = await setCredential(root, { provider, kind, secret });
  const hint = credentialHint(secret);
  console.log(theme.success(
    `Stored the ${credentialLabel(provider)} ${kind}${hint ? ` …${hint}` : ''}.`,
  ));
  console.log(theme.separator(`  ${BACKEND_DESCRIPTIONS[entry.backend]}`));
  for (const line of effectAdvice(provider)) console.log(line);

  const env = envSourceFor(provider);
  if (env) {
    console.log(theme.warning(
      `Note: ${env} is set in this environment and overrides the store. ` +
      `Unset it to use the stored credential.`,
    ));
  }
  const envVar = envVarFor(provider, kind);
  if (envVar && !env) {
    console.log(theme.separator(`  ${envVar}, when set, overrides this.`));
  }
}

/**
 * `lazy auth import <name> [path]` — store a ChatGPT subscription session from
 * the file `codex login` wrote.
 *
 * WHY A SEPARATE VERB. Every other credential is a single opaque string a user
 * can paste; this one is a multi-field JSON session that already exists on disk
 * after `codex login` / `codex login --device-auth`. `lazy auth set` would mean
 * "open ~/.codex/auth.json, strip its newlines, paste it at a masked prompt" —
 * a transcription step with nothing to gain and a silent truncation to lose
 * (piped stdin reads one line). Reading the file is the honest interface.
 *
 * The file is PARSED and re-serialized, never copied through: what lands in the
 * store is the token set lazy understands, so a file in the wrong mode (an API
 * key) or missing a refresh token is refused HERE, with the fix named, rather
 * than at the first turn hours later. Piped stdin is accepted too, for a session
 * arriving from somewhere other than a file on this machine.
 */
async function importView(root: string, nameArg: string | undefined, rest: string[]): Promise<void> {
  const typed = parseCredentialName(nameArg, 'import');
  const config = await tryLoadConfig(root);
  const target = await resolveTarget(root, config, typed);
  const name = target.credential;

  // A ChatGPT session in a slot that bills something else is stored, reported as
  // present, and then rejected upstream hours later with nothing saying why. The
  // name the user typed is the place to catch it — and to say which name they
  // wanted, in the vocabulary they arrived with.
  if (!credentialTakesChatGptSession(config, name)) {
    const subscription = profilesBilling(config, 'chatgpt');
    console.error(
      `lazy auth import stores a ChatGPT subscription session, and ` +
      (typed === name
        ? `the "${name}" credential holds ${credentialLabel(name)} credentials`
        : `the "${typed}" agent profile bills the "${name}" credential (${credentialLabel(name)})`) +
      ` — not a subscription.\n` +
      `Nothing was stored.\n` +
      (subscription.length > 0
        ? `  On a ChatGPT Plus/Pro plan, name the agent that bills it: ` +
          `lazy auth import ${subscription[0]}\n`
        : `  For a ChatGPT Plus/Pro plan: lazy auth import chatgpt\n`) +
      `  For an API key: lazy auth set ${name}`,
    );
    process.exit(1);
  }
  announceTarget(target);

  // A slot NOTHING bills is not an error — a user may be storing a session
  // before writing the profile that will reference it — but it is silent
  // uselessness otherwise, which is what `lazy auth import codex` already cost
  // one user: stored, reported, and read by nothing. Say so at the moment it can
  // still be redirected.
  if (config && profilesBilling(config, name).length === 0) {
    const subscription = profilesBilling(config, 'chatgpt');
    console.log(theme.warning(
      `Note: no agent in this project bills the "${name}" credential, so nothing will read this\n` +
      `session ${unreferencedCredentialAdvice(name)}` +
      (subscription.length > 0
        ? `\nFor the built-in subscription agent, import it as: lazy auth import ${subscription[0]}`
        : ''),
    ));
  }

  const explicitPath = rest.find(a => !a.startsWith('--'));

  let raw: string;
  let source: string;
  if (!explicitPath && !isTTY()) {
    raw = await new Response(process.stdin as unknown as ReadableStream).text();
    source = 'the piped input';
  } else {
    const path = explicitPath ?? codexAuthJsonPath(getHome());
    source = path;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      console.error(
        missing
          ? `No codex session at ${path}.\n` +
            `Log in on this machine first, then re-run this command:\n` +
            `  codex login                 # opens a browser\n` +
            `  codex login --device-auth   # headless: prints a code to enter elsewhere\n` +
            `If your session is somewhere else, pass the path: lazy auth import ${name} <path>`
          : `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  let tokens;
  try {
    tokens = parseChatGptTokens(raw, source);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\nNothing was stored.`);
    process.exit(1);
  }

  const secret = serializeChatGptTokens(tokens);
  const entry = await setCredential(root, { provider: name, kind: 'oauth', secret });
  console.log(theme.success(
    `Stored the ChatGPT subscription session from ${source}` +
    `${tokens.accountId ? ` (account ${tokens.accountId})` : ''}.`,
  ));
  console.log(theme.separator(`  ${BACKEND_DESCRIPTIONS[entry.backend]}`));

  // A write that resolved AWAY from the name typed can leave a stale item under
  // that name — an earlier lazy stored one there and failed before recording it,
  // so no command could name it afterwards. Clear it as part of the import that
  // supersedes it, rather than sending the user to `security` by hand.
  if (typed !== name && (await purgeOrphanCredential(root, typed))) {
    console.log(theme.separator(
      `  Cleared a leftover "${typed}" item in the ${entry.backend} store — an earlier failed import.`,
    ));
  }
  // The access token is short-lived and lazy renews it from the refresh token,
  // writing the rotated one back — say so, or the first expiry looks like a bug.
  console.log(theme.separator(
    '  lazy refreshes the access token for you and keeps the renewed session stored.',
  ));
  // NO RESTART LINE HERE, whatever the credential is CALLED. An imported session
  // is never hydrated into the daemon's environment — the proxy reads it from
  // the store on every request — so it takes effect on the next turn with no
  // restart. It used to be announced from the NAME (`chatgpt` self-refreshes,
  // `work-chatgpt` does not), so importing under any other name told the user to
  // restart the daemon, interrupting every running task to achieve nothing.
  for (const line of effectAdvice(name, true)) console.log(line);

  // Renewing a ChatGPT token RETIRES the one it renewed, and the codex CLI on
  // this machine still holds that retired copy in ~/.codex/auth.json. Say so at
  // the moment of import: the alternative is a user discovering hours later that
  // their own `codex` is logged out, re-running `codex login`, re-importing, and
  // going round again.
  console.log(theme.warning(
    `Note: lazy now owns this session. Renewing it invalidates the copy the codex CLI keeps on\n` +
    `this machine, so \`codex\` here may ask you to log in again — that is expected, and logging\n` +
    `in again does not disturb lazy.`,
  ));

  const env = envSourceFor(name);
  if (env) {
    console.log(theme.warning(
      `Note: ${env} is set in this environment and overrides the store. ` +
      `Unset it to use the stored credential.`,
    ));
  }
}

/**
 * `lazy auth refresh <name>` — renew a self-refreshing credential right now.
 *
 * WHY IT EXISTS. lazy renews a ChatGPT session automatically when the access
 * token is about to expire, which means the renewal round trip is first
 * exercised hours after setup, inside a turn, and a failure surfaces as a 401 on
 * a credential every surface still reports as present. That is the worst place
 * to discover a wrong request shape. This makes it a one-command check a user —
 * or a release — can run immediately after importing, against the real service,
 * and read the answer straight away.
 *
 * It is NOT a repair tool: a refresh RETIRES the token it used, so running this
 * needlessly costs a rotation. Offered only for credentials lazy actually
 * renews.
 */
async function refreshView(root: string, nameArg: string | undefined): Promise<void> {
  const typed = parseCredentialName(nameArg, 'refresh');
  const config = await tryLoadConfig(root);
  const target = await resolveTarget(root, config, typed);
  const name = target.credential;
  // A NAMED credential pointed at the ChatGPT backend is renewable too — the
  // proxy renews it per request — so the question is whether this slot holds a
  // session, not whether lazy happens to recognise the name.
  if (!credentialSelfRefreshing(name) && !credentialHoldsChatGptSession(config, name)) {
    console.error(
      `${credentialLabel(name)} is not a credential lazy renews — there is nothing to refresh.\n` +
      `Only a session with a refresh token is renewable; an API key is stored and used as-is.\n` +
      `To replace it: lazy ${credentialSetupCommand(name)}`,
    );
    process.exit(1);
  }
  announceTarget(target);

  const before = await credentialPresence(root, name);
  const env = envSourceFor(name);
  if (!before && !env) {
    console.error(
      `No ${credentialLabel(name)} credential is stored. Set one up first:\n` +
      `  lazy ${credentialSetupCommand(name)}`,
    );
    process.exit(1);
  }

  let session;
  try {
    session = await resolveChatGptSession(root, name, { force: true });
  } catch (err) {
    // The renewal round trip itself failed. Say so plainly and say what is still
    // true — the stored session is untouched on this path, so the user has not
    // lost anything by running the check.
    console.error(
      `Could not renew the ${credentialLabel(name)} session.\n` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      `The stored credential was not changed.`,
    );
    process.exit(1);
  }
  if (!session) {
    console.error(`No ${credentialLabel(name)} credential is available to refresh.`);
    process.exit(1);
  }

  console.log(theme.success(`Renewed the ${credentialLabel(name)} session.`));
  if (session.tokens.accountId) {
    console.log(theme.separator(`  account ${session.tokens.accountId}`));
  }
  const expiry = accessTokenExpiry(session.tokens.accessToken);
  console.log(theme.separator(
    expiry
      ? `  the new access token expires ${new Date(expiry).toISOString()}`
      : '  the new access token carries no expiry claim',
  ));
  if (session.source === 'env') {
    console.log(theme.warning(
      `Renewed from ${envVarFor(name, 'oauth')}, which lazy cannot write back — this renewal lives\n` +
      `only as long as this process, and the value in that variable is now retired. Store the\n` +
      `session instead: lazy ${credentialSetupCommand(name)}`,
    ));
  }
}

async function removeView(root: string, providerArg: string | undefined): Promise<void> {
  const provider = announceTarget(
    await resolveTarget(root, await tryLoadConfig(root), parseCredentialName(providerArg, 'rm')),
  );
  const removed = await deleteCredential(root, provider);
  console.log(removed
    ? theme.success(`Removed the stored ${credentialLabel(provider)} credential.`)
    : `No stored ${credentialLabel(provider)} credential.`);
  const env = envSourceFor(provider);
  if (env) {
    console.log(theme.separator(`  ${env} is still set in this environment.`));
  }
}

export async function commandAuth(args: string[]): Promise<void> {
  const root = requireLazyRoot();
  const sub = args[0];

  switch (sub) {
    case undefined:
    case 'list':
      await listView(root);
      break;
    case 'set':
      await setView(root, args[1], args.slice(2));
      break;
    case 'import':
      await importView(root, args[1], args.slice(2));
      break;
    case 'refresh':
      await refreshView(root, args[1]);
      break;
    case 'rm':
    case 'remove':
      await removeView(root, args[1]);
      break;
    default:
      console.error(`Unknown subcommand: auth ${sub}`);
      authUsage();
      process.exit(1);
  }
}

export function authUsage(): void {
  console.log(`Usage: lazy auth [list|set <name>|import <name> [path]|refresh <name>|rm <name>]

Store this project's model credentials in OS secure storage, so the daemon no
longer depends on the shell it was started from.

Subcommands:
  list (default)     Which credential is in effect for each name, where it came
                     from (environment or store), and which ones this project
                     actually uses.
  set <name>         Store a credential. Read from an interactive masked prompt
                     or piped stdin — never from an argument, which would land
                     in shell history and in \`ps\`. Add --kind <kind> to choose
                     between an OAuth token and an API key.
  import <name> [path]
                     Store a ChatGPT subscription session from the file
                     \`codex login\` wrote (default ~/.codex/auth.json), or from
                     piped stdin. The file is validated and re-serialized, so a
                     wrong or incomplete one is refused here rather than at the
                     first turn.
  refresh <name>     Renew a session lazy keeps alive (today: chatgpt) right now,
                     against the real service, instead of waiting for the token
                     to age out mid-turn. A renewal RETIRES the token it used, so
                     do not run it idly.
  rm <name>          Remove the stored credential (the environment is untouched).

Providers: ${PROVIDERS.join(', ')}

A name can also be one you pick — \`lazy auth set work-openai\` — and reference
from a profile: [agents.work-codex] credential = "work-openai". That is how two
profiles on the same provider get billed to different keys; profiles that name
no credential share the provider's one.

Or name the AGENT PROFILE you are setting up and lazy stores the credential that
profile bills, saying which one it used: \`lazy auth import codex-subscription\`
stores the \`chatgpt\` session, \`lazy auth set codex-api\` stores the \`openai\`
key. The vocabularies differ because a ChatGPT subscription is a service any
harness can be pointed at, not a property of codex.

Storage backend: macOS Keychain, or libsecret / Secret Service on Linux. On a
host with neither, lazy falls back to a mode-0600 file in the daemon state
directory, outside the repository — \`lazy auth list\` always names the backend
actually in use. Choose explicitly with [credentials] backend in lazy.toml.

The environment always wins: an exported CLAUDE_CODE_OAUTH_TOKEN or
ANTHROPIC_API_KEY overrides the store, so existing setups keep working unchanged.

Examples:
  lazy auth                                    # what is in effect
  lazy auth set anthropic                      # masked prompt
  claude setup-token | lazy auth set anthropic # piped stdin
  lazy auth set anthropic --kind api-key
  lazy auth import chatgpt                     # from ~/.codex/auth.json after \`codex login\`
  lazy auth import codex-subscription          # same thing, named by agent profile
  lazy auth refresh chatgpt                    # prove the renewal works now
  lazy auth rm anthropic

Human/CLI-only — agents must never write credentials, so there is no MCP tool.`);
}
