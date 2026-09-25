/**
 * Named agent profiles — `[agents.<name>]` in lazy.toml.
 *
 * A profile is the whole answer to "how does this task's agent run": which
 * HARNESS binary drives it, which MODEL it asks for, which upstream ENDPOINT
 * lazy's proxy forwards that traffic to, and which stored CREDENTIAL pays for
 * it. A task names one profile (`--agent <name>`), and everything downstream —
 * the launch grant, the proxy's route, the harness config written for the turn —
 * reads it from there.
 *
 * WHAT THIS REPLACES, and why the replacement was necessary:
 *
 *  - `[models.roles.agent] backend/model/endpoint` decided the upstream for
 *    every task in the ROLE. There is exactly one agent role, so "run pi against
 *    a local Ollama" also sent every claude-code task to that Ollama. A per-task
 *    choice could not be expressed at all.
 *  - codex reached OpenAI through a special case in the proxy: a grant whose
 *    envKey happened to be `OPENAI_API_KEY` was routed to `[proxy]
 *    openai_upstream`. The routing key was an ENV VAR NAME, so two codex
 *    profiles could never differ, and the upstream was global.
 *
 * Both are gone. Routing is per profile, and the profile name travels on the
 * broker-minted grant, so the proxy learns it as evidence rather than as a
 * client claim.
 *
 * WIRE FORMAT IS DERIVED, NEVER CONFIGURED. `wire` says which protocol the
 * traffic speaks, and it follows from the harness (claude-code and cursor speak
 * Anthropic Messages; codex speaks OpenAI; pi speaks both) with the endpoint
 * only able to NARROW it — pick among the wires the harness speaks, when its
 * host is known to speak some — or CONTRADICT it, never to add one. That
 * matters beyond tidiness: the wire picks the proxy's path-allowlist tier and
 * which usage extractor may read a body, so a user-settable wire would be a
 * user-settable security boundary.
 *
 * There is deliberately no `api_shape` key here. Bedrock-style shapes are a
 * later proxy feature; the design leaves the slot, and until the proxy can
 * actually speak such a shape, accepting the key would only let a config
 * promise something no code delivers.
 */

import {
  CHATGPT_CODEX_UPSTREAM,
  DEFAULT_OPENAI_UPSTREAM,
  isChatGptEndpoint,
  isOpenRouterEndpoint,
} from '../utils/openai-compat';
import {
  isHostedOllamaEndpoint,
  DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  DEFAULT_LOCAL_OLLAMA_MODEL,
} from '../utils/ollama';
import { isLocalEndpoint, endpointForHost } from '../utils/endpoint';
import { isKnownAnthropicModel } from '../utils/anthropic-models';
import { isInternalAgent } from '../agent/registry';
import { defineProfileAdvice, keepProfileOnEndpointAdvice } from './agent-profile-advice';

/**
 * Protocol spoken to the upstream. Not a config key — see the file header.
 */
export type AgentWire = 'anthropic' | 'openai';

/** A `[agents.<name>]` block exactly as written in lazy.toml. */
export interface AgentProfileConfig {
  harness?: string;
  model?: string;
  endpoint?: string;
  credential?: string;
}

/** A profile after defaults, inference and validation. */
export interface AgentProfile {
  /** Profile name — the value of `--agent`, and what the launch grant carries. */
  name: string;
  /** Registered agent implementation that drives the turn. */
  harness: string;
  /** Model to request. '' means "the harness's own default". */
  model: string;
  /**
   * Upstream lazy's PROXY forwards this profile's traffic to, from the HOST's
   * perspective. '' means the proxy's primary upstream. Never an address the
   * agent dials: the agent always talks to the proxy.
   */
  endpoint: string;
  /**
   * True when the profile's OWN block named the endpoint, false when it came
   * from {@link HARNESS_DEFAULT_ENDPOINT}.
   *
   * Not the same question as `endpoint !== ''`, and the difference is
   * load-bearing: built-in `codex` carries a default endpoint with no model, so
   * "has an endpoint" cannot mean "the user pinned a service whose model names
   * are its own". A PINNED endpoint is what makes the profile's model
   * authoritative (validation above requires one) and what tells a launch it is
   * talking to something other than the harness's native API.
   */
  endpointPinned: boolean;
  /**
   * Stored credential that pays for this upstream — a provider name, a
   * user-chosen name (`lazy auth set work-openai`), or {@link NO_CREDENTIAL}
   * when the upstream takes none. {@link profileCredentialName} drops the last.
   */
  credential: string;
  /** Derived from harness + endpoint. */
  wire: AgentWire;
  /** True when no `[agents.<name>]` block declares it — a built-in. */
  builtin: boolean;
}

/** Credential name meaning "this upstream authenticates nobody". */
export const NO_CREDENTIAL = 'none';

/** Profile used when a task and the project both name none. */
export const DEFAULT_AGENT_PROFILE_NAME = 'claude-code';

/**
 * Profile the builder runs on.
 *
 * The builder is Claude Code and only Claude Code — it is lazy's own
 * conversational surface, not a per-task agent choice — so its profile is fixed
 * rather than read from a task record. Named separately from
 * {@link DEFAULT_AGENT_PROFILE_NAME} because the two coinciding is a fact about
 * today's builder, not a rule: pointing the builder at its own profile later
 * changes this constant and nothing else.
 */
export const BUILDER_PROFILE_NAME = 'claude-code';

/**
 * Wire formats each harness can speak, most-preferred first.
 *
 * VERIFIED, not assumed — each entry is what the harness's own config writer
 * emits today:
 *  - claude-code: `ANTHROPIC_BASE_URL` + Anthropic Messages.
 *  - cursor: the proxy's cursor passthrough route, Anthropic-wire.
 *  - codex: `~/.codex/config.toml` writes `wire_api = "responses"` under an
 *    OpenAI-shaped `base_url` (src/agent/codex-config.ts).
 *  - pi: `models.json` writes `api: "anthropic-messages"` for its anthropic-wire
 *    providers and `api: "openai-completions"` for its OpenAI-wire one
 *    (src/agent/pi-turn-config.ts). Both spellings are verified against pi
 *    0.84.4 end-to-end — the second one is why pi is no longer Anthropic-only
 *    here (see docs/pi-agent-integration.md). Anthropic stays FIRST: a pi
 *    profile whose endpoint implies no wire (a local Ollama, a self-hosted
 *    gateway) keeps resolving exactly as it did before pi gained a second wire.
 *    A host that speaks both wires (OpenRouter) is the one case where the
 *    ENDPOINT's own preference wins over this order — see `wireForProfile`.
 *
 * The value is a LIST so that a harness gaining a second wire is a one-element
 * change here rather than a restructuring.
 *
 * The table is TOTAL over the agent registry (src/agent/registry.ts): every
 * registered agent appears, so every agent a task can name has a built-in
 * profile. `qa-agent` is here for that reason alone — it is the LLM-free test
 * harness, it reaches no upstream at all, and with no endpoint the proxy never
 * builds a route for it, so its wire is never consulted. Omitting it would make
 * `--agent qa-agent` an unknown profile and break the e2e harness.
 */
export const HARNESS_WIRES: Record<string, readonly AgentWire[]> = {
  'claude-code': ['anthropic'],
  cursor: ['anthropic'],
  codex: ['openai'],
  pi: ['anthropic', 'openai'],
  'qa-agent': ['anthropic'],
};

/**
 * Upstream a harness uses when its profile names no endpoint.
 *
 * '' means the proxy's primary upstream, which is Anthropic-wire — so a harness
 * that should NOT inherit it must name a concrete default instead. codex's entry
 * is what replaces the removed `[proxy] openai_upstream`.
 *
 * pi's entry is a LOCAL OLLAMA, and that is a product decision (engineer,
 * 2026-09-13): pi is the local-model agent, so out of the box it must run on the
 * machine's own Ollama rather than spend an Anthropic credential. Anthropic
 * stays one profile away —
 * `[agents.anthropic-pi] harness = "pi", endpoint = "https://api.anthropic.com"`
 * — it is simply no longer what a project gets by accident.
 *
 * Host-perspective, like every endpoint: the PROXY dials it and the proxy runs
 * on the host, so `localhost` is right and a container alias would be rewritten
 * (`endpointForHost`). A daemon that is not on the Ollama host overrides this
 * with an `[agents.pi]` block naming the real address.
 */
export const HARNESS_DEFAULT_ENDPOINT: Record<string, string> = {
  'claude-code': '',
  cursor: '',
  pi: DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  codex: DEFAULT_OPENAI_UPSTREAM,
  // qa-agent calls no model; '' keeps it out of the proxy's route table.
  'qa-agent': '',
};

/**
 * Model a harness runs when its profile names none — the other half of
 * {@link HARNESS_DEFAULT_ENDPOINT}, and only ever applied together with it.
 *
 * A model name means nothing without the service that serves it, so this is
 * consulted ONLY for a profile that took the default endpoint. A profile that
 * pins its own `endpoint` still has to name its own `model` and is refused
 * without one — filling in this default there would send an Ollama model name to
 * whatever server the user actually chose.
 *
 * Verified present on the engineer's machine (Ollama 0.32.14) at the time this
 * default was set, along with that server answering the Anthropic wire pi speaks
 * — `/v1/messages`, streaming, `tool_use`. A machine without this model gets an
 * actionable failure from Ollama naming it, which is the honest outcome: lazy
 * cannot pull models and must not guess a different one.
 */
export const HARNESS_DEFAULT_MODEL: Record<string, string> = {
  pi: DEFAULT_LOCAL_OLLAMA_MODEL,
};

/** A profile lazy defines itself, as if an `[agents.<name>]` block had written it. */
interface BuiltinProfileSpec {
  /** Registered agent that drives the turn. */
  harness: string;
  /**
   * Upstream, when this profile means something narrower than its harness's
   * default. Behaves exactly like {@link HARNESS_DEFAULT_ENDPOINT}: it is lazy's
   * default rather than a user pin, so it does not make the profile's model
   * mandatory the way writing `endpoint` in your own block does.
   */
  endpoint?: string;
}

/**
 * Every profile a project gets without writing any `[agents]` block.
 *
 * ONE PER HARNESS WAS THE OLD RULE, and it is why this table exists separately
 * from {@link HARNESS_WIRES} now. A harness is a BINARY; a profile is a binary
 * plus the parameters that decide who pays for the turn and where it goes. Codex
 * is the case that separates them: the same `codex` binary bills a metered
 * OpenAI API key at api.openai.com, or a ChatGPT Plus/Pro subscription at
 * chatgpt.com/backend-api/codex. Those are two different accounts at two
 * different services, so they are two profiles — not two harnesses, and not a
 * thing a user should have to hand-write a config block to reach.
 *
 * `codex-api` and `codex-subscription` say in their names what they bill. Their
 * credential is not listed: `defaultCredentialFor` derives it from the endpoint's
 * hostname, so the endpoint stays the single statement of intent and the two
 * cannot drift apart.
 *
 * `codex` REMAINS, and is the same profile as `codex-api`. Tasks store their
 * profile name on the record and projects name one in `[agent] agent_id`, so
 * removing it would break every existing codex task and every config that names
 * it. It is the older spelling of "codex on an API key", kept working.
 */
export const BUILTIN_PROFILES: Record<string, BuiltinProfileSpec> = {
  'claude-code': { harness: 'claude-code' },
  cursor: { harness: 'cursor' },
  codex: { harness: 'codex' },
  'codex-api': { harness: 'codex', endpoint: DEFAULT_OPENAI_UPSTREAM },
  'codex-subscription': { harness: 'codex', endpoint: CHATGPT_CODEX_UPSTREAM },
  pi: { harness: 'pi' },
  'qa-agent': { harness: 'qa-agent' },
};

/** Profiles that exist without an `[agents.<name>]` block declaring them. */
export const BUILTIN_PROFILE_NAMES: readonly string[] = Object.keys(BUILTIN_PROFILES);

/**
 * Profile and credential names share one shape: lowercase, starts
 * alphanumeric, and otherwise `. _ -`. Narrow on purpose — a profile name is
 * typed on a command line, stored on a task record, and used as a credential
 * account name in the OS keychain, so anything with whitespace, slashes or
 * shell metacharacters would be a problem in at least one of those places.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const NAME_MAX = 64;

const PROFILE_KEYS = ['harness', 'model', 'endpoint', 'credential'] as const;

/** Per-key guidance for the keys people are most likely to reach for. */
const UNKNOWN_KEY_HINTS: Record<string, string> = {
  api_shape:
    'wire format is derived from harness + endpoint, and alternative API shapes (bedrock, vertex) are not implemented yet',
  wire: 'wire format is derived from harness + endpoint, never configured — it selects the proxy\'s allowlist tier',
  backend: 'use `harness` (which agent runs) and `endpoint` (which upstream the proxy forwards to)',
  provider: 'use `credential` to name a stored credential, and `endpoint` for the upstream',
  api_key: 'credentials are never written to lazy.toml — store one with `lazy auth set <name>` and reference it as `credential`',
  base_url: 'use `endpoint`',
};

function nameError(what: string, name: string, where: string): Error {
  return new Error(
    `Invalid ${what} "${name}" in lazy.toml ${where}. ` +
    `Use lowercase letters, digits, and . _ - (starting with a letter or digit), up to ${NAME_MAX} characters.`,
  );
}

/**
 * Exported so `lazy auth`'s deliberately-duplicated copy of this rule can be
 * held to it (test/unit/credential-store.test.ts) — that command must stay
 * usable in a project whose lazy.toml will not load, so it cannot import the
 * rule at runtime, but the two must still accept and reject the same names.
 */
export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX && NAME_RE.test(name);
}

/** Lower-cased hostname of an endpoint URL, or null when it is blank or unparseable. */
function hostnameOf(endpoint: string): string | null {
  if (!endpoint.trim()) return null;
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Wires an endpoint's HOST is known to speak, most native first — or an empty
 * list when the host says nothing about the wire.
 *
 * Only hosted services lazy knows by hostname qualify, the same hostname rule
 * that picks the credential (`defaultCredentialFor` below). The two
 * first-party API hosts speak exactly one wire each. OpenRouter speaks BOTH
 * from one hostname (see src/utils/openai-compat.ts): its native API is
 * OpenAI-compatible Chat Completions, and it also serves an Anthropic Messages
 * endpoint — so it lists both, native first, and the HARNESS decides which it
 * takes ({@link wireForProfile}). A self-hosted gateway, a local model server,
 * or a hostname lazy has never heard of implies nothing; there the harness's
 * own preference decides. That is why the check in `wireForProfile` can only
 * ever reject a contradiction on a KNOWN host — it never invents a wire for an
 * unknown one.
 */
export function knownEndpointWires(endpoint: string): readonly AgentWire[] {
  const host = hostnameOf(endpoint);
  if (host === null) return [];
  if (host === 'api.openai.com') return ['openai'];
  if (host === 'api.anthropic.com') return ['anthropic'];
  if (isOpenRouterEndpoint(endpoint)) return ['openai', 'anthropic'];
  return [];
}

/**
 * True when the endpoint is Anthropic's own API host.
 *
 * The question two callers ask about an Anthropic-WIRE endpoint: is the server
 * on the far side Anthropic itself, or something merely speaking its protocol
 * (a local Ollama, OpenRouter's Messages endpoint, a gateway)? pi's built-in
 * `anthropic` provider — Anthropic's own catalog — is right only for the
 * former; claude-code's local-stability flags are wanted only for the latter.
 */
export function isAnthropicApiEndpoint(endpoint: string): boolean {
  return hostnameOf(endpoint) === 'api.anthropic.com';
}

/**
 * Credential a profile uses when it names none.
 *
 * This is the hostname rule that used to live in `credentialFor`
 * (the retired src/proxy/role-upstreams.ts), with one deliberate change: an endpoint on
 * this machine or its private network now defaults to {@link NO_CREDENTIAL}
 * instead of the wire's hosted credential. A local model server ignores auth,
 * so the old behaviour handed a real Anthropic or OpenAI key to a process that
 * had no use for it. A user who genuinely wants a key sent to a private host
 * writes `credential = "anthropic"` and gets it.
 */
export function defaultCredentialFor(harness: string, wire: AgentWire, endpoint: string): string {
  // cursor authenticates with its own key regardless of upstream — the proxy's
  // cursor route places it in-path, not as a bearer header.
  if (harness === 'cursor') return 'cursor';
  const wireCredential = wire === 'openai' ? 'openai' : 'anthropic';
  if (!endpoint.trim()) return wireCredential;
  if (isHostedOllamaEndpoint(endpoint)) return 'ollama';
  // The ChatGPT subscription backend bills a plan, not an API key — so a profile
  // pointed there must NOT default to `openai`, which would spend a metered key
  // (or, far more often, report a missing one while the subscription sits
  // unused). See src/credentials/providers.ts on why this is its own provider.
  if (isChatGptEndpoint(endpoint)) return 'chatgpt';
  if (isOpenRouterEndpoint(endpoint)) return 'openrouter';
  if (isLocalEndpoint(endpoint)) return NO_CREDENTIAL;
  return wireCredential;
}

/**
 * The profile a launch runs, given whatever agent the task named.
 *
 * A task's `agent_id` IS its profile name: built-in profiles are named after
 * the harnesses (`claude-code`, `codex`, `cursor`, `pi`), so a task that
 * predates profiles already names a valid one, and `--agent <profile>` writes
 * user-defined names to the same field. Empty falls back to the default
 * profile, matching how a task with no agent already resolves.
 */
export function profileNameForAgent(agentId: string | null | undefined): string {
  return agentId?.trim() || DEFAULT_AGENT_PROFILE_NAME;
}

/**
 * The stored credential a profile bills, or null when it bills none.
 *
 * A name, not a provider: `credential = "work-openai"` is a store key like any
 * other, and only the daemon credential gate needs to know which names it
 * recognises (see `providerForTarget` in src/credentials/providers.ts).
 */
export function profileCredentialName(profile: AgentProfile): string | null {
  return profile.credential === NO_CREDENTIAL ? null : profile.credential;
}

/**
 * Wire for a harness + endpoint pair, or an error describing the contradiction.
 *
 * The harness chooses; the endpoint may only narrow or veto. When the
 * endpoint's host is known to speak some wires, the profile takes the most
 * native of those the harness can speak — so pi at OpenRouter runs
 * OpenRouter's native OpenAI wire while claude-code at OpenRouter runs its
 * Anthropic Messages endpoint, and pi at api.openai.com is the OpenAI wire. A
 * harness that speaks none of the host's wires is a contradiction, reported
 * rather than guessed around. An endpoint whose host implies nothing (a local
 * model server, a self-hosted gateway) gets the harness's first, preferred
 * wire — for pi that is Anthropic, which is the one remaining limit: a pi
 * profile on an unknown OpenAI-only gateway is not expressible until profiles
 * grow an explicit wire (docs/pi-agent-integration.md).
 */
export function wireForProfile(
  harness: string,
  endpoint: string,
): { wire: AgentWire } | { error: string } {
  const supported = HARNESS_WIRES[harness];
  if (!supported || supported.length === 0) {
    return { error: `harness "${harness}" has no known wire format` };
  }
  const spoken = knownEndpointWires(endpoint);
  if (spoken.length === 0) return { wire: supported[0]! };
  const wire = spoken.find((w) => supported.includes(w));
  if (wire === undefined) {
    return {
      error:
        `endpoint "${endpoint}" speaks the ${spoken.join(' or ')} API, but the "${harness}" harness speaks ` +
        `${supported.join(' or ')}. Point this profile at a ${supported.join('/')}-compatible ` +
        `endpoint, or set harness to one that speaks ${spoken.join('/')} ` +
        `(${harnessesSpeaking(spoken).join(', ') || 'none available'}).`,
    };
  }
  return { wire };
}

function harnessesSpeaking(wires: readonly AgentWire[]): string[] {
  return Object.entries(HARNESS_WIRES)
    .filter(([, supported]) => wires.some((w) => supported.includes(w)))
    .map(([harness]) => harness);
}

function knownHarnessesHint(): string {
  return Object.keys(HARNESS_WIRES).sort().join(', ');
}

/**
 * Resolve one `[agents.<name>]` block (or a built-in, when `raw` is undefined).
 *
 * `warn` receives non-fatal notes — today only the host-perspective endpoint
 * rewrite, which mirrors the one role targets already emit.
 */
function resolveProfile(
  name: string,
  raw: AgentProfileConfig | undefined,
  warn: (message: string) => void,
): AgentProfile {
  const where = `[agents.${name}]`;

  if (!isValidName(name)) throw nameError('agent profile name', name, `[agents.${name}]`);

  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        `lazy.toml ${where} must be a table of settings, e.g.\n\n` +
        `  [agents.${name}]\n  harness = "claude-code"\n  model = "claude-opus-5"`,
      );
    }
    for (const key of Object.keys(raw)) {
      if ((PROFILE_KEYS as readonly string[]).includes(key)) continue;
      const hint = UNKNOWN_KEY_HINTS[key];
      throw new Error(
        `Unknown option "${key}" in lazy.toml ${where}. ` +
        `Valid options: ${PROFILE_KEYS.join(', ')}.` +
        (hint ? ` (${hint})` : ''),
      );
    }
  }

  // `harness` defaults to the profile name when the name IS a harness — that is
  // what makes `[agents.codex]` mean "override the built-in codex profile"
  // rather than "a profile that forgot to say what runs it".
  // A built-in of this NAME supplies what the block leaves out — which is how
  // `[agents.codex-subscription] model = "…"` stays on the subscription backend
  // instead of silently falling back to the harness default (api.openai.com) and
  // billing a different account than its name promises.
  const builtin = BUILTIN_PROFILES[name];
  const harness = (raw?.harness ?? builtin?.harness ?? (HARNESS_WIRES[name] ? name : '')).trim();
  if (!harness) {
    throw new Error(
      `lazy.toml ${where} does not set harness, and "${name}" is not the name of an agent. ` +
      `Add harness = "<agent>" (one of: ${knownHarnessesHint()}).`,
    );
  }
  if (!HARNESS_WIRES[harness]) {
    throw new Error(
      `Unknown harness "${harness}" in lazy.toml ${where}. ` +
      `Valid harnesses: ${knownHarnessesHint()}.`,
    );
  }

  const endpointSet = typeof raw?.endpoint === 'string' && raw.endpoint.trim().length > 0;
  // The built-in's own endpoint wins over the harness default, but ONLY while the
  // block still runs that harness: `[agents.codex-subscription] harness = "pi"`
  // has repurposed the name, and forcing the ChatGPT backend on it would be lazy
  // overriding an explicit choice.
  const defaultEndpoint =
    (builtin?.harness === harness ? builtin.endpoint : undefined) ??
    HARNESS_DEFAULT_ENDPOINT[harness] ??
    '';
  let endpoint = endpointSet ? raw!.endpoint!.trim() : defaultEndpoint;
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(
        `Invalid endpoint "${endpoint}" in lazy.toml ${where}. ` +
        `Expected an absolute URL, e.g. endpoint = "http://localhost:11434".`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Invalid endpoint "${endpoint}" in lazy.toml ${where}: expected an http:// or https:// URL.`,
      );
    }
    endpoint = endpoint.replace(/\/$/, '');
    // Same rewrite role targets get: an endpoint is the upstream the PROXY
    // forwards to, and the proxy runs on the host, so a container-perspective
    // alias names the wrong thing.
    const hostSide = endpointForHost(endpoint);
    if (hostSide !== endpoint) {
      warn(
        `lazy.toml ${where} endpoint = "${endpoint}" — this is the upstream lazy's proxy forwards ` +
        `to, and the proxy runs on the host, not in the agent's container. Reading it as ` +
        `"${hostSide}". Update lazy.toml to the host-side address to silence this warning.`,
      );
      endpoint = hostSide;
    }
  }

  const wireResult = wireForProfile(harness, endpoint);
  if ('error' in wireResult) {
    throw new Error(`lazy.toml ${where}: ${wireResult.error}`);
  }
  const wire = wireResult.wire;

  const declaredModel = (raw?.model ?? '').trim();
  // A pinned endpoint is a pinned SERVICE, and its model names are its own —
  // "opus" does not exist on an Ollama box. Guessing one would send a request
  // that fails deep inside the harness, so require it, exactly as an
  // endpoint-bearing role target already did.
  if (endpointSet && !declaredModel) {
    throw new Error(
      `lazy.toml ${where} sets endpoint but no model. ` +
      `Model names are specific to the endpoint, so lazy will not guess one — ` +
      `set model (e.g. model = "${DEFAULT_LOCAL_OLLAMA_MODEL}").`,
    );
  }
  // The harness default model applies ONLY to a profile that also took the
  // harness default endpoint. The two are one pair: a model name means nothing
  // without the service serving it, so filling this in for a user-pinned
  // endpoint would send pi's default Ollama model to whatever server they chose
  // — and would silently defeat the refusal directly above.
  const model = declaredModel || (endpointSet ? '' : HARNESS_DEFAULT_MODEL[harness] ?? '');

  // A profile that named a MODEL but no ENDPOINT takes the harness default —
  // and for pi that default moved from "the primary Anthropic upstream" to a
  // local Ollama (2026-09-13). A block written the documented way for Anthropic
  // before that, e.g.
  //
  //   [agents.my-pi]  harness = "pi"  model = "claude-opus-5"
  //
  // keeps its name and its model and quietly changes which service it talks to,
  // which is exactly the silent upstream substitution the rest of this codebase
  // refuses. It cannot be a hard error — the engineer asked for this default,
  // and a project whose declared profile is genuinely fine must still load — so
  // it warns where the user can still read the file, next to the endpoint
  // rewrite warning above.
  //
  // Only when BOTH halves say so: the profile is the user's own (a built-in
  // warning about itself would fire for every project), it took the default
  // endpoint rather than pinning one, that default is not Anthropic, and the
  // model it declares is a recognizably Anthropic name.
  if (
    raw !== undefined &&
    !endpointSet &&
    endpoint &&
    !isAnthropicApiEndpoint(endpoint) &&
    declaredModel &&
    isKnownAnthropicModel(declaredModel)
  ) {
    warn(
      `lazy.toml ${where} sets model = "${declaredModel}" — an Anthropic model — but no endpoint, ` +
      `so it takes the "${harness}" harness default upstream, which is ${endpoint}. ` +
      `That server does not serve Anthropic models, and the turn will fail with a 404. ` +
      keepProfileOnEndpointAdvice('https://api.anthropic.com', endpoint),
    );
  }

  const credential = (raw?.credential ?? '').trim() || defaultCredentialFor(harness, wire, endpoint);
  if (!isValidName(credential)) throw nameError('credential name', credential, where);
  // A credential name is a STORE KEY, and the store takes any name — a provider
  // (`anthropic`) or one the user picked (`work-openai`), which is how two
  // profiles on the same provider get billed to different keys. Presence is NOT
  // checked here: the store is per-machine and lazy.toml is committed, so
  // refusing a config because this checkout has not run `lazy auth set` yet
  // would make the file unusable on a second machine. A missing one fails at
  // launch and at the proxy, both naming the profile and the name to store.
  //
  // Cursor is the one refusal. Its auth wire format is not something lazy has a
  // contract for, so the proxy places a Cursor key exactly where the client put
  // its placeholder (`resolveCursor` in src/proxy/credential-deps.ts) rather
  // than in a header lazy chose. A name outside the provider vocabulary has no
  // such client-shaped placeholder to substitute, so it would be sent somewhere
  // guessed — refuse where the user can still read the file.
  if (harness === 'cursor' && credential !== NO_CREDENTIAL && credential !== 'cursor') {
    throw new Error(
      `lazy.toml ${where}: credential = "${credential}" is not supported for the cursor harness. ` +
      `cursor-agent's authentication wire format is not one lazy can place a credential into ` +
      `itself, so it uses the stored "cursor" credential (\`lazy auth set cursor\`) or ` +
      `"${NO_CREDENTIAL}".`,
    );
  }

  return {
    name,
    harness,
    model,
    endpoint,
    endpointPinned: endpointSet,
    credential,
    wire,
    builtin: raw === undefined,
  };
}

/**
 * Resolve every profile a project has: the built-ins, plus any `[agents.<name>]`
 * block, with a block of a built-in's name REPLACING that built-in.
 *
 * A project with no `[agents]` section gets exactly the built-ins, which are the
 * defaults each harness already used — so adding this section to lazy's config
 * changes nothing for a config that does not mention it.
 */
export function resolveAgentProfiles(
  raw: Record<string, AgentProfileConfig> | undefined,
  warn: (message: string) => void = (m) => console.warn(`Warning: ${m}`),
): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  for (const name of BUILTIN_PROFILE_NAMES) {
    profiles.set(name, resolveProfile(name, undefined, warn));
  }
  for (const [name, block] of Object.entries(raw ?? {})) {
    profiles.set(name, resolveProfile(name, block ?? {}, warn));
  }
  return profiles;
}

/**
 * Resolved profiles for a config, computed once per `[agents]` table.
 *
 * Keyed on the raw table's identity so that resolution — and in particular the
 * endpoint rewrite WARNING inside it — happens exactly once per loaded config
 * rather than once per launch. The loader seeds this on the way through, so a
 * bad block still fails at load; nothing here is a lazy first-use path.
 */
const RESOLVED_CACHE = new WeakMap<object, Map<string, AgentProfile>>();

/** Profiles for a loaded config. Cached; never warns twice for one config. */
export function agentProfilesFor(config: { agents?: Record<string, AgentProfileConfig> }): Map<string, AgentProfile> {
  const raw = config.agents;
  if (!raw) return resolveAgentProfiles(undefined, () => {});
  const cached = RESOLVED_CACHE.get(raw);
  if (cached) return cached;
  const resolved = resolveAgentProfiles(raw);
  RESOLVED_CACHE.set(raw, resolved);
  return resolved;
}

/** Record an already-resolved table so {@link agentProfilesFor} reuses it. */
export function cacheAgentProfiles(
  raw: Record<string, AgentProfileConfig>,
  profiles: Map<string, AgentProfile>,
): void {
  RESOLVED_CACHE.set(raw, profiles);
}

/** Every profile name, including internal ones, sorted for stable output. */
export function agentProfileNames(profiles: Map<string, AgentProfile>): string[] {
  return [...profiles.keys()].sort();
}

/**
 * Profile names to OFFER a user, sorted.
 *
 * Selection accepts more than this list advertises, exactly as
 * `listSelectableAgents` / `listAgents` already differ: the built-in profile of
 * an internal harness (`qa-agent`) is real and selectable — the e2e harness
 * names it — but it is lazy's own test agent and has no business in a hint a
 * human reads. Only the BUILT-IN profile is hidden: if a project writes
 * `[agents.my-qa]` on that harness it meant to have it, and hiding a block
 * someone wrote in their own lazy.toml would be the surprising behaviour.
 */
export function selectableAgentProfileNames(profiles: Map<string, AgentProfile>): string[] {
  return selectableProfiles(profiles).map(p => p.name).sort();
}

function selectableProfiles(profiles: Map<string, AgentProfile>): AgentProfile[] {
  return [...profiles.values()].filter(p => !(p.builtin && isInternalAgent(p.harness)));
}

/**
 * Profiles to OFFER a user, the project's OWN `[agents.<name>]` blocks first.
 *
 * Same set as {@link selectableAgentProfileNames}, ordered for a PICKER rather
 * than for a hint: a human choosing an agent is choosing a configured combo,
 * and the built-ins are the fallback beneath it. Alphabetical within each
 * group, so the order is stable across renders.
 */
export function selectableAgentProfiles(profiles: Map<string, AgentProfile>): AgentProfile[] {
  const byName = (a: AgentProfile, b: AgentProfile) => a.name.localeCompare(b.name);
  const all = selectableProfiles(profiles);
  return [
    ...all.filter(p => !p.builtin).sort(byName),
    ...all.filter(p => p.builtin).sort(byName),
  ];
}

/**
 * One-line "what does this profile actually run" summary, for a picker option
 * or any other place too narrow for the full `lazy system agent` view.
 *
 * Harness always, because it is the one thing a profile name may not reveal;
 * model and endpoint only when the profile pins them, so a built-in reads as
 * the plain harness default rather than as a row of empty fields.
 */
export function agentProfileSummary(profile: AgentProfile): string {
  const parts = [profile.harness];
  parts.push(profile.model || `${profile.harness} default model`);
  if (profile.endpoint) parts.push(profile.endpoint);
  if (profile.credential && profile.credential !== NO_CREDENTIAL) parts.push(`key: ${profile.credential}`);
  return parts.join(' · ');
}

/**
 * Look a profile up by name, or throw an error that names the alternatives.
 * Every selection surface (`--agent`, the task record, `[agent] agent_id`)
 * resolves through here so an unknown name fails the same way everywhere.
 */
export function agentProfileOrThrow(
  profiles: Map<string, AgentProfile>,
  name: string,
  where = '',
): AgentProfile {
  const profile = profiles.get(name);
  if (profile) return profile;
  throw new Error(
    `Unknown agent profile "${name}"${where ? ` in ${where}` : ''}. ` +
    `Available profiles: ${selectableAgentProfileNames(profiles).join(', ')}. ` +
    defineProfileAdvice(name),
  );
}

/** Config shape these lookups need — anything carrying an `[agents]` table. */
type ProfileSource = { agents?: Record<string, AgentProfileConfig> };

/**
 * The profile a task's `agent_id` names, or throw naming the alternatives.
 *
 * The one call every SELECTION surface makes: `--agent` on create/start/edit/
 * unblock, the MCP equivalents, `[agent] agent_id`. It resolves the empty
 * agent to the default profile, so a task that never chose one still gets a
 * profile rather than a special case at each caller.
 */
export function profileForAgentName(
  config: ProfileSource,
  agentId: string | null | undefined,
  where = '',
): AgentProfile {
  return agentProfileOrThrow(agentProfilesFor(config), profileNameForAgent(agentId), where);
}

/**
 * The profile a task's `agent_id` names, or null when it names none.
 *
 * For paths that must survive a stale task record rather than fail a launch on
 * it — the same reasoning `agentDeclaredModel` already documents: a task whose
 * profile was deleted from lazy.toml is a config problem to report at the
 * selection surface, not a reason for an unrelated best-effort lookup (which
 * image to build, which model the harness prefers) to throw from underneath.
 */
export function profileForAgentNameOrNull(
  config: ProfileSource,
  agentId: string | null | undefined,
): AgentProfile | null {
  return agentProfilesFor(config).get(profileNameForAgent(agentId)) ?? null;
}

/**
 * The harness a task's `agent_id` runs, or null when the name resolves to no
 * profile. See {@link profileForAgentNameOrNull} for why this is lenient.
 */
export function harnessForAgentName(
  config: ProfileSource,
  agentId: string | null | undefined,
): string | null {
  return profileForAgentNameOrNull(config, agentId)?.harness ?? null;
}
