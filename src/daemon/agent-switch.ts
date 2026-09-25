/**
 * Agent-switch launch-identity resolution.
 *
 * "Agent" here is a PROFILE name (`[agents.<name>]` in lazy.toml): harness +
 * model + endpoint + credential. Switching to a profile on a different HARNESS
 * resets the session (sessions are not portable across agent binaries);
 * switching between two profiles of the same harness keeps it, because the
 * thing that would read `--resume <id>` has not changed.
 *
 * Model and effort are part of the same launch identity: a model id
 * under claude-code is not the same plan, quota, or price as the same string
 * under cursor, and effort is passed through to whichever agent CLI is next.
 * Carrying either across a switch silently asserts an equivalence that does
 * not exist (fix-agent-switch-resolution / the opus→cursor fatal_auth incident).
 *
 * Provenance: task.model and metadata.effort have no "explicit vs inherited"
 * flag — after the first launch they always hold the resolved concrete value.
 * Without that distinction, "chosen for THIS agent" is defined as "supplied in
 * the same write as the agent switch" (CLI `--model`/`--effort`, MCP fields).
 * A bare agent switch re-resolves both from scratch for the new agent.
 *
 * ONE helper, used by CLI edit, MCP edit, unblock, and start — not one copy
 * per surface. Callers announce the returned before/after values; a silent
 * change to what a task will cost is a hidden side effect.
 */

import type { Task } from '../types';
import type { Storage } from '../storage/interface';
import type { EffortLevel, ResolvedConfig } from '../config/types';
import { agentProfileOrThrow, agentProfilesFor, harnessForAgentName } from '../config/agent-profiles';
import { resolveAgentModel } from '../agent/agent-model';
import { resolveAndPersistEffort } from './effort';
import { displayId } from '../task/identity';

export interface SwitchTaskAgentParams {
  storage: Storage;
  task: Task;
  newAgentId: string;
  config: ResolvedConfig;
  /**
   * Explicit model for the NEW agent (same write as the switch). When absent,
   * the previous task.model is discarded and resolveAgentModel runs with no
   * preferred model so the new agent's default / project default decide.
   */
  modelOverride?: string;
  /**
   * Explicit effort for the NEW agent. When absent, any stored effort is
   * ignored and resolveAndPersistEffort falls through to the config default.
   */
  effortOverride?: string;
  /** Project-settings overlay; same slot launch paths pass to resolveAgentModel. */
  projectModel?: string | null;
}

export interface SwitchTaskAgentResult {
  previousAgent: string;
  agent: string;
  previousModel: string | null;
  model: string;
  previousEffort: string | undefined;
  effort: EffortLevel;
  /** True when the effective model string changed (or was newly set). */
  modelChanged: boolean;
  /** True when the effective effort string changed (or was newly set). */
  effortChanged: boolean;
  /** True when a session existed and its agent_session_id was cleared. */
  sessionReset: boolean;
  /**
   * True when a session existed and was KEPT — the two profiles run the same
   * harness, so the conversation is still resumable. Distinct from
   * `!sessionReset`, which is also true when there is no session at all.
   */
  sessionKept: boolean;
  /**
   * True when model/effort were re-derived (no co-supplied override) rather
   * than taken from an explicit flag on this write.
   */
  modelReResolved: boolean;
  effortReResolved: boolean;
}

/**
 * Refuse an agent switch while a supervisor turn is in flight. Clearing
 * `agent_session_id` mid-turn races the running turn writing it back when it
 * finishes (fix-edit-agent-status-gate).
 */
function assertAgentSwitchAllowed(task: Task): void {
  if (task.status === 'working') {
    throw new Error(
      `Cannot switch agent on task ${displayId(task)}: a turn is in flight (status: working). ` +
      `Wait for the task to block, or run \`lazy stop ${displayId(task)}\` then retry the switch.`,
    );
  }
}

/**
 * Persist an agent switch and re-resolve model/effort for the new agent.
 *
 * No-ops the identity fields when `newAgentId` already matches `task.agent_id`
 * — callers that only wanted a model/effort edit should not go through here.
 * Throws on an unknown agent id (same message shape as CLI/MCP validation).
 */
export async function switchTaskAgent(
  params: SwitchTaskAgentParams,
): Promise<SwitchTaskAgentResult> {
  const { storage, task, newAgentId, config } = params;
  const profiles = agentProfilesFor(config);
  agentProfileOrThrow(profiles, newAgentId, 'agent');

  const previousAgent = task.agent_id;
  const previousModel = task.model;
  const previousEffort = task.metadata?.effort;

  if (previousAgent === newAgentId) {
    throw new Error(
      `switchTaskAgent called with unchanged agent '${newAgentId}'. ` +
      `Use updateTaskModel / updateTaskMetadata for same-agent edits.`,
    );
  }

  // Before any storage write — a refused switch must leave agent_id and
  // agent_session_id untouched (see test/e2e/edit.test.ts).
  assertAgentSwitchAllowed(task);

  await storage.updateTaskAgent(task.id, newAgentId);
  task.agent_id = newAgentId;

  // A session is a HARNESS artifact, not a profile one: `--resume <id>` is
  // read by the agent binary, and only that binary's own session format can
  // make sense of it. So the reset is keyed on the harness changing, not on the
  // profile name changing — moving a task from `claude-code` to a second
  // claude-code profile aimed at another upstream keeps its conversation, the
  // same way changing `--model` alone always has. A previous profile that no
  // longer exists in lazy.toml resolves to no harness, and an unknown harness
  // resets: continuing a session we cannot prove is the same binary's would be
  // the unsafe direction of that guess.
  const previousHarness = harnessForAgentName(config, previousAgent);
  const newHarness = profiles.get(newAgentId)!.harness;
  const harnessChanged = previousHarness !== newHarness;

  let sessionReset = false;
  let sessionKept = false;
  const sess = await storage.getSessionByTaskId(task.id);
  if (sess) {
    // Second argument decides whether agent_session_id is cleared with the
    // rename; the session record's own agent_id tracks the PROFILE, so it is
    // rewritten either way and `lazy show` never names the old profile.
    await storage.updateSessionAgent(sess.id, newAgentId, harnessChanged);
    sessionReset = harnessChanged;
    sessionKept = !harnessChanged;
  }

  // --- Model ---
  // Explicit override = chosen for this agent on this write. Otherwise discard
  // the previous agent's stored model and let resolveAgentModel decide from
  // the new agent's default / project / config ladder (no preferredModel).
  const modelReResolved = params.modelOverride === undefined;
  const modelOverride = params.modelOverride?.trim();
  if (params.modelOverride !== undefined && !modelOverride) {
    throw new Error('Model name cannot be empty');
  }

  const model = resolveAgentModel(config, {
    ...(modelOverride ? { overrideModel: modelOverride } : { preferredModel: null }),
    agentId: newAgentId,
    projectModel: params.projectModel,
  });
  await storage.updateTaskModel(task.id, model);
  task.model = model;

  // --- Effort ---
  // Same rule: co-supplied override wins; otherwise drop the stored value so
  // resolveAndPersistEffort reads the config default for the new agent.
  const effortReResolved = params.effortOverride === undefined;
  if (effortReResolved && task.metadata?.effort !== undefined) {
    delete task.metadata.effort;
  }
  const effort = await resolveAndPersistEffort(
    task,
    params.effortOverride,
    config.agent.effort,
    storage,
  );

  return {
    previousAgent,
    agent: newAgentId,
    previousModel,
    model,
    previousEffort,
    effort,
    modelChanged: previousModel !== model,
    effortChanged: previousEffort !== effort,
    sessionReset,
    sessionKept,
    modelReResolved,
    effortReResolved,
  };
}

/**
 * Format the user-visible lines announcing what an agent switch did to model
 * and effort. Callers print these so a cost-changing re-resolve is never silent.
 */
export function formatAgentSwitchAnnouncement(result: SwitchTaskAgentResult): string[] {
  const lines: string[] = [];
  const sessionNote = result.sessionReset
    ? ' (takes effect next turn, session reset)'
    : result.sessionKept
      ? ' (takes effect next turn, same harness — session kept)'
      : ' (takes effect when started)';
  lines.push(`Updated agent: ${result.previousAgent} → ${result.agent}${sessionNote}`);

  if (result.modelChanged || result.modelReResolved) {
    const from = result.previousModel ?? '(none)';
    const why = result.modelReResolved
      ? 're-resolved for new agent'
      : 'set for new agent';
    lines.push(`  Model: ${from} → ${result.model} (${why})`);
  }

  if (result.effortChanged || result.effortReResolved) {
    const from = result.previousEffort ?? '(none)';
    const why = result.effortReResolved
      ? 're-resolved for new agent'
      : 'set for new agent';
    lines.push(`  Effort: ${from} → ${result.effort} (${why})`);
  }

  return lines;
}
