/**
 * The project settings overlay: the deployment's operational overrides,
 * layered OVER the repository's lazy.toml.
 *
 * Design: docs/design/lazy-teams.md §11. The short version — a project's
 * settings live in lazy.toml, a tracked file. Editing that file from a browser
 * would put a settings checkbox on the default branch of the user's repository
 * (and, for a protected branch, behind a pull request), which §11.2 evaluated
 * and rejected. Instead lazy.toml keeps stating the repository's *default* and
 * the store records the deployment's *override*. lazy.toml is never written
 * from here.
 *
 * The precedence chain, highest first, is the whole contract:
 *
 *   per-turn override      (startTask modelOverride)
 *     > task.model         (pinned at the task's first launch)
 *       > project setting  (this overlay)
 *         > lazy.toml      ([models] default)
 *           > lazy's built-in default
 *
 * `resolveProjectModel` implements the bottom three links; the top two stay
 * where they already are, in the launcher.
 */

import type { Storage } from '../storage/interface';
import type { ProjectSettings } from '../storage/types';
import type { ResolvedConfig } from '../config/types';
import { agentProfilesFor, selectableAgentProfiles } from '../config/agent-profiles';
import { logger } from '../utils/logger';

/**
 * One setting, reported with enough provenance for a UI to be honest about it.
 *
 * A settings page that shows only the winning value is how a two-source design
 * turns into a support ticket, so every read carries both values and which one
 * won (design §11.2, rule 2).
 */
export interface EffectiveSetting {
  /** The value actually in force. */
  value: string;
  /** What lazy.toml says, whether or not it won. */
  repositoryValue: string;
  /** Where `value` came from. */
  source: 'project-setting' | 'repository';
  /** Whether a control plane may change this one yet (design §11.4). */
  editable: boolean;
}

/**
 * One `[agents.<name>]` profile as a REMOTE picker may offer it.
 *
 * The daemon's own pages read profiles straight out of the resolved config
 * (`selectableAgentProfiles`), which a remote client cannot do: it has no
 * lazy.toml. Without this a browser client can only offer a hardcoded list of
 * harness names — which is both a second copy of lazy's agent vocabulary and
 * wrong, because it hides every profile the project actually configured and
 * offers internal agents the daemon's own picker excludes.
 *
 * DELIBERATELY NOT the full {@link AgentProfile}. `endpoint` and `credential`
 * describe where a profile's traffic goes and which key pays for it — operator
 * configuration, not a choice anybody makes in a task form (memory
 * `teams-product-posture`: users never see ops verbs). Nothing that merely
 * describes auth should travel, which is the same line `handleGetCredentialState`
 * draws. A picker needs the name, and enough beside it to tell two profiles
 * apart.
 */
export interface AgentProfileChoice {
  /** Profile name — the value that goes on a task as its agent. */
  name: string;
  /** Registered agent implementation that drives the turn. */
  harness: string;
  /** Model the profile pins; '' means the harness's own default. */
  model: string;
  /** True when no `[agents.<name>]` block declares it — one of lazy's built-ins. */
  builtin: boolean;
}

/**
 * The full settings read: what is in force, what the repository says, and the
 * overlay itself. This is the shape the `getProjectSettings` RPC returns.
 */
export interface EffectiveProjectSettings {
  defaultAgent: EffectiveSetting;
  defaultModel: EffectiveSetting;
  /**
   * Agents this project can run, in picker order: its own configured profiles
   * first, lazy's built-ins beneath them. Empty only when the profile table
   * could not be resolved at all — a client offering nothing is honest, one
   * inventing names is not.
   */
  agentProfiles: AgentProfileChoice[];
  /** Display-only for now — the mechanism generalises, the forms do not exist. */
  runnerType: EffectiveSetting;
  agentEffort: EffectiveSetting;
  /** Overlay metadata, absent when nothing has ever been set. */
  updatedAt?: string;
  updatedBy?: string;
}

function setting(
  override: string | undefined,
  repositoryValue: string,
  editable: boolean,
): EffectiveSetting {
  // An override is only in force when it is a non-empty string. Omitted and
  // empty both mean "defer to the repository" — saveProjectSettings never
  // writes an empty string, but a hand-edited store or an older record might.
  const active = typeof override === 'string' && override.length > 0;
  return {
    value: active ? override : repositoryValue,
    repositoryValue,
    source: active ? 'project-setting' : 'repository',
    editable,
  };
}

/**
 * The model a task turn should run on, given the overlay and lazy.toml.
 *
 * Returns undefined when neither source has an opinion, which lets the caller
 * keep using `resolveAgentModel`'s own fallback rather than duplicating it —
 * a local ollama/proxy backend is authoritative over BOTH of these and must
 * still win.
 */
export function resolveProjectModel(
  settings: ProjectSettings | null,
  config: ResolvedConfig,
): string | undefined {
  const override = settings?.defaultModel;
  if (typeof override === 'string' && override.length > 0) return override;
  return config.models.default || undefined;
}

/**
 * The agent newly created tasks should run on, given the overlay and lazy.toml.
 *
 * Explicit create-time choices and `[agent.by_type]` still win — this is the
 * project-wide default only.
 */
export function resolveProjectAgent(
  settings: ProjectSettings | null,
  config: ResolvedConfig,
): string {
  const override = settings?.defaultAgent;
  if (typeof override === 'string' && override.length > 0) return override;
  return config.agent.agent_id;
}

/** Read the overlay, tolerating a store that has never had one written. */
export async function readProjectSettings(storage: Storage): Promise<ProjectSettings | null> {
  return storage.getProjectSettings();
}

/**
 * The project's selectable agent profiles, ordered for a picker.
 *
 * Never throws: a settings read is also what a UI uses to render the rest of
 * the page, and one bad `[agents.<name>]` block must not take the whole read
 * down. It WARNS rather than logging at debug for the same reason the
 * dashboard's own picker does — the degradation is a form offering a different
 * set of agents than the project configured, which nobody should have to turn
 * on debug logging to notice.
 */
function agentProfileChoices(config: ResolvedConfig): AgentProfileChoice[] {
  try {
    return selectableAgentProfiles(agentProfilesFor(config)).map((profile) => ({
      name: profile.name,
      harness: profile.harness,
      model: profile.model,
      builtin: profile.builtin,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Project settings: could not resolve agent profiles, reporting none: ${message}`);
    return [];
  }
}

/**
 * Compose the overlay and lazy.toml into the reportable, provenance-carrying
 * view a settings UI renders.
 */
export function effectiveProjectSettings(
  settings: ProjectSettings | null,
  config: ResolvedConfig,
): EffectiveProjectSettings {
  const result: EffectiveProjectSettings = {
    defaultAgent: setting(settings?.defaultAgent, config.agent.agent_id, true),
    defaultModel: setting(settings?.defaultModel, config.models.default, true),
    agentProfiles: agentProfileChoices(config),
    // Display-only: reported so the page can show the whole operational
    // picture, but the overlay does not carry them yet (design §11.4).
    runnerType: setting(undefined, config.runner.type, false),
    agentEffort: setting(undefined, config.agent.effort, false),
  };
  if (settings?.updatedAt) result.updatedAt = settings.updatedAt;
  if (settings?.updatedBy) result.updatedBy = settings.updatedBy;
  return result;
}

let settingsWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write the project settings record, serialized in-process.
 *
 * Two writers share the record — the settings form (`setProjectSettings`) and
 * the Start services designation — and each preserves the other's keys by
 * reading first. Unserialized, two concurrent saves could each read the old
 * record and the later write would silently drop the earlier change. The
 * daemon is the record's only writer, so one in-process queue is enough.
 */
export function updateProjectSettings(
  storage: Storage,
  update: (current: ProjectSettings | null) => ProjectSettings | null,
): Promise<ProjectSettings | null> {
  const run = settingsWriteChain.then(async () => {
    const next = update(await storage.getProjectSettings());
    if (next) await storage.saveProjectSettings(next);
    return next;
  });
  // The chain must survive a failed write; the caller still sees the error.
  settingsWriteChain = run.catch((err) => {
    logger.debug(`project settings write failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return run;
}
