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
  isFireworksEndpoint,
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
import { defineProfileAdvice, endpointCredentialAdvice, keepProfileOnEndpointAdvice } from './agent-profile-advice';
import { isManagedMode } from './managed-mode';

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
  /** When to choose this profile, in plain words — shown wherever an agent is picked. */
  description?: string;
  /**
   * Name of an `[endpoints.<name>]` block this profile runs against — its URL
   * and credential — instead of an inline `endpoint`. A separate key on purpose:
   * `endpoint` is always a URL and never means "a URL or a name".
   */
  named_endpoint?: string;
  /**
   * `false` declares this profile's models as unable to reason (pi harness only),
   * for a model that rejects `reasoning_effort` outright (a legacy gpt-4o). Unset
   * means reasoning ON, which is what lets a task's effort reach the model.
   */
  reasoning?: boolean;
  /** Ordered usage tiers — makes this a TIERED profile. See {@link ResolvedTier}. */
  tiers?: AgentTierConfig[];
}

/** One `tiers = [{ … }]` entry exactly as written. */
export interface AgentTierConfig {
  /** `[endpoints.<name>]` this tier runs against. */
  endpoint?: string;
  model?: string;
  threshold_percent?: number;
}

/** A `[endpoints.<name>]` block exactly as written. */
export interface NamedEndpointConfig {
  url?: string;
  credential?: string;
  description?: string;
}

/** A named endpoint after validation. */
export interface NamedEndpoint {
  name: string;
  /** Absolute http(s) URL as written, trailing slash removed. */
  url: string;
  /**
   * Stored credential name as written. '' only on a managed host, where the
   * block is kept but every profile selecting it is not honoured
   * ({@link MissingEndpointCredentialError}).
   */
  credential: string;
  description: string;
}

/**
 * Which usage window decides whether a tier is available.
 *
 * `claude`: the Anthropic subscription's `unified-*` windows; `codex`: the
 * ChatGPT subscription's `codex-*` windows. `null` = UNCONDITIONAL — lazy reads
 * no usage window for this endpoint, so the tier is always available.
 */
export type TierUsageSource = 'claude' | 'codex' | null;

/** One resolved tier of a tiered profile. */
export interface ResolvedTier {
  /** 0-based position in the chain. */
  index: number;
  /** `[endpoints.<name>]` it runs against. */
  endpoint: string;
  /** Host-perspective upstream URL. */
  upstream: string;
  /** Stored credential that pays for it, or {@link NO_CREDENTIAL}. */
  credential: string;
  /** True when lazy.toml NAMED the credential, false when lazy inferred it. See {@link AgentProfile.credentialExplicit}. */
  credentialExplicit?: boolean;
  model: string;
  wire: AgentWire;
  usage: TierUsageSource;
  /**
   * Percent of the usage window at which this tier switches EARLY, before it
   * refuses. Optional: null = used until it refuses (a 429). A LAST
   * conditional tier with none is judged by `[usage_pause]`.
   */
  threshold: number | null;
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
  /** `[endpoints.<name>]` the profile named via `named_endpoint`, when it did. Unset on a tiered profile (see `tiers`). */
  endpointName?: string;
  /**
   * Stored credential that pays for this upstream — a provider name, a
   * user-chosen name (`lazy auth set work-openai`), or {@link NO_CREDENTIAL}
   * when the upstream takes none. {@link profileCredentialName} drops the last.
   */
  credential: string;
  /**
   * True when lazy.toml NAMED `credential` (on the profile or its named
   * endpoint), false when {@link defaultCredentialFor} inferred it.
   *
   * The proxy reads it: a provider's credential is attached to a host that is
   * not that provider's only when the config said so explicitly
   * ({@link providerCredentialHostMismatch}). An Anthropic-compatible gateway
   * that really wants the Anthropic key is a deliberate choice; an inferred
   * one never is. Absent reads as inferred — the safe direction.
   */
  credentialExplicit?: boolean;
  /** Derived from harness + endpoint. */
  wire: AgentWire;
  /** True when no `[agents.<name>]` block declares it — a built-in. */
  builtin: boolean;
  /**
   * When to choose this profile, in plain words. Informs a human or the builder
   * proposing an agent for a task; NOTHING selects a profile because of it.
   * '' when none is written and no built-in supplies one.
   */
  description: string;
  /**
   * Set only on a TIERED profile: the ordered chain the proxy picks from per
   * request. On such a profile `endpoint`/`model`/`credential`/`wire` mirror
   * TIER 0 — what the harness is launched against — so every launch-time reader
   * sees an ordinary concrete profile.
   */
  tiers?: ResolvedTier[];
  /** False only when the block wrote `reasoning = false` (pi). Absent = reasoning declared. */
  reasoning?: boolean;
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
  /** When to choose this profile — the built-in's own {@link AgentProfile.description}. */
  description: string;
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
  'claude-code': {
    harness: 'claude-code',
    description: 'Claude Code on your Anthropic account — the general-purpose default for most tasks.',
  },
  cursor: {
    harness: 'cursor',
    description: 'Cursor Agent on your Cursor subscription — implementation work when you would rather spend Cursor quota than Anthropic.',
  },
  codex: {
    harness: 'codex',
    description: 'OpenAI Codex on an OpenAI API key (the older name for codex-api).',
  },
  'codex-api': {
    harness: 'codex',
    endpoint: DEFAULT_OPENAI_UPSTREAM,
    description: 'OpenAI Codex billed to an OpenAI API key — when a task should run on an OpenAI model.',
  },
  'codex-subscription': {
    harness: 'codex',
    endpoint: CHATGPT_CODEX_UPSTREAM,
    description: 'OpenAI Codex on a ChatGPT subscription — an OpenAI model without API billing.',
  },
  pi: {
    harness: 'pi',
    description: 'The pi agent against a local model server — cheap or offline work where a smaller local model is enough.',
  },
  'qa-agent': { harness: 'qa-agent', description: "lazy's internal QA agent; not offered for tasks." },
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

const PROFILE_KEYS = ['harness', 'model', 'endpoint', 'credential', 'description', 'named_endpoint', 'reasoning', 'tiers'] as const;

/** Keys a TIERED profile may carry — everything else comes from its tiers. */
const TIERED_PROFILE_KEYS = ['harness', 'description', 'tiers'] as const;

const ENDPOINT_KEYS = ['url', 'credential', 'description'] as const;
const TIER_KEYS = ['endpoint', 'model', 'threshold_percent'] as const;

/**
 * Harnesses a tiered profile may run. claude-code only for now: it is the one
 * harness whose cross-provider history handling (thinking blocks) the proxy
 * makes safe on a switch, and the one the switch is tested with.
 */
export const TIERED_HARNESSES: readonly string[] = ['claude-code'];

/**
 * Longest `description` a profile may carry. It is rendered beside every agent
 * picker and listed in the builder's launch context, so it is a sentence or
 * two about WHEN to use the profile — not a prompt.
 */
export const DESCRIPTION_MAX = 500;

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

/**
 * A dot in a TOML table header splits the name, so an unquoted
 * `[agents.claude-glm-5.3]` parses (silently) as table `3` under profile
 * `claude-glm-5`. Detect that shape — a block whose values are tables — and
 * name the quoted form the author almost certainly meant. `tiers` is an array
 * of tables, never a plain table, so it is not affected.
 */
function assertNoNestedNameTables(section: 'agents' | 'endpoints', name: string, block: object): void {
  for (const [key, value] of Object.entries(block)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const intended = `${name}.${key}`;
    throw new Error(
      `lazy.toml [${section}.${name}] contains a nested table [${section}.${name}.${key}] — ` +
      `a dot in a table header splits the name. If "${intended}" was meant as one name, ` +
      `quote it: [${section}."${intended}"] (otherwise "${key}" is not a valid option here).`,
    );
  }
}

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
  if (isOpenRouterEndpoint(endpoint) || isFireworksEndpoint(endpoint)) return ['openai', 'anthropic'];
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
 * Credential a BUILT-IN profile uses — the ones lazy defines itself, whose
 * endpoints are fixed and known.
 *
 * A profile the user writes with an `endpoint`, a named endpoint and every
 * tier must NAME its credential ({@link MissingEndpointCredentialError}); this
 * is never consulted for them. It still covers a user block that keeps a
 * built-in's own endpoint (`[agents.codex] model = "…"`).
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
  if (isFireworksEndpoint(endpoint)) return 'fireworks';
  if (isLocalEndpoint(endpoint)) return NO_CREDENTIAL;
  // A provider's credential only ever for that provider's own host; anything
  // else gets NONE rather than the wire default. Unreachable for user endpoints
  // (they must name a credential) — kept so no future caller can turn an
  // unknown host into a destination for the user's Anthropic or OpenAI key.
  const host = hostnameOf(endpoint);
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'api.openai.com') return 'openai';
  return NO_CREDENTIAL;
}

/**
 * Provider credential names, and the hosts each one belongs to.
 *
 * `cursor` is absent on purpose: only the cursor harness ever names it, and its
 * placement is the client's own (src/proxy/credential-deps.ts).
 */
const PROVIDER_CREDENTIAL_HOSTS: Record<string, (endpoint: string) => boolean> = {
  anthropic: isAnthropicApiEndpoint,
  openai: (e) => hostnameOf(e) === 'api.openai.com',
  chatgpt: isChatGptEndpoint,
  openrouter: isOpenRouterEndpoint,
  fireworks: isFireworksEndpoint,
  ollama: isHostedOllamaEndpoint,
};

/**
 * The provider whose credential would be sent to a host that is not its own,
 * or null when nothing is wrong: the credential is not a provider's (`none`, or
 * a user-chosen store name), or the host is that provider's.
 *
 * The rule the proxy's backstop enforces: a provider credential goes to another
 * host only when lazy.toml named it for that endpoint.
 */
export function providerCredentialHostMismatch(credential: string, endpoint: string): string | null {
  const owns = PROVIDER_CREDENTIAL_HOSTS[credential];
  if (!owns || !endpoint.trim()) return null;
  return owns(endpoint) ? null : credential;
}

/**
 * An endpoint — `[endpoints.<name>]`, an inline profile `endpoint`, or a tier's
 * endpoint — that does not name its credential.
 *
 * Every endpoint MUST say which credential pays it (engineer's rule,
 * 2026-10-06: "anything without it is invalid"). Inferring one from the
 * hostname decided, silently, which of the user's secrets a host received;
 * naming it puts that decision in the file, where the user can read it. A
 * server that takes no credential says `credential = "none"`.
 *
 * Its own class so managed mode can report the block as not honoured instead
 * of failing the whole load (see {@link resolveAgentProfiles}).
 */
export class MissingEndpointCredentialError extends Error {
  constructor(readonly block: string, readonly url: string, suggested: string) {
    super(
      `lazy.toml ${block} has no credential. Every endpoint must name the credential that pays for it ` +
      `— lazy does not guess which of your secrets to send to ${hostnameOf(url) ?? url}.\n\n` +
      endpointCredentialAdvice(block, suggested, isLocalEndpoint(url)),
    );
    this.name = 'MissingEndpointCredentialError';
  }
}

/** The credential name the missing-credential error suggests: the provider for its own host, else the block's name. */
function suggestedCredentialName(url: string, fallback: string): string {
  for (const [provider, owns] of Object.entries(PROVIDER_CREDENTIAL_HOSTS)) {
    if (owns(url)) return provider;
  }
  return isValidName(fallback) ? fallback : 'my-endpoint';
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
 * `warn` receives non-fatal notes — the host-perspective endpoint rewrite, and a
 * codex endpoint ending in `/v1` (which codex would request as `/v1/v1/...`).
 * The rewrite mirrors the one role targets already emit.
 */
function resolveProfile(
  name: string,
  raw: AgentProfileConfig | undefined,
  warn: (message: string) => void,
  endpoints: Map<string, NamedEndpoint> = new Map(),
): AgentProfile {
  const where = `[agents.${name}]`;

  if (!isValidName(name)) throw nameError('agent profile name', name, `[agents.${name}]`);

  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        `lazy.toml ${where} must be a table of settings, e.g.\n\n` +
        `  [agents.${name}]\n  harness = "claude-code"\n  model = "claude-opus-5-5"`,
      );
    }
    assertNoNestedNameTables('agents', name, raw);
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

  let description = '';
  if (raw?.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new Error(
        `lazy.toml ${where} description must be a string of plain text, e.g. ` +
        `description = "Use for anything touching security".`,
      );
    }
    // One line: it is rendered as a list bullet and a single CLI line.
    description = raw.description.trim().replace(/\s+/g, ' ');
    if (description.length > DESCRIPTION_MAX) {
      throw new Error(
        `lazy.toml ${where} description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}. ` +
        `Say in a sentence or two when to choose this agent.`,
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

  if (raw?.tiers !== undefined) {
    return resolveTieredProfile(name, where, raw, harness, description, endpoints, warn);
  }

  // `named_endpoint` stands in for an inline `endpoint` (and, unless the
  // profile names its own, its `credential`): the profile is then exactly as if
  // it had written the endpoint's URL and credential itself.
  let named: NamedEndpoint | null = null;
  if (raw?.named_endpoint !== undefined) {
    if (typeof raw.named_endpoint !== 'string' || !raw.named_endpoint.trim()) {
      throw new Error(`lazy.toml ${where} named_endpoint must be the name of an [endpoints.<name>] block.`);
    }
    if (raw.endpoint !== undefined) {
      throw new Error(
        `lazy.toml ${where} sets both endpoint and named_endpoint. Use one: endpoint is a URL, ` +
        `named_endpoint names an [endpoints.<name>] block.`,
      );
    }
    named = namedEndpointOrThrow(endpoints, raw.named_endpoint.trim(), `${where} named_endpoint`);
  }

  const endpointSet = named !== null || (typeof raw?.endpoint === 'string' && raw.endpoint.trim().length > 0);
  // The built-in's own endpoint wins over the harness default, but ONLY while the
  // block still runs that harness: `[agents.codex-subscription] harness = "pi"`
  // has repurposed the name, and forcing the ChatGPT backend on it would be lazy
  // overriding an explicit choice.
  const defaultEndpoint =
    (builtin?.harness === harness ? builtin.endpoint : undefined) ??
    HARNESS_DEFAULT_ENDPOINT[harness] ??
    '';
  let endpoint = named ? named.url : endpointSet ? raw!.endpoint!.trim() : defaultEndpoint;
  if (endpoint) endpoint = normalizeEndpointUrl(endpoint, where, harness, warn);

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
  //   [agents.my-pi]  harness = "pi"  model = "claude-opus-5-5"
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

  let reasoning: boolean | undefined;
  if (raw?.reasoning !== undefined) {
    if (typeof raw.reasoning !== 'boolean') {
      throw new Error(`lazy.toml ${where} reasoning must be true or false.`);
    }
    if (harness !== 'pi') {
      throw new Error(
        `lazy.toml ${where} sets reasoning, which only the "pi" harness uses (it declares the model's ` +
        `capabilities to pi). Remove it, or set harness = "pi".`,
      );
    }
    if (!raw.reasoning) reasoning = false;
  }

  const ownCredential = (raw?.credential ?? '').trim();
  // An endpoint the user wrote must name what pays it — no hostname inference.
  // Only a built-in's own fixed endpoint falls back to defaultCredentialFor.
  if (endpointSet && !ownCredential && !named?.credential) {
    const block = named ? `[endpoints.${named.name}]` : where;
    throw new MissingEndpointCredentialError(block, endpoint, suggestedCredentialName(endpoint, named?.name ?? name));
  }
  const credentialExplicit = !!ownCredential || !!named?.credential;
  const credential = ownCredential || named?.credential || defaultCredentialFor(harness, wire, endpoint);
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
    ...(named ? { endpointName: named.name } : {}),
    credential,
    credentialExplicit,
    wire,
    ...(reasoning === false ? { reasoning } : {}),
    builtin: raw === undefined,
    // A block overriding a built-in keeps the built-in's description unless it
    // writes its own — but only while it still runs that harness against the
    // built-in's upstream: a repointed endpoint makes that text false.
    description: description || (builtin?.harness === harness && !endpointSet ? builtin.description : ''),
  };
}

/**
 * Validate an endpoint URL and turn it into the host-perspective upstream the
 * proxy dials. Shared by inline `endpoint`, `[endpoints.<name>] url` uses and
 * tiers, so every spelling of an upstream is checked and rewritten one way.
 */
function normalizeEndpointUrl(
  endpointIn: string,
  where: string,
  harness: string,
  warn: (message: string) => void,
): string {
  let endpoint = endpointIn;
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
  // codex's base_url already ends in `/v1` for every non-ChatGPT upstream and
  // the proxy forwards endpoint + path verbatim, so an endpoint ending in
  // `/v1` requests `/v1/v1/responses`. Warn rather than rewrite: routing
  // stays exactly as configured.
  if (harness === 'codex' && !isChatGptEndpoint(endpoint) && /\/v1$/.test(new URL(endpoint).pathname)) {
    warn(
      `lazy.toml ${where} endpoint = "${endpoint}" ends in /v1, but lazy adds /v1 to codex ` +
      `requests itself, so they would go to ${endpoint}/v1/responses and fail. ` +
      `Use endpoint = "${endpoint.replace(/\/v1$/, '')}" instead.`,
    );
  }
  return endpoint;
}

function namedEndpointOrThrow(endpoints: Map<string, NamedEndpoint>, name: string, where: string): NamedEndpoint {
  const found = endpoints.get(name);
  if (found) return found;
  const known = [...endpoints.keys()].sort();
  throw new Error(
    `lazy.toml ${where} names endpoint "${name}", but there is no [endpoints.${name}] block. ` +
    (known.length ? `Defined endpoints: ${known.join(', ')}.` : 'Define it, e.g.\n\n' +
      `  [endpoints.${name}]\n  url = "https://api.anthropic.com"`),
  );
}

/**
 * The usage window lazy reads for a tier, or null when it reads none.
 *
 * Only two exist today, and both are verified captures through the proxy
 * (src/usage-pause/policy.ts): Anthropic's subscription `unified-*` windows and
 * the ChatGPT subscription's `codex-*` windows. A tier is CONDITIONAL when it
 * runs on Anthropic's API or spends the `anthropic` credential (a gateway in
 * front of Anthropic passes the same headers through), or on the ChatGPT
 * backend or its `chatgpt` credential. Everything else — Fireworks, OpenRouter,
 * a local Ollama — reports no window, so a tier on it is UNCONDITIONAL: always
 * available.
 */
export function tierUsageSourceFor(upstream: string, credential: string): TierUsageSource {
  if (isAnthropicApiEndpoint(upstream) || credential === 'anthropic') return 'claude';
  if (isChatGptEndpoint(upstream) || credential === 'chatgpt') return 'codex';
  return null;
}

/** Validate every `[endpoints.<name>]` block. */
export function resolveNamedEndpoints(
  raw: Record<string, NamedEndpointConfig> | undefined,
  lenient = false,
): Map<string, NamedEndpoint> {
  const out = new Map<string, NamedEndpoint>();
  for (const [name, block] of Object.entries(raw ?? {})) {
    const where = `[endpoints.${name}]`;
    if (!isValidName(name)) throw nameError('endpoint name', name, where);
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new Error(`lazy.toml ${where} must be a table, e.g.\n\n  ${where}\n  url = "https://api.fireworks.ai/inference"`);
    }
    assertNoNestedNameTables('endpoints', name, block);
    for (const key of Object.keys(block)) {
      if (!(ENDPOINT_KEYS as readonly string[]).includes(key)) {
        throw new Error(`Unknown option "${key}" in lazy.toml ${where}. Valid options: ${ENDPOINT_KEYS.join(', ')}.`);
      }
    }
    if (typeof block.url !== 'string' || !block.url.trim()) {
      throw new Error(`lazy.toml ${where} has no url. Set url = "<the upstream base URL>".`);
    }
    // Validated as a URL here; host rewriting and harness checks happen per use.
    normalizeEndpointUrl(block.url.trim(), where, '', () => {});
    const credential = typeof block.credential === 'string' ? block.credential.trim() : '';
    if (block.credential !== undefined && (typeof block.credential !== 'string' || !isValidName(credential))) {
      throw nameError('credential name', String(block.credential), where);
    }
    // Refused here, at the block, even when no profile uses it yet. Under
    // managed mode the block is kept (the import is verbatim) and every
    // profile that selects it is reported as not honoured instead.
    if (!credential && !lenient) {
      const url = block.url.trim();
      throw new MissingEndpointCredentialError(where, url, suggestedCredentialName(url, name));
    }
    if (block.description !== undefined && typeof block.description !== 'string') {
      throw new Error(`lazy.toml ${where} description must be a string.`);
    }
    out.set(name, {
      name,
      url: block.url.trim().replace(/\/$/, ''),
      credential,
      description: (block.description ?? '').trim(),
    });
  }
  return out;
}

/**
 * Resolve a TIERED `[agents.<name>]` block.
 *
 * Every tier is (named endpoint, model). All tiers share the profile's one
 * harness, and so its one wire. Everything is checked here so a malformed chain
 * fails at config load, loudly, naming the tier.
 */
function resolveTieredProfile(
  name: string,
  where: string,
  raw: AgentProfileConfig,
  harness: string,
  description: string,
  endpoints: Map<string, NamedEndpoint>,
  warn: (message: string) => void,
): AgentProfile {
  for (const key of Object.keys(raw)) {
    if (!(TIERED_PROFILE_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `lazy.toml ${where} has tiers, so "${key}" cannot be set on it — each tier names its own ` +
        `endpoint and model. Valid options on a tiered profile: ${TIERED_PROFILE_KEYS.join(', ')}.`,
      );
    }
  }
  if (!TIERED_HARNESSES.includes(harness)) {
    throw new Error(
      `lazy.toml ${where} is a tiered profile on the "${harness}" harness; tiered profiles support ` +
      `${TIERED_HARNESSES.join(', ')} only for now.`,
    );
  }
  if (!Array.isArray(raw.tiers) || raw.tiers.length < 1) {
    throw new Error(
      `lazy.toml ${where} tiers must list at least one tier (usually two or more), e.g.\n\n` +
      `  tiers = [\n    { endpoint = "anthropic-sub", model = "claude-sonnet-5-5", threshold_percent = 95 },\n` +
      `    { endpoint = "ollama-local", model = "qwen3-coder" },\n  ]`,
    );
  }
  const tiers: ResolvedTier[] = [];
  const seen = new Set<string>();
  raw.tiers.forEach((t, index) => {
    const at = `${where} tiers[${index}]`;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new Error(`lazy.toml ${at} must be a table like { endpoint = "<name>", model = "<model>" }.`);
    }
    for (const key of Object.keys(t)) {
      if (!(TIER_KEYS as readonly string[]).includes(key)) {
        throw new Error(`Unknown option "${key}" in lazy.toml ${at}. Valid options: ${TIER_KEYS.join(', ')}.`);
      }
    }
    if (typeof t.endpoint !== 'string' || !t.endpoint.trim()) {
      throw new Error(`lazy.toml ${at} has no endpoint. Name an [endpoints.<name>] block.`);
    }
    const ep = namedEndpointOrThrow(endpoints, t.endpoint.trim(), at);
    if (typeof t.model !== 'string' || !t.model.trim()) {
      throw new Error(`lazy.toml ${at} has no model. Model names are specific to the endpoint, so lazy will not guess one.`);
    }
    const model = t.model.trim();
    const key = `${ep.name}\u0000${model}`;
    if (seen.has(key)) throw new Error(`lazy.toml ${at} repeats endpoint "${ep.name}" with model "${model}".`);
    seen.add(key);
    const upstream = normalizeEndpointUrl(ep.url, `${at} (endpoint "${ep.name}")`, harness, warn);
    const wireResult = wireForProfile(harness, upstream);
    if ('error' in wireResult) throw new Error(`lazy.toml ${at} (endpoint "${ep.name}"): ${wireResult.error}`);
    if (!ep.credential) {
      throw new MissingEndpointCredentialError(`[endpoints.${ep.name}]`, upstream, suggestedCredentialName(upstream, ep.name));
    }
    const credentialExplicit = true;
    const credential = ep.credential;
    const usage = tierUsageSourceFor(upstream, credential);
    let threshold: number | null = null;
    if (t.threshold_percent !== undefined) {
      if (usage === null) {
        throw new Error(
          `lazy.toml ${at} sets threshold_percent, but endpoint "${ep.name}" (${upstream}) reports no ` +
          `usage window lazy can read, so a threshold would never apply — the tier is used until it ` +
          `refuses. Remove threshold_percent from this tier.`,
        );
      }
      if (typeof t.threshold_percent !== 'number' || !Number.isInteger(t.threshold_percent)
        || t.threshold_percent < 1 || t.threshold_percent > 100) {
        throw new Error(`lazy.toml ${at} threshold_percent must be a whole number from 1 to 100.`);
      }
      threshold = t.threshold_percent;
    }
    // No threshold is fine on any tier: every tier hands over by REFUSING (a
    // 429), and a threshold is only an optional early switch
    // (src/proxy/tier-select.ts; engineer, 2026-10-06).
    tiers.push({
      index,
      endpoint: ep.name,
      upstream,
      credential,
      credentialExplicit,
      model,
      wire: wireResult.wire,
      usage,
      threshold,
    });
  });
  const wire = tiers[0]!.wire;
  const mixed = tiers.find((t) => t.wire !== wire);
  if (mixed) {
    throw new Error(
      `lazy.toml ${where} tiers[${mixed.index}] speaks the ${mixed.wire} API but tiers[0] speaks ${wire}; ` +
      `every tier of one profile must speak the same API.`,
    );
  }
  for (const t of tiers) {
    if (!isValidName(t.credential)) throw nameError('credential name', t.credential, `${where} tiers[${t.index}]`);
  }
  const first = tiers[0]!;
  return {
    name,
    harness,
    model: first.model,
    endpoint: first.upstream,
    endpointPinned: true,
    credential: first.credential,
    credentialExplicit: first.credentialExplicit,
    wire,
    builtin: false,
    description,
    tiers,
  };
}

/** True when the profile is a tiered one. */
export function isTieredProfile(profile: Pick<AgentProfile, 'tiers'> | null | undefined): boolean {
  return !!profile?.tiers && profile.tiers.length > 0;
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
  rawEndpoints?: Record<string, NamedEndpointConfig>,
): Map<string, AgentProfile> {
  // MANAGED: the control plane imports a project's lazy.toml verbatim
  // (importers never reject), so an endpoint with no credential must not take
  // the whole project down. The profile is left out — never run with a guessed
  // credential — and said so, naming the line to add. Everywhere else it is a
  // load error.
  const lenient = isManagedMode();
  const endpoints = resolveNamedEndpoints(rawEndpoints, lenient);
  const profiles = new Map<string, AgentProfile>();
  for (const name of BUILTIN_PROFILE_NAMES) {
    profiles.set(name, resolveProfile(name, undefined, warn, endpoints));
  }
  const notHonoured: Array<{ profile: string; reason: string }> = [];
  for (const [name, block] of Object.entries(raw ?? {})) {
    try {
      profiles.set(name, resolveProfile(name, block ?? {}, warn, endpoints));
    } catch (err) {
      if (!lenient || !(err instanceof MissingEndpointCredentialError)) throw err;
      // A built-in of this name stays as it was rather than vanishing.
      notHonoured.push({ profile: name, reason: err.message });
      // One generic line at the point of occurrence; `lazy doctor` carries the
      // full reason (single warning surface).
      warn(`agent profile "${name}" is not honoured — run lazy doctor for why.`);
    }
  }
  if (notHonoured.length) NOT_HONOURED.set(profiles, notHonoured);
  return profiles;
}

const NOT_HONOURED = new WeakMap<Map<string, AgentProfile>, Array<{ profile: string; reason: string }>>();

/**
 * The `[agents.<name>]` blocks a managed host left out because an endpoint they
 * use names no credential, each with the reason. Empty everywhere else — there
 * the same block fails the load. Read by `lazy doctor`.
 */
export function notHonouredProfiles(profiles: Map<string, AgentProfile>): Array<{ profile: string; reason: string }> {
  return NOT_HONOURED.get(profiles) ?? [];
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
export function agentProfilesFor(config: ProfileSource): Map<string, AgentProfile> {
  const raw = config.agents;
  if (!raw) return resolveAgentProfiles(undefined, () => {});
  const cached = RESOLVED_CACHE.get(raw);
  if (cached) return cached;
  const resolved = resolveAgentProfiles(raw, undefined, config.endpoints);
  RESOLVED_CACHE.set(raw, resolved);
  return resolved;
}

/**
 * The offered profiles as a markdown bullet list — name, what it runs, and its
 * `description` as a "use when" note — for prompts that let an agent PROPOSE a
 * profile (the builder's launch context). Informational: nothing selects a
 * profile from this.
 */
export function renderAgentProfileList(profiles: Map<string, AgentProfile>): string {
  return selectableAgentProfiles(profiles)
    .map((p) => {
      const runs = `${p.harness}, ${p.model || `${p.harness} default model`}`;
      const origin = p.builtin ? 'built-in' : 'lazy.toml';
      return `- \`${p.name}\` (${runs}; ${origin})` + (p.description ? ` — use when: ${p.description}` : '');
    })
    .join('\n');
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
type ProfileSource = {
  agents?: Record<string, AgentProfileConfig>;
  endpoints?: Record<string, NamedEndpointConfig>;
};

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
