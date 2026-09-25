/**
 * The wrap-up's presentation step (final-turn design §6.2) — the human-facing
 * step that is also where the presentation REQUIREMENT is enforced.
 *
 * `lazy_final` cannot enforce the presentation: the tool runs before the step
 * that authors the thing, so a refusal there could never be satisfied. This
 * step is the enforcement point — it invokes the agent with the presentation
 * prompt, and the EXECUTOR (src/supervisor/wrap-up.ts) holds the turn until the
 * report on record carries a presentation. The runner here is the invocation
 * only; the marker check that enforces §6.2 belongs to the executor, where the
 * failure can fail the turn exactly as a failed wrap-up step does today.
 *
 * The prompt is static (src/prompts/present-regions.md), with ONE substituted
 * section: the §6.4 provenance hint, carved by the executor just before this
 * invocation and handed in as `provenanceHint` — a prompt section rather than
 * a tool parameter, because the agent should not have to know to ask. The
 * supervisor stays otherwise dumb, the agent inspects its own diff through the
 * lazy MCP tools, and the
 * template carries the escape ("a change of one or two files may be a single
 * group. The requirement is about coverage, not ceremony.").
 */

import type { Agent } from '../agent/interface';
import type { AgentResponse } from '../types';
import { computeRegionCover } from '../regions/compute';
import { renderProvenanceHint } from '../regions/hint';
import presentPrompt from '../prompts/present-regions.md' with { type: 'text' };
import { log, logError } from './log';
import { execWithWatchdog } from './watchdog';

export interface PresentStepResult {
  /** The prompt the invocation was sent — recorded on the supervised response. */
  prompt: string;
  /** The agent's response text (or the degraded text naming why it is degraded). */
  response: string;
  /** Agent session id the invocation reported (for session reconciliation). */
  session_id: string;
  /** Full token usage of the invocation (incl. cache tokens). */
  usage: AgentResponse['usage'];
  /** Concrete model id the agent reported for THIS invocation, when it reports one. */
  model_id?: string;
  /**
   * True when the invocation failed (non-zero exit or unparseable response).
   * The executor still checks the declaration marker — an agent can declare
   * and then crash — but a failed invocation with no declaration is a
   * distinguishable cause for the error the turn fails with.
   */
  failed?: boolean;
}

/** Zero-usage fallback for a failed invocation (no agent tokens were spent). */
const ZERO_USAGE: AgentResponse['usage'] = { input_tokens: 0, output_tokens: 0 };

/**
 * Run the presentation step's invocation, resuming the wrap-up's session so the
 * whole wrap-up stays one conversation. Single-shot — the step never re-prompts.
 */
export async function runPresentStep(
  agent: Agent,
  worktreePath: string,
  sessionId: string,
  modelId?: string,
  effort?: string,
  /**
   * Host OS-sandbox `--settings` (and any other argv) from
   * `commonCommandFields.agent_extra_args`. Same path work/maintain use.
   */
  extraArgs?: string[],
  /**
   * §6.4 provenance hint, carved by the executor (carveProvenanceHint) and
   * delivered INTO the prompt — a prompt section rather than a tool
   * parameter, because the agent should not have to know to ask. Empty (the
   * carve failed or found no units) collapses the prompt's hint section to
   * its standing prose.
   */
  provenanceHint?: string,
): Promise<PresentStepResult> {
  const prompt = presentPrompt.replace('{{provenance_hint}}', provenanceHint ?? '');
  log(`[present] Resuming session ${sessionId.substring(0, 8)}... for the presentation step`);

  const claudeArgs = agent.buildExecArgs({
    prompt,
    sessionId,
    dangerouslySkipPermissions: true,
    modelId,
    effort,
    extraArgs,
  });

  const { stdout, stderr, exitCode } = await execWithWatchdog(claudeArgs, {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    // Authoring the walkthrough can involve real work (reading the diff,
    // restructuring the report), so it gets the same watchdog as every
    // wrap-up invocation — without one a hung step hangs the supervisor forever.
    timeoutMs: 600_000, // 10 minutes
  });

  if (exitCode !== 0) {
    logError(`[present] Agent exited with code ${exitCode}`);
    logError(`[present] stderr: ${stderr.slice(-500)}`);
    return {
      prompt,
      response: 'Presentation step failed: agent exited with an error.',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }

  try {
    const parsed = agent.parseResponse(stdout, { workingDir: worktreePath });
    log(`[present] Agent responded (${parsed.result.length} chars)`);
    return {
      prompt,
      response: parsed.result,
      session_id: parsed.session_id,
      usage: parsed.usage,
      ...(parsed.model_id ? { model_id: parsed.model_id } : {}),
    };
  } catch (err) {
    logError(`[present] Failed to parse response: ${err instanceof Error ? err.message : err}`);
    return {
      prompt,
      response: 'Presentation step failed: could not parse agent response.',
      session_id: sessionId,
      usage: { ...ZERO_USAGE },
      failed: true,
    };
  }
}
/**
 * The §6.4 provenance hint, carved by the executor just before it invokes the
 * presentation step and handed to it as a prompt section.
 *
 * Carved fresh HERE — at present time, at HEAD — rather than at plan time in
 * the daemon: the wrap-up's earlier steps (the maintain and react nudges) may
 * still commit, so a cover carved at plan assembly time would hint at a head
 * the agent is no longer looking at. The supervisor has no storage and wants
 * no enrichment, so this is a plain `computeRegionCover` over the same range
 * every other wrap-up scan runs (`scanStart`, the base the daemon resolved)
 * — the carve is THROWAWAY: the agent's own `lazy_regions` provenance read
 * carves (and stores) again on demand, deduped by `<task>@<head>`.
 *
 * Advisory by design (§6.4): a carve that throws must never fail the
 * presentation step, so this swallows with a log and returns '' — the
 * prompt's hint section collapses to its standing prose. The first carve on
 * a release hub can take tens of seconds; it is bounded by compute.ts' own
 * region limits and the 60s spawn timeout on every git call it makes, and
 * runs once per wrap-up turn, inside the step's own 10-minute watchdog
 * budget.
 */
export async function carveProvenanceHint(
  worktreePath: string,
  taskId: string,
  scanStart: string,
): Promise<string> {
  try {
    const cover = await computeRegionCover({
      cwd: worktreePath,
      taskId,
      baseRef: scanStart,
      headRef: 'HEAD',
    });
    return renderProvenanceHint(cover);
  } catch (err) {
    log(`[present] Provenance hint carve skipped: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}
