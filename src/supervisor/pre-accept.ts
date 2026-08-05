/**
 * Pre-accept step — the final agent turn before a task's merge.
 *
 * This module has two halves that run on different sides of the protocol:
 *
 *   - `renderPreAcceptPrompt` runs HOST-side (the daemon accept path). It builds
 *     the fully-rendered turn prompt from config (gate commands + maintained-file
 *     groups) so the supervisor stays dumb — it just runs what it's told.
 *
 *   - `runPreAcceptGate` runs SUPERVISOR-side, after the agent's turn. It re-runs
 *     the configured gate commands as the AUTHORITATIVE merge gate: the agent may
 *     have fixed and committed, but the agent cannot self-certify — this
 *     independent run decides pass/fail, so a failing suite can never merge.
 *
 * The built-in post-mortem is part of the rendered prompt (step 3), not a config
 * knob: every pre-accept turn asks the agent to journal a short retrospective.
 */

import type { MaintainEntry } from '../config/types';
import { runPostTurnCheck } from './post-turn-check';
import { truncateLog } from '../utils/log-truncate';
import { log, logWarn } from './log';
import preAcceptTemplate from '../prompts/pre-accept.md' with { type: 'text' };

/** Default per-command timeout for the gate (seconds). */
export const DEFAULT_PRE_ACCEPT_TIMEOUT_SECS = 600;

/** Render a maintained group as a "- <title> (<pattern>): <instructions>" line. */
function renderMaintainEntries(entries: MaintainEntry[]): string {
  return entries.map(e => `- ${e.title} (${e.pattern}): ${e.instructions}`).join('\n');
}

/**
 * Split the template into its `<!-- SECTION: name -->`-delimited pieces. All
 * prompt prose lives in pre-accept.md; the renderer only chooses which sections
 * to include and how to number them.
 */
function parseSections(template: string): Record<string, string> {
  const parts = template.split(/<!-- SECTION: (\w+) -->\n/);
  const sections: Record<string, string> = {};
  // parts[0] is the (empty) text before the first marker; the rest alternate
  // between a captured section name and that section's body.
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]] = parts[i + 1].trim();
  }
  return sections;
}

/** Prepend a `## N. ` heading to a step whose first line is its bare title. */
function numberStep(body: string, n: number): string {
  const nl = body.indexOf('\n');
  const title = (nl === -1 ? body : body.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : body.slice(nl + 1).trim();
  return rest ? `## ${n}. ${title}\n\n${rest}` : `## ${n}. ${title}`;
}

/**
 * Render the pre-accept turn prompt from config. Called host-side so the
 * supervisor receives a ready-to-run prompt with no config knowledge.
 *
 * The ONLY built-in behavior is the journaled post-mortem — it is always the
 * final step. Every other instruction comes from configuration: the acceptance
 * checks step is included only when `[automation.pre_accept] commands` are set,
 * and the maintained-files step only when `[[automation.maintain]]` groups
 * exist. Absent config means the section is OMITTED entirely (no filler prose),
 * and the remaining steps renumber so the turn reads naturally. With nothing
 * configured, the turn is the post-mortem alone.
 */
export function renderPreAcceptPrompt(
  commands: string[],
  maintainEntries: MaintainEntry[],
): string {
  const s = parseSections(preAcceptTemplate);
  const steps: string[] = [];

  if (commands.length > 0) {
    steps.push(s.commands.replace('{{commands_list}}', commands.map(c => `- \`${c}\``).join('\n')));
  }
  if (maintainEntries.length > 0) {
    steps.push(s.maintain.replace('{{maintain_list}}', renderMaintainEntries(maintainEntries)));
  }
  // Built-in, unconditional: the post-mortem is always the last step.
  steps.push(s.postmortem);

  const numbered = steps.map((body, i) => numberStep(body, i + 1)).join('\n\n');
  return `${s.intro}\n\n${numbered}\n\n${s.outro}\n`;
}

export interface PreAcceptGateResult {
  passed: boolean;
  /** The first command that exited non-zero (undefined when passed). */
  failedCommand?: string;
  /** Exit code of the failed command (-1 exec error, -2 timeout). */
  exitCode?: number;
  /** Captured output of the failed command (truncated). */
  output?: string;
}

/**
 * Run the gate commands in order, stopping at the first non-zero exit. This is
 * the authoritative pass/fail decision for the merge — run AFTER the agent's
 * pre-accept turn (which had its chance to fix failures and commit).
 *
 * An empty command list passes trivially (post-mortem-only turn).
 */
export async function runPreAcceptGate(
  commands: string[],
  worktreePath: string,
  timeoutSecs: number = DEFAULT_PRE_ACCEPT_TIMEOUT_SECS,
): Promise<PreAcceptGateResult> {
  if (commands.length === 0) {
    log('[pre-accept] No gate commands configured — gate passes trivially');
    return { passed: true };
  }

  for (const command of commands) {
    log(`[pre-accept] Running gate command: "${command}" (timeout: ${timeoutSecs}s)`);
    try {
      const result = await runPostTurnCheck(command, worktreePath, timeoutSecs * 1000);
      if (result.timedOut) {
        const output = `Command timed out after ${timeoutSecs}s (killed with ${result.killSignal ?? 'SIGTERM'} after ${result.elapsedMs}ms)\n\n--- stderr at timeout ---\n${truncateLog(result.stderr)}`;
        logWarn(`[pre-accept] Gate command timed out: "${command}"`);
        return { passed: false, failedCommand: command, exitCode: -2, output };
      }
      if (result.exitCode !== 0) {
        logWarn(`[pre-accept] Gate command failed (exit ${result.exitCode}): "${command}"`);
        return {
          passed: false,
          failedCommand: command,
          exitCode: result.exitCode,
          output: truncateLog(result.stderr),
        };
      }
      log(`[pre-accept] Gate command passed: "${command}" (${result.elapsedMs}ms)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[pre-accept] Gate command failed to execute: "${command}": ${message}`);
      return { passed: false, failedCommand: command, exitCode: -1, output: message };
    }
  }

  return { passed: true };
}
