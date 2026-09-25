/**
 * The daemon's `agent` input check — one place, so every route says the same
 * thing about the same mistake.
 *
 * `agent` on a task names a PROFILE (`[agents.<name>]` in lazy.toml), not a
 * harness. The built-in profiles are named after the harnesses, so every old
 * spelling still validates; what is new is that a project can define
 * `local-ollama-pi` and select it. Validation therefore has to read the
 * project's config — it is no longer a lookup in a fixed registry table, which
 * is why this is async and why every caller passes the project root.
 *
 * It lives apart from ./rpc-params (which stays a pure shape-checker with no
 * config dependency) and apart from ./rpc-handlers (which would form an import
 * cycle with the launcher and lifecycle modules that call this).
 */

import { agentProfileOrThrow, agentProfilesFor } from '../config/agent-profiles';
import { roleTargetForProfile } from '../config/default-target';
import { unrunnableProfileRefusal } from '../config/agent-profile-advice';
import { isManagedMode } from '../config/managed-mode';
import { loadConfig } from '../config/loader';
import { upstreamRefused } from '../utils/role-target';
import { RpcError } from './rpc-error';

/**
 * Reject an `agent` value that names no profile in this project, as a 400.
 *
 * `undefined` means "not supplied" and passes; an empty string does NOT — a
 * caller who sent the field must have meant a profile. (Resolving the empty
 * name to the default profile is what `profileForAgentName` is for, and that
 * belongs to the paths reading a task's STORED agent, not to input checking.)
 */
export async function assertKnownAgentProfile(
  projectRoot: string,
  agent: string | undefined,
  where = 'agent',
): Promise<void> {
  if (agent === undefined) return;
  const config = await loadConfig(projectRoot);
  try {
    agentProfileOrThrow(agentProfilesFor(config), agent, where);
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}

/**
 * How long create will wait to learn whether an agent's upstream is serving.
 *
 * Short because this is inside somebody's create, and a create on Lazy Teams is
 * a request a browser is holding. The case this gate exists for — nothing
 * listening on a local port — is answered in about a millisecond, because the
 * kernel refuses the connect immediately; the budget only bounds the pathological
 * case, and running out of it means the gate stands aside.
 */
export const RUNNABLE_PROBE_TIMEOUT_MS = 1_500;

/**
 * Refuse to create a task on an agent this INSTALLATION cannot run.
 *
 * ## Why create, and why only here
 *
 * Every other refusal in this file is about input that is wrong. This one is
 * about input that is fine but doomed: lazy's built-in `pi` profile runs the
 * machine's own Ollama, so on an installation with no model server a member can
 * pick Pi from a list lazy offered them, press create, and own a task that
 * nothing will ever run. The launch refuses with a good message, but by then
 * they have a dead task and a failure to read (`fix-teams-pi-agent-launch`).
 *
 * ## Why only on a managed host
 *
 * Off one, an unreachable upstream is a normal thing to create against: your
 * Ollama is not running YET, and you will start it before the task does. Lazy
 * has no business refusing that, and "commands do what their name says" means
 * create creates. On a managed host the asymmetry is total — the repository
 * cannot point the profile anywhere else (`agents.*.endpoint` is refused), and
 * the member cannot start a server on a host they do not have. Nothing they do
 * later will make it runnable, so "not yet" is not a state that exists.
 *
 * ## Why this is not a probe in the render path
 *
 * It runs on CREATE, not on every render of a form that offers agents, and it is
 * bounded by {@link RUNNABLE_PROBE_TIMEOUT_MS}. It also fails OPEN: only a
 * connection the host actively refused is acted on ({@link upstreamRefused}),
 * so a slow or unprobeable upstream lets the create through and the launch
 * preflight remains the backstop it always was.
 *
 * ## What it is given
 *
 * The RESOLVED agent — after inheritance and `[agent.by_type]` — not the string
 * somebody typed, because a subtask inheriting an unrunnable agent is exactly as
 * dead as one that named it. The blast radius of that choice is small by
 * construction: only a profile whose upstream lazy probes at all is ever
 * considered ({@link probesUpstream} — a pinned endpoint, or a local one), and
 * on a managed host a repository cannot pin an endpoint, so in practice this can
 * only ever fire on a built-in profile with a LOCAL default upstream. Today that
 * is `pi` and nothing else.
 */
export async function assertAgentProfileRunnable(
  projectRoot: string,
  agent: string | undefined,
): Promise<void> {
  if (agent === undefined || !isManagedMode()) return;

  const config = await loadConfig(projectRoot);
  // Unknown names are `assertKnownAgentProfile`'s to report, and it runs first
  // at every call site; resolving here again must not invent a second, worse
  // spelling of that same error.
  const profiles = agentProfilesFor(config);
  const profile = profiles.get(agent);
  if (!profile) return;

  const target = roleTargetForProfile(profile);
  if (!(await upstreamRefused(target, RUNNABLE_PROBE_TIMEOUT_MS))) return;

  throw new RpcError(400, unrunnableProfileRefusal(profile.name, target.endpoint));
}
