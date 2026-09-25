/**
 * Guard: every launchSupervisor call site sets the runner's agent profile first.
 *
 * INVARIANT: a supervisor container's credential env is fixed at create time and
 * is chosen from the runner's agent PROFILE. Call sites that forgot
 * setRunnerAgentForTask / applyRunnerAgent passed undefined into
 * launchSupervisorAsync, which silently fell back to the default `claude-code`
 * profile. A cursor (or codex) task then got Anthropic env only — no
 * CURSOR_API_KEY — while the protocol command still said agent_id=cursor.
 * cursor-agent died with fatal_auth ("set CURSOR_API_KEY"), the session stamped
 * container_agent_id as cursor, and every later resume reused the wrongly wired
 * container. Sibling cursor tasks launched on paths that DID set the agent kept
 * working. That was the inform-the-task-when-a-subtask-is-accepted incident.
 *
 * The runners themselves also refuse to launch without a profile (fail-loud),
 * but a source scan catches a new call site before it ships.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';

const SRC = join(import.meta.dir, '../../src');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Files that DEFINE launchSupervisor — they are not call sites to guard. */
const DEFINITION_SUFFIXES = [
  join('runner', 'docker-runner.ts'),
  join('runner', 'host-process-runner.ts'),
  join('runner', 'types.ts'),
  // Interface / docs mentions only.
  join('runner', 'index.ts'),
];

describe('runner agent profile at launch coverage', () => {
  test('every launchSupervisor call site also sets the runner agent', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(SRC)) {
      if (DEFINITION_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
      const source = await readFile(file, 'utf-8');
      if (!source.includes('launchSupervisor(')) continue;

      // The file must both CALL launchSupervisor and SET the agent on the runner
      // via one of the two helpers every launch path is supposed to use.
      const setsAgent =
        source.includes('setRunnerAgentForTask(') || source.includes('applyRunnerAgent(');
      if (!setsAgent) {
        offenders.push(relative(SRC, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  test('DockerRunner and HostProcessRunner refuse a launch with no agent profile', async () => {
    // Pin the fail-loud branch by name so a future refactor that drops the
    // check (and relies only on the source scan above) is caught here too.
    for (const rel of [
      join('runner', 'docker-runner.ts'),
      join('runner', 'host-process-runner.ts'),
    ]) {
      const source = await readFile(join(SRC, rel), 'utf-8');
      expect(source, `${rel} lost the no-profile refusal`).toMatch(
        /launchSupervisor called without an agent profile/,
      );
    }
  });
});
