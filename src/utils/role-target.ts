/**
 * Per-role model target resolution.
 *
 * A role target is the agent PROFILE a role runs when the task names none, plus
 * the launch-time proxy address. This is the SINGLE decision point for "which
 * model does this role's launch ask for", and it collapses the logic that used
 * to be duplicated at every launch site (`if ollama.enabled force ollama.model`)
 * into one resolver.
 *
 * WHAT REPLACED THE BACKEND. A role used to carry `backend = anthropic | ollama
 * | proxy | openai`, which decided the upstream for EVERY task in the role.
 * Profiles moved that decision per task, so the four backends collapse into two
 * properties of the profile the role names:
 *   - `endpoint` — where lazy's proxy forwards (the old ollama/proxy/openai
 *     endpoint; empty = the proxy's primary upstream, the old `anthropic`).
 *   - `pinned` — whether a human named that endpoint in the profile's own
 *     block. This is the successor to `backend !== 'anthropic'`, and NOT the
 *     same as `endpoint !== ''`: built-in `codex` carries a default OpenAI
 *     upstream nobody chose.
 *
 * Two guardrails are baked in here (see CLAUDE.md: fail hard, least surprise):
 *  - No silent name substitution: a role on a pinned-endpoint profile with no
 *    configured model throws rather than guessing.
 *  - That model is authoritative — alias names like "claude-opus-5" don't exist
 *    on someone's Ollama box, so a caller's preferred model is intentionally
 *    ignored there.
 *
 * Reachability preflight (`preflightRoleTarget`) lives here too so every launch
 * path enforces the same fail-hard contract: an unreachable pinned upstream
 * fails with an actionable error and NEVER silently falls back to another one.
 */

import type { ResolvedConfig, RoleName, RoleTarget, RunnerType } from '../config/types';
import { resolveCredential } from '../credentials/store';
import { isHostedOllamaEndpoint } from './ollama';
import { endpointForHost, isLocalEndpoint } from './endpoint';
import { roleTargetForProfile, ANTHROPIC_DEFAULT_TARGET } from '../config/default-target';
import { changeProfileEndpointAdvice } from '../config/agent-profile-advice';
import { spawn } from './spawn';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  isAnthropicApiEndpoint,
  NO_CREDENTIAL,
  type AgentProfile,
} from '../config/agent-profiles';

export interface AuthEnvVar {
  key: string;
  value: string;
}

/*
 * REMOVED: `ResolvedRoleTarget`.
 *
 * It was a second, structurally identical spelling of `RoleTarget` — the same
 * four fields — and every caller passed its result straight back into a
 * `RoleTarget` parameter. Under profiles a target carries the wire and the
 * credential too, and those are exactly what the launch path downstream reads,
 * so a resolver returning the narrower shape would drop the fields its own
 * callers need. `resolveRoleTarget` returns a `RoleTarget`: same profile, with
 * the model decided and the pin dropped where the harness cannot honour it.
 */

/**
 * `roleTargetForProfile` and `ANTHROPIC_DEFAULT_TARGET` live in
 * `src/config/default-target.ts` — a module with no runtime imports at all —
 * because the config loader needs them at MODULE SCOPE (inside `DEFAULT_CONFIG`)
 * and this module reaches the loader through the credential store. Re-exported
 * here so every launch-path caller keeps one import site for role-target things.
 */
export { roleTargetForProfile, ANTHROPIC_DEFAULT_TARGET };

/**
 * The base URL an agent should use to reach the daemon's passthrough proxy,
 * given the runner it launches under and the proxy's actual (possibly
 * OS-assigned) bound port. Container runners reach host services via
 * `host.docker.internal`; the host-process runner reaches the proxy on its own
 * bind address (loopback by default). Resolved live at launch, so the proxy's
 * port never has to be pinned in config.
 */
export function proxyBaseUrlForRunner(
  runnerType: RunnerType,
  proxyPort: number,
  bind: string,
): string {
  const host =
    runnerType === 'docker' || runnerType === 'podman'
      ? 'host.docker.internal'
      : bind && bind !== '0.0.0.0'
        ? bind
        : '127.0.0.1';
  return `http://${host}:${proxyPort}`;
}

/*
 * REMOVED: `usesLazyProxy()`.
 *
 * It answered "does this role's traffic reach lazy's proxy?" and had two `false`
 * cases — `ollama` roles and any role pinned to an explicit `endpoint`. Both
 * were direct connections behind the audit plane's back, and both are gone: a
 * role `endpoint` is now the upstream lazy's PROXY forwards that role's traffic
 * to, never an address the launched process dials itself (see {@link targetEnvVars}).
 *
 * The predicate is deleted rather than left returning a constant `true`, because
 * a gate that is always open reads like a decision and invites a third `false`
 * case. The invariant it used to guard is structural now: every branch of
 * `targetEnvVars` emits lazy's proxy address or no base URL at all.
 */

export type TargetCheckResult =
  | { reachable: true; endpoint: string }
  | { reachable: false; endpoint: string; reason: string };

/**
 * Where the process being launched will actually run.
 *
 * This is NOT the same thing as `[runner] type`. `lazy pair`, `lazy chat`, and
 * the host-process runner all launch Claude Code as a HOST process even when
 * the project's runner is docker — so they must be handed host-reachable
 * addresses, not the Docker-internal ones a container would use.
 *
 * Every env-building call site must declare its surface (see {@link targetEnvVars}):
 * the parameter is required precisely so a new launch path cannot silently
 * inherit the wrong one.
 */
export type LaunchSurface = 'host' | 'container';

/**
 * Adapt a resolved target to the surface the process will run on.
 *
 * `host.docker.internal` is Docker's internal DNS alias for the host. It only
 * resolves INSIDE a container; a host process handed that name dies with
 * ENOTFOUND. So for a host launch the injected `proxyUrl` is rewritten to its
 * host-reachable form. Container launches are returned untouched: they genuinely
 * need the Docker-internal name, and blanket-converting would break them in the
 * other direction.
 *
 * ONLY `proxyUrl` is adapted, because it is the only address the launched
 * process ever dials. A role's `endpoint` is the upstream LAZY'S PROXY forwards
 * to, and the proxy runs in the daemon — a host process — so an endpoint is
 * host-perspective by definition and needs no per-surface translation (the
 * config loader normalizes it once at load; see `resolveRole`).
 */
export function targetForSurface(target: RoleTarget, surface: LaunchSurface): RoleTarget {
  if (surface !== 'host') return target;
  if (!target.proxyUrl) return target;
  return { ...target, proxyUrl: endpointForHost(target.proxyUrl) };
}

/*
 * REMOVED: `anthropicEnvVarsFromProcess()`.
 *
 * It read the Anthropic credential out of the CLIENT process's own environment,
 * and its only callers were `lazy pair` (×2) and `lazy chat` — the three
 * interactive host launches. That is the wrong source: the daemon owns the
 * credential (see daemon/credential-gate.ts), so a shell exporting nothing —
 * the normal case in a daemon-only-env setup, and what any freshly opened
 * terminal looks like — silently handed Claude Code no credential at all and
 * left it to fall through to the host store or a `/login` prompt.
 *
 * All three now go through `src/credentials/interactive-auth.ts`, which sources the
 * credential from the daemon over RPC. The function is deleted rather than left
 * exported-but-unused so the next launch surface cannot reach for it: a tolerant
 * reader that returns `[]` on a missing credential looks safe at the call site
 * and is exactly what made this failure silent. Use `resolveAuthEnvFromDaemon`.
 */

/**
 * Env vars that keep Claude Code stable when pointed at a server that doesn't
 * implement the full Anthropic API surface (telemetry/count_tokens endpoints
 * return 404/500 and can hang the server). See docs/spikes/local-model-agents.md §1.
 */
const LOCAL_BACKEND_STABILITY_ENV: AuthEnvVar[] = [
  { key: 'DISABLE_TELEMETRY', value: '1' },
  { key: 'DISABLE_ERROR_REPORTING', value: '1' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
];

/**
 * Should this target's launch carry {@link LOCAL_BACKEND_STABILITY_ENV}?
 *
 * The question is "is the Anthropic-wire server on the far side something other
 * than Anthropic's own API" — a pinned endpoint that is not api.anthropic.com.
 *
 * DELIBERATE WIDENING. The old gate was `backend === 'ollama'`, so a role on
 * `backend = "proxy"` (a self-hosted Anthropic-compatible gateway) got none of
 * these flags and hit exactly the 404s and hangs they exist to avoid. The three
 * flags only switch OFF telemetry, error reporting and non-essential traffic, so
 * applying them to every non-Anthropic Anthropic-wire server costs a user
 * nothing and fixes the case the narrower gate missed. Anthropic's own API keeps
 * its default behaviour: an unpinned profile never matches.
 */
function needsLocalStabilityEnv(target: RoleTarget): boolean {
  if (target.wire !== 'anthropic') return false;
  if (!target.pinned || !target.endpoint) return false;
  return !isAnthropicApiEndpoint(target.endpoint);
}

/**
 * Claude Code's escape hatch for "my base URL is a passthrough to Anthropic's
 * own API". Documented in the shipped bundle as the companion of
 * `ANTHROPIC_BASE_URL` (2.1.266).
 */
const ASSUME_FIRST_PARTY_ENV = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';

/**
 * Should this launch tell Claude Code its base URL is a first-party passthrough?
 *
 * THE BUG THIS FIXES. Claude Code decides a model's CONTEXT WINDOW from the
 * bundled model table, but the native-1M branch is additionally gated on the
 * process talking to Anthropic first-party — and it tests that by looking at
 * `ANTHROPIC_BASE_URL` against a literal one-host allowlist (`api.anthropic.com`).
 * Lazy always points that variable at its own proxy, so every lazy launch failed
 * the test and fell through to the 200k default: a builder on a 1M model showed
 * `108.6k/200k` while plain Claude Code in the same directory on the same account
 * showed `45.2k/1m`. Verified in this project's own container against 2.1.266 —
 * `claude --model claude-fable-5-1 -p "/context"` reports 200k with the proxy
 * base URL set and 1m with this flag added, and 200k either way for
 * `claude-sonnet-4-6`, which genuinely is a 200k model.
 *
 * It is not only the window: the same first-party test gates the small/fast
 * haiku model, model-alias resolution, org memory and the billing headers. All
 * of them ask the same question — "is the thing on the far side Anthropic's
 * API?" — and through lazy's proxy the honest answer is yes, because the proxy
 * is a passthrough to exactly that.
 *
 * WHICH IS WHY THE GATE IS NARROW. The answer is only yes when the traffic
 * really lands at Anthropic, so this returns false for an Ollama box, an
 * OpenAI-wire profile, a self-hosted Anthropic-compatible gateway, and — the
 * case `endpoint` alone cannot see — an unpinned profile riding a `[proxy]
 * upstream` that was pointed somewhere else. An unresolved `primaryUpstream` is
 * treated as unknown, not as Anthropic: losing the 1M window is a smaller
 * failure than telling Claude Code it has capabilities its upstream lacks.
 *
 * `[[proxy.fallback]]` is deliberately NOT consulted. A fallback is a transient
 * reroute during a 429/529 on the primary, not the launch's upstream, and a
 * launch-time env var cannot track it — a project whose fallback is not
 * Anthropic should expect 1M-window requests to fail while it is in effect.
 *
 * Exported because `lazy doctor` has to answer the same question for a
 * different reason: this predicate is half of "what context window does this
 * launch actually get" (`src/agent/context-window.ts`). One predicate, so the
 * window doctor reports and the window the launch gets cannot disagree.
 */
export function assumesFirstPartyBaseUrl(target: RoleTarget): boolean {
  if (target.wire !== 'anthropic') return false;
  // A profile that pays nobody is a local model server, whatever its address.
  if (target.credential === NO_CREDENTIAL) return false;
  const upstream = target.endpoint || target.primaryUpstream;
  if (!upstream) return false;
  return isAnthropicApiEndpoint(upstream);
}

/**
 * Audit routing hints attached to an agent's traffic. The proxy reads
 * `x-lazy-role` / `x-lazy-task-id` off each request to attribute the audited
 * call to the agent and task that made it, then strips them before forwarding
 * upstream (`src/proxy/server.ts`). They reach Claude Code via
 * `ANTHROPIC_CUSTOM_HEADERS`, which the CLI forwards on every request to its
 * `ANTHROPIC_BASE_URL` — lazy's proxy. Emitted only when a proxy address was
 * actually stamped, so an upstream never receives lazy-internal headers.
 */
export interface ProxyAuditHints {
  /** Whose traffic this is — `builder` or `agent`. */
  role?: RoleName;
  /** Short task id for per-task attribution. Omitted for the taskless builder. */
  taskId?: string;
}

/**
 * Values are interpolated into a header line, so a crafted id must not be able to
 * inject a newline (a second header) or otherwise break the pair. Role is a fixed
 * literal; task ids are short tokens — restrict to a simple safe charset and drop
 * anything that doesn't match rather than emitting a malformed/injected header.
 */
const SAFE_HEADER_VALUE = /^[A-Za-z0-9._-]+$/;

/**
 * Build the `ANTHROPIC_CUSTOM_HEADERS` env var carrying the audit hints, or null
 * when there is nothing safe to emit. Claude Code parses this var as newline- or
 * comma-separated `Name: Value` pairs and sends each header on every request to
 * its base URL. We newline-separate (our values never contain commas) and skip
 * any hint whose value isn't a simple token.
 */
export function proxyAuditHeaderEnv(hints: ProxyAuditHints | undefined): AuthEnvVar | null {
  if (!hints) return null;
  const lines: string[] = [];
  if (hints.role && SAFE_HEADER_VALUE.test(hints.role)) lines.push(`x-lazy-role: ${hints.role}`);
  if (hints.taskId && SAFE_HEADER_VALUE.test(hints.taskId)) lines.push(`x-lazy-task-id: ${hints.taskId}`);
  if (lines.length === 0) return null;
  return { key: 'ANTHROPIC_CUSTOM_HEADERS', value: lines.join('\n') };
}

/**
 * Credentials a profile whose `credential` is `none` uses in place of a real one.
 *
 * A model server on this machine ignores auth entirely, and such a profile is
 * the documented escape hatch from the daemon's credential gate — so it must
 * never need the user's real credential to launch. A single slot is emitted (not
 * the two lazy used to set) because the launch path swaps this value for a
 * per-launch PLACEHOLDER, and one placeholder per launch is one grant per
 * launch: the proxy needs exactly one to identify the caller and route it to the
 * profile's upstream.
 */
export const LOCAL_BACKEND_CREDS: AuthEnvVar[] = [
  { key: 'ANTHROPIC_AUTH_TOKEN', value: 'ollama' },
];

/**
 * True when this profile's launch carries no real secret at all.
 *
 * The `none` credential slot is the documented escape hatch from the daemon's
 * credential gate: a project whose profiles all point at local model servers has
 * no credential to hold, and must still launch. Callers use this to tell the
 * daemon they are self-credentialed rather than asking it for a token it does
 * not have.
 */
export function usesSyntheticCreds(target: Pick<RoleTarget, 'credential'>): boolean {
  return target.credential === NO_CREDENTIAL;
}

/**
 * Credentials a launched ANTHROPIC-WIRE process should carry for this profile,
 * or null when the answer is "the caller's own Anthropic credential".
 *
 * Null rather than a value for the Anthropic case because its SOURCE differs by
 * launch path — the daemon reads its own process env, a client fetches it over
 * the `getAuthEnv` RPC — and that choice belongs to the call site. Every other
 * slot has exactly one source (the credential store) and is resolved here so the
 * rule cannot drift between paths.
 *
 * `none` gets {@link LOCAL_BACKEND_CREDS}: a local server ignores auth, and
 * Claude Code still insists on a non-empty credential. Any other slot is a real
 * key placed in `ANTHROPIC_AUTH_TOKEN`, so the client emits `Authorization:
 * Bearer` — which is what ollama.com, OpenRouter's Anthropic-compatible Messages
 * endpoint, and OpenAI-compatible servers all authenticate with.
 *
 * On a PROXIED launch the value returned here is swapped for a placeholder
 * before it reaches the process, and the proxy substitutes the real credential
 * per upstream — so this resolution is what makes the launch fail EARLY and
 * actionably when a profile's key is missing, rather than as a 401 mid-turn.
 */
export async function resolveProfileLaunchCreds(
  projectRoot: string,
  target: Pick<RoleTarget, 'credential' | 'endpoint' | 'profile'>,
): Promise<AuthEnvVar[] | null> {
  if (target.credential === NO_CREDENTIAL) return LOCAL_BACKEND_CREDS;
  if (target.credential === 'anthropic') return null;

  const cred = await resolveCredential(projectRoot, target.credential);
  if (!cred) {
    const where = target.endpoint ? ` at ${target.endpoint}` : '';
    throw new Error(
      `Agent profile "${target.profile}"${where} bills the "${target.credential}" credential, ` +
      `but none is stored. Run \`lazy auth set ${target.credential}\`, or export its API key in ` +
      'the environment the daemon starts from.',
    );
  }
  return [{ key: 'ANTHROPIC_AUTH_TOKEN', value: cred.value }];
}

/**
 * Compute the environment variables that point Claude Code at a resolved target.
 *
 * INVARIANT — every role target is proxied. There is no branch here that hands a
 * launched process a non-lazy base URL. `ANTHROPIC_BASE_URL` is either lazy's own
 * proxy address (`proxyUrl`) or absent entirely, and "absent" never means
 * "connect direct": it means this process inherited an already-proxied base URL
 * from its parent (the in-container supervisor), or is running in an explicit
 * RPC-bypass mode with no daemon at all. A role's `endpoint` is deliberately
 * NEVER turned into an env var — it names the upstream the PROXY forwards to
 * (resolved from the launch grant's profile in `src/proxy/server.ts`), which is
 * the proxy's business, not the agent's.
 *
 * `anthropicCreds` is the credential to forward — supplied by the caller because
 * its source differs by launch path (the daemon reads its own process env; client
 * launches fetch it over RPC; a profile whose credential is `none` uses
 * {@link LOCAL_BACKEND_CREDS}). On a proxied launch it has already been swapped
 * for a placeholder, which is what identifies the caller to the proxy.
 *
 * `surface` says where the launched process will run and is REQUIRED — a host
 * process cannot resolve `host.docker.internal`, so a proxy address that is
 * correct for a container is a guaranteed ENOTFOUND on the host. Making it a
 * required parameter means a new launch path has to state which it is instead of
 * inheriting whichever the previous caller happened to want. See
 * {@link targetForSurface}.
 *
 * `hints` (optional) attach `x-lazy-role` / `x-lazy-task-id` audit headers via
 * `ANTHROPIC_CUSTOM_HEADERS`. They are a fallback attribution channel only — a
 * verified caller's grant outranks them (src/proxy/server.ts) — so they are
 * emitted only when traffic actually goes to the proxy.
 *
 * A pinned non-Anthropic upstream additionally gets
 * {@link LOCAL_BACKEND_STABILITY_ENV}: those flags are about Claude Code not
 * calling endpoints such a server lacks, which stays true regardless of who
 * makes the connection. See {@link needsLocalStabilityEnv}.
 *
 * A launch whose traffic really does land at Anthropic's own API additionally
 * gets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, without which Claude Code
 * caps every model at a 200k context window because the base URL is lazy's
 * proxy rather than api.anthropic.com. See {@link assumesFirstPartyBaseUrl} —
 * the gate there is what keeps the claim honest.
 */
export function targetEnvVars(
  rawTarget: RoleTarget,
  anthropicCreds: AuthEnvVar[],
  surface: LaunchSurface,
  hints?: ProxyAuditHints,
): AuthEnvVar[] {
  const target = targetForSurface(rawTarget, surface);
  const stability = needsLocalStabilityEnv(target) ? LOCAL_BACKEND_STABILITY_ENV : [];

  if (!target.proxyUrl) {
    // A MISSING proxyUrl does NOT mean "connect direct" — the proxy has no off
    // switch, and an unresolvable one fails the launch upstream (see
    // ProxyUnavailableError in daemon/auth-env.ts) rather than arriving here
    // unset. It means this process is not the one that OWNS the proxy decision:
    // a supervisor launched by the daemon inherits the proxied
    // ANTHROPIC_BASE_URL its parent already set, and the RPC-bypass modes
    // (test / daemon-self) have no address to stamp. So return the credential
    // and let the inherited base URL stand — do NOT throw here, or every
    // in-container supervisor launch breaks.
    return [...anthropicCreds, ...stability];
  }

  const vars: AuthEnvVar[] = [
    { key: 'ANTHROPIC_BASE_URL', value: target.proxyUrl },
    ...anthropicCreds,
    ...stability,
  ];
  // Emitted only alongside the base URL it qualifies: the flag says "the URL in
  // ANTHROPIC_BASE_URL is a passthrough to Anthropic", so it is meaningless —
  // and would be a claim about somebody else's variable — without one.
  if (assumesFirstPartyBaseUrl(target)) {
    vars.push({ key: ASSUME_FIRST_PARTY_ENV, value: '1' });
  }
  const header = proxyAuditHeaderEnv(hints);
  if (header) vars.push(header);
  return vars;
}

// Moved to a leaf module so the config loader can reach it without closing an
// import cycle (see src/utils/anthropic-models.ts); re-exported here because
// every existing caller imports it from this module.
export { KNOWN_ANTHROPIC_SHORT_NAMES, isKnownAnthropicModel } from './anthropic-models';

/**
 * Resolve the model + upstream a role's launch asks for.
 *
 * @param opts.overrideModel - an EXPLICIT user override (e.g. `lazy builder
 *   --model X`). Wins over the profile's model everywhere: it sets the model
 *   name while the endpoint (the "server") stays as configured. That makes a
 *   pinned profile effectively *server* configuration — its `model` is a default
 *   the explicit flag overrides, so you can point the same Ollama server at a
 *   different model without editing config.
 * @param opts.preferredModel - a SOFT default: honored on an unpinned profile,
 *   ignored on a pinned one. NOT how a task's model reaches a turn launch — the
 *   launch and the task header pass the task's persisted model as
 *   `overrideModel` (taskModelChoice, src/agent/agent-model.ts), because every
 *   turn runs the task's model. Callers that still pass a soft default here are
 *   choosing a model for something that is not a task turn.
 * @param opts.profile - the profile this launch ACTUALLY runs, when it differs
 *   from the role's default. A task names its own profile, so `[models.roles.*]`
 *   is only the fallback for a task that named none — resolving against the role
 *   default regardless would hand a claude-code task the model from someone
 *   else's Ollama profile.
 * @param opts.harness - the agent BINARY the turn runs, not a profile name.
 *   Only claude-code and pi can be pointed at a pinned Anthropic-wire upstream;
 *   any other harness ignores the pin here and takes the normal model chain.
 *   Redundant when `opts.profile` is given (a profile carries its harness); it
 *   exists for the caller that could not resolve one — see
 *   `profileForAgentNameOrNull`.
 *
 * On an unpinned profile the returned model may be the empty string, meaning
 * "the caller should fall back to its own default" (e.g. config.models.default,
 * or omitting `--model` entirely). On a pinned one the model is always concrete
 * (the override, else the authoritative profile model) and never empty.
 */
export function resolveRoleTarget(
  role: RoleName,
  config: ResolvedConfig,
  opts?: {
    preferredModel?: string | null;
    overrideModel?: string | null;
    harness?: string;
    profile?: AgentProfile | null;
  },
): RoleTarget {
  const configured = opts?.profile
    ? roleTargetForProfile(opts.profile)
    : config.models.roles[role];
  const harness = opts?.profile?.harness ?? opts?.harness;
  // An explicit CLI override wins over the profile's model everywhere (the
  // endpoint — the "server" — is left untouched). preferredModel, by contrast,
  // is soft and never overrides an authoritative pinned model.
  const override = opts?.overrideModel?.trim() || null;
  const unpinned = (model: string): RoleTarget => ({ ...configured, model, pinned: false });

  // A pinned Anthropic-wire upstream only works through agents lazy can point at
  // a lazy-controlled base URL: Claude Code (via ANTHROPIC_BASE_URL) and pi (via
  // the per-turn models.json override — see src/agent/pi-turn-config.ts). For
  // any other agent the pinned model NAME is meaningless, so fall back to the
  // standard model chain.
  //
  // Compared against the HARNESS, never the profile name: a profile called
  // `local-ollama-pi` would match neither branch and silently lose its model.
  //
  // The wire test is what keeps codex out of it. codex is pinned by its own
  // built-in default endpoint and configured entirely through
  // ~/.codex/config.toml, so it neither needs nor tolerates this branch's
  // Anthropic-shaped reasoning; its OpenAI-wire model name is authoritative and
  // is returned below like any other pinned one.
  const anthropicPin = configured.pinned && configured.wire === 'anthropic';
  const harnessCanBePinned = !harness || harness === 'claude-code' || harness === 'pi';
  if (anthropicPin && !harnessCanBePinned) {
    return unpinned(override ?? opts?.preferredModel ?? '');
  }

  if (!configured.pinned) {
    return unpinned(override ?? opts?.preferredModel ?? configured.model);
  }

  // Pinned: keep the profile's endpoint (the "server"). The model is the
  // explicit override when given, else the authoritative profile model — but
  // never the soft preferredModel. A pinned profile with no model is refused at
  // config load, but guard here too in case a target is constructed by hand.
  const model = override ?? configured.model;
  if (!model) {
    throw new Error(
      `No model configured for the "${role}" role, whose "${configured.profile}" profile pins ` +
      `endpoint = "${configured.endpoint}". Model names are specific to that endpoint, so lazy ` +
      `will not guess one — set model in lazy.toml [agents.${configured.profile}].`,
    );
  }
  return { ...configured, model };
}

/*
 * MOVED: `resolveAgentModel()` now lives in `src/agent/agent-model.ts`.
 *
 * It is the launch-time model decision, and its last step consults the agent
 * class (`Agent.defaultModel()`), so it needs the agent registry. Importing the
 * registry from HERE is a module cycle with a real failure mode, not a style
 * concern: role-target ← config/loader ← proxy/cursor-route ← agent/cursor ←
 * agent/registry, and evaluating role-target first left cursor-route's consts
 * in the temporal dead zone (`Cannot access 'DEFAULT_CURSOR_UPSTREAM' before
 * initialization`). So the composed resolver sits one layer up, where it may
 * depend on both, and this module stays a leaf that knows only config.
 *
 * MOVED: `endpointForHost()` now lives in `src/utils/endpoint.ts`, and is
 * re-exported here for the call sites that already imported it from this module.
 * Profile resolution normalizes every `[agents.<name>]` endpoint through it, and
 * this module now depends on profiles — so leaving the definition here would be
 * the same cycle in a new place.
 */
export { endpointForHost };

/**
 * What a probe of an upstream learned.
 *
 * The distinction that matters is `refused` vs `inconclusive`, and it is not
 * pedantry: a caller that REFUSES something on the strength of a probe may only
 * do so when the probe actually answered the question. "Nothing is listening on
 * that port" is an answer; "my five seconds ran out" is not, and treating the
 * second as the first turns a slow network into a lazy that will not let you
 * create a task.
 *
 * {@link checkTargetConnectivity} collapses both into "unreachable", which is
 * right for the LAUNCH preflight — there, failing hard on a silent upstream is
 * the whole point, and there is nothing to be gained by launching into it.
 */
export type UpstreamProbe =
  | { kind: 'answered'; status: string }
  | { kind: 'refused' }
  | { kind: 'inconclusive'; why: string };

/**
 * curl's "couldn't connect to host" — the exit code that means the TCP connect
 * itself was rejected or unroutable. This is the only outcome lazy reads as a
 * conclusive "nothing is serving here"; a DNS failure (6) and a timeout (28)
 * are both left inconclusive, because they can equally mean the probe's own
 * environment is the problem.
 */
const CURL_COULD_NOT_CONNECT = 7;

/**
 * Async HTTP probe via curl, bounded by `timeoutMs`.
 *
 * `--max-time` rather than only the spawn timeout, so curl exits on its own with
 * a reportable code instead of being killed by a signal we would then have to
 * guess the meaning of.
 */
async function probeUpstream(url: string, timeoutMs = 5_000): Promise<UpstreamProbe> {
  try {
    const proc = spawn(
      ['curl', '-s', '-o', '/dev/null', '--max-time', String(timeoutMs / 1000), '-w', '%{http_code}', url],
      // A second past curl's own deadline: the backstop must not fire first, or
      // every timeout arrives as a signal kill with no exit code to read.
      { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs + 1_000 },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return { kind: 'answered', status: stdout.trim() };
    if (exitCode === CURL_COULD_NOT_CONNECT) return { kind: 'refused' };
    return { kind: 'inconclusive', why: `curl exited ${exitCode ?? 'on a signal'}` };
  } catch (err) {
    return { kind: 'inconclusive', why: err instanceof Error ? err.message : String(err) };
  }
}

/** The status code an upstream answered with, or null when it did not answer. */
async function probeHttpStatus(url: string): Promise<string | null> {
  const probe = await probeUpstream(url);
  return probe.kind === 'answered' ? probe.status : null;
}

/**
 * Whether lazy probes this target's upstream before a launch — the single rule,
 * so every caller asks the question the same way.
 *
 *  - a PINNED endpoint (the user wrote it in their own `[agents.<name>]` block)
 *    — always, as it always was;
 *  - a LOCAL endpoint, pinned or not. This is what covers the built-in `pi`
 *    profile, whose default upstream is the machine's own Ollama: "is the server
 *    running?" is a real question there, the probe is a loopback round-trip, and
 *    the alternative is an opaque proxy failure mid-turn instead of
 *    {@link unreachableHint}'s "Start it with: ollama serve".
 *  - a hosted DEFAULT endpoint nobody chose (codex's api.openai.com) is NOT
 *    probed: it would add a network round-trip to every launch to answer a
 *    question the first request answers anyway.
 *
 * {@link checkTargetConnectivity} applies it internally, so a caller that only
 * wants to skip the await can pre-filter with it — and MUST use this rather than
 * its own `pinned` test, which is the stricter, older rule and goes quiet for
 * exactly the local default this exists to cover.
 */
export function probesUpstream(target: Pick<RoleTarget, 'endpoint' | 'pinned'>): boolean {
  if (!target.endpoint) return false;
  return target.pinned || isLocalEndpoint(target.endpoint);
}

/**
 * Preflight reachability for a role target's UPSTREAM.
 *
 * What is probed here is the address the DAEMON's proxy will forward to, not
 * the address the agent dials (the agent always dials lazy's proxy, whose
 * liveness the fail-loud gate in daemon/auth-env.ts already enforces). The probe
 * runs in a host process and a role `endpoint` is host-perspective by
 * definition — the loader normalizes it once at load — so what is verified here
 * is exactly what the proxy will connect to.
 *
 * A role with no endpoint rides the proxy's primary upstream, which has no local
 * component to probe; Anthropic reachability is the credential gate's concern.
 * Both report reachable.
 *
 * Which upstreams are probed at all is {@link probesUpstream}.
 */
export async function checkTargetConnectivity(target: RoleTarget): Promise<TargetCheckResult> {
  if (!probesUpstream(target)) return { reachable: true, endpoint: 'anthropic' };
  const endpoint = target.endpoint;
  // ONE probe for every pinned upstream, where there used to be a `/api/tags`
  // special case for ollama and a base-URL probe for everything else. Verified,
  // not assumed: `GET http://localhost:11434/` answers 200 ("Ollama is
  // running"), so the special case only ever bought the friendlier message —
  // which {@link unreachableHint} now produces from the endpoint itself.
  //
  // Any HTTP response (even 4xx/5xx) proves the upstream is reachable; only a
  // connection failure (null) means it is down.
  const status = await probeHttpStatus(endpoint);
  if (status !== null) return { reachable: true, endpoint };
  return { reachable: false, endpoint, reason: unreachableHint(endpoint) };
}

/** Ollama's default port. Its own docs and installer use it; nothing else does. */
const OLLAMA_DEFAULT_PORT = '11434';

/**
 * The "it did not answer" message for an endpoint, with the fix when we can name
 * one. Ollama is the one upstream lazy can recognize by address alone, and
 * "start it with: ollama serve" is the fix in the overwhelming majority of
 * cases — so recognizing it is worth a port check, while inventing a hint for an
 * arbitrary gateway would not be.
 */
function unreachableHint(endpoint: string): string {
  let isOllama = false;
  try {
    const url = new URL(endpoint);
    isOllama = url.port === OLLAMA_DEFAULT_PORT || isHostedOllamaEndpoint(endpoint);
  } catch {
    // A malformed endpoint cannot be recognized; the generic message still fits.
  }
  return isOllama
    ? `Ollama is not responding at ${endpoint}. Start it with: ollama serve`
    : `Upstream did not respond at ${endpoint}. Verify it is running and reachable from this host.`;
}

/**
 * Fail-hard preflight for a role's resolved target. Throws an actionable error
 * if the profile's pinned upstream is unreachable — NEVER silently falls back to
 * a different one (CLAUDE.md: fail hard on remote failures).
 *
 * An unpinned profile is a no-op here: it rides the proxy's primary upstream,
 * which has no local component to probe, and Anthropic reachability is the
 * credential gate's concern.
 *
 * Returns the address that was actually probed, or `'anthropic'` when there was
 * nothing local to probe.
 */
export async function preflightRoleTarget(role: RoleName, target: RoleTarget): Promise<string> {
  const check = await checkTargetConnectivity(target);
  if (check.reachable) return check.endpoint;
  throw new Error(
    `Preflight failed for the "${role}" role: ${check.reason} ` +
    `(profile "${target.profile}", endpoint = "${check.endpoint}"). ` +
    `That endpoint is the upstream lazy's proxy forwards this role to, and lazy will not ` +
    `silently fall back to a different one. ${changeProfileEndpointAdvice(target.profile)}`,
  );
}

/**
 * Is this target's upstream CONCLUSIVELY not serving — the question a caller
 * asks before refusing something a person is in the middle of doing.
 *
 * Deliberately a different question from {@link checkTargetConnectivity}, and
 * the difference is the whole point. That one answers "may this launch
 * proceed?", where a silent upstream is reason enough to stop. This one answers
 * "should lazy take this choice away from someone?", where it is not: only a
 * connection the host actively refused counts, and anything slower, stranger or
 * unprobeable answers `false` so the caller lets them carry on. A gate that
 * blocks on its own timeout is a worse bug than the one it was added to prevent.
 *
 * `timeoutMs` is the caller's latency budget, because the callers differ: a
 * preflight has a whole launch to hide in, an interactive refusal does not.
 * A target lazy does not probe at all ({@link probesUpstream}) is never
 * conclusive here.
 */
export async function upstreamRefused(target: RoleTarget, timeoutMs: number): Promise<boolean> {
  if (!probesUpstream(target)) return false;
  const probe = await probeUpstream(target.endpoint, timeoutMs);
  return probe.kind === 'refused';
}
