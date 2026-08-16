/**
 * Shared helpers for suites running on the fake-`claude`-binary seam
 * (`setupTestLazy({ fakeClaude: true })`).
 *
 * These read the state a REAL supervisor produced — turns, session diagnostics,
 * task status — rather than anything a mock arranged. They live here because
 * more than one suite now runs on this seam and each was otherwise going to
 * re-derive the same "where does external storage put this task" logic.
 */

import { join } from 'path';
import { readFile, writeFile, readdir } from 'fs/promises';
import type { TestContext } from './setup';

/**
 * Set the two watchdog guards for the project, and COMMIT the change.
 *
 * Production defaults are 2h (no-progress) and 60s (wind-down) — far too long
 * for a test. These are the real config keys the daemon reads and puts on the
 * wire, so tightening them exercises the same plumbing a user would.
 *
 * The commit is not optional: the daemon resolves a turn's config from the
 * TASK WORKTREE (loadConfig(root, { cwd: worktreePath })), and the worktree is
 * branched from main. An uncommitted lazy.toml edit would simply never reach
 * the supervisor — the turn would run with the 2h default and the test would
 * time out with no useful signal.
 */
export async function setGuards(
  ctx: TestContext,
  guards: { noProgressMs?: number; windDownMs?: number },
): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  const lines = ['', '[agent]'];
  if (guards.noProgressMs !== undefined) lines.push(`watchdog_output_timeout_ms = ${guards.noProgressMs}`);
  if (guards.windDownMs !== undefined) lines.push(`wind_down_timeout_ms = ${guards.windDownMs}`);
  await writeFile(configPath, `${existing}\n${lines.join('\n')}\n`);
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', 'Tighten watchdog guards for this test');
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit watchdog guards: ${commit.stderr}`);
  }
}

/** Resolve a task's storage directory (external_path/tasks/<uuid…>). */
export async function taskDir(root: string, shortId: string): Promise<string> {
  const toml = await readFile(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  const tasksDir = m && m[1] ? join(m[1], 'tasks') : join(root, '.lazy', 'tasks');
  const dirs = await readdir(tasksDir);
  const dir = dirs.find(d => d.startsWith(shortId));
  if (!dir) throw new Error(`No task directory for ${shortId} in ${tasksDir}`);
  return join(tasksDir, dir);
}

/** The session record the daemon wrote for a task. */
export async function readSessionRecord(
  root: string,
  shortId: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'session.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The interrupt diagnostics the daemon recorded on a task's session. */
export async function sessionInterrupt(
  root: string,
  shortId: string,
): Promise<{ interrupt_reason?: string; interrupt_exit_code?: number | null }> {
  return await readSessionRecord(root, shortId) as {
    interrupt_reason?: string;
    interrupt_exit_code?: number | null;
  };
}

/** The agent turns recorded for a task, in order. */
export async function agentTurns(root: string, shortId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'turns.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { turns: Array<Record<string, unknown>> };
  return parsed.turns.filter(t => t.role === 'agent');
}

/** The task's current status, straight from storage. */
export async function taskStatus(root: string, shortId: string): Promise<string> {
  const raw = await readFile(join(await taskDir(root, shortId), 'task.json'), 'utf-8');
  return (JSON.parse(raw) as { status: string }).status;
}

/**
 * Poll storage until a task reaches one of `statuses`.
 *
 * `lazy wait` is the right tool for a turn the caller initiated, but it exits
 * as soon as the task leaves `working` — which on this seam is the INTERRUPTED
 * state, before the reconciler has had its chance to auto-resume. Tests about
 * autonomous recovery therefore have to watch storage across several turns
 * instead, and must not treat the intermediate `interrupted` as the end state.
 *
 * Throws (rather than returning) on timeout, with the last status observed —
 * a silent "never got there" is indistinguishable from a passing test.
 */
export async function waitForStatus(
  root: string,
  shortId: string,
  statuses: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '<unread>';
  while (Date.now() < deadline) {
    last = await taskStatus(root, shortId);
    if (statuses.includes(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `Task ${shortId} never reached ${statuses.join('|')} within ${timeoutMs}ms (last status: ${last})`,
  );
}

/** The prompt argv the fake agent received on each real turn, oldest first. */
export async function turnPrompts(ctx: TestContext): Promise<string[]> {
  const invocations = await ctx.claudeInvocations();
  return invocations
    .filter(i => i.argv.includes('-p'))
    .map(i => i.argv[i.argv.indexOf('-p') + 1] ?? '');
}
