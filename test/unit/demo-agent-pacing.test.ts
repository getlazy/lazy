/**
 * The playground stand-in agent's pacing knob.
 *
 * INVARIANT: a playground turn does not report the instant it starts. It waits
 * the installed pacing, emitting heartbeats the activity parser recognises,
 * before its result — otherwise a person watching sees a task jump from created
 * to blocked with "working" never on screen. Pacing defaults to a few seconds,
 * `LAZY_PLAYGROUND_AGENT_PACING_MS` overrides it, and 0 turns it off.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCodeActivityStream } from '../../src/agent/activity-stream';
import {
  DEFAULT_DEMO_PACING_MS,
  DEMO_PACING_ENV,
  installDemoAgent,
  resolveDemoPacingMs,
} from '../../src/demo/agent';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

/** Run one unscripted turn of an installed agent inside a fresh git repo. */
async function runTurn(pacingMs: number, workTurn = true): Promise<{ elapsedMs: number; events: Record<string, unknown>[] }> {
  const agentDir = await tempDir('demo-agent-');
  const { binPath } = await installDemoAgent(agentDir, { pacingMs });
  const repo = await tempDir('demo-agent-repo-');
  const init = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: repo });
  expect(init.exitCode).toBe(0);

  const started = Date.now();
  const proc = Bun.spawn([binPath, '-p', ...(workTurn ? ['--append-system-prompt', 'system'] : [])], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const elapsedMs = Date.now() - started;
  expect({ code, err }).toEqual({ code: 0, err: '' });

  return { elapsedMs, events: out.trim().split('\n').map(line => JSON.parse(line)) };
}

describe('playground agent pacing', () => {
  test('defaults to a few seconds, is overridden by the env var, and refuses nonsense', () => {
    expect(resolveDemoPacingMs({})).toBe(DEFAULT_DEMO_PACING_MS);
    expect(DEFAULT_DEMO_PACING_MS).toBeGreaterThanOrEqual(1000);
    expect(resolveDemoPacingMs({ [DEMO_PACING_ENV]: '0' })).toBe(0);
    expect(resolveDemoPacingMs({ [DEMO_PACING_ENV]: ' 750 ' })).toBe(750);
    expect(() => resolveDemoPacingMs({ [DEMO_PACING_ENV]: '3s' })).toThrow(DEMO_PACING_ENV);
    expect(() => resolveDemoPacingMs({ [DEMO_PACING_ENV]: '-5' })).toThrow(DEMO_PACING_ENV);
  });

  test('a paced turn waits, heartbeating, before it reports', async () => {
    const { elapsedMs, events } = await runTurn(1500);

    expect(elapsedMs).toBeGreaterThanOrEqual(1500);
    const kinds = events.map(e => new ClaudeCodeActivityStream().parseLine(JSON.stringify(e))?.kind);
    expect(kinds).toContain('heartbeat');
    expect(kinds.indexOf('heartbeat')).toBeLessThan(kinds.indexOf('result'));
    expect(kinds[kinds.length - 1]).toBe('result');
  });

  // INVARIANT: only the invocation that opens a work turn is paced. Review and
  // walkthrough steps, and accept's description one-shot, must not each wait.
  test('an invocation that does not open a work turn is not paced', async () => {
    const { elapsedMs, events } = await runTurn(3000, false);
    expect(elapsedMs).toBeLessThan(2500);
    expect(events.map(e => e.type)).not.toContain('tool_progress');
  });

  test('pacing 0 reports without heartbeats', async () => {
    const { events } = await runTurn(0);
    expect(events.map(e => e.type)).not.toContain('tool_progress');
    expect(events[events.length - 1].type).toBe('result');
  });
});
