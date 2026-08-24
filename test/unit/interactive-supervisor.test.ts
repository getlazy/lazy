/**
 * Unit tests: the interactive-session supervisor.
 *
 * `lazy pair` and `lazy chat` used to spawn Claude Code directly, which made an
 * interactive session the one child of the daemon with nobody watching it — a
 * daemon restart moved the audit proxy to a new OS-assigned port and the session
 * talked to the dead one until the human noticed every model call failing. The
 * supervisor watches the daemon generation and relaunches the conversation in
 * place. See src/supervisor/interactive.ts.
 *
 * `spawn`, the interactive-launch seam and the registry are module-mocked so
 * nothing here starts a real Claude Code or touches the daemon; the generation
 * watch is real and driven through the injected status reader.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import type { DaemonStatus } from '../../src/daemon/lifecycle';

const SPAWN_PATH = resolve(import.meta.dir, '../../src/utils/spawn.ts');
const AUTH_PATH = resolve(import.meta.dir, '../../src/cli/interactive-auth.ts');
const REGISTRY_PATH = resolve(import.meta.dir, '../../src/daemon/interactive-registry.ts');

interface Launch {
  argv: string[];
  env: Record<string, string | undefined>;
  signals: string[];
  resolveExit: (code: number) => void;
}

interface Harness {
  launches: Launch[];
  registered: number;
  unregistered: number;
  /** What each register call claimed the session was. */
  registeredKinds: string[];
}

/**
 * Install the mocks and return the supervisor entry point.
 *
 * `exitPlan[i]` decides what launch `i` does: `'wait'` blocks until something
 * kills it (which is how a real session behaves), `'exit'` ends immediately with
 * code 0 (the human quitting).
 */
async function harness(opts: {
  exitPlan: Array<'wait' | 'exit'>;
  /** Throw from resolveInteractiveLaunch on this launch index (0-based). */
  failResolveAt?: number;
}): Promise<{
  runInteractiveSupervisor: typeof import('../../src/supervisor/interactive').runInteractiveSupervisor;
  state: Harness;
}> {
  const state: Harness = { launches: [], registered: 0, unregistered: 0, registeredKinds: [] };

  await mockModule(SPAWN_PATH, () => ({
    spawn: (argv: string[], o: { env: Record<string, string | undefined> }) => {
      const index = state.launches.length;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(r => { resolveExit = r; });
      const launch: Launch = { argv, env: o.env, signals: [], resolveExit };
      state.launches.push(launch);
      if (opts.exitPlan[index] === 'exit') resolveExit(0);
      return {
        exited,
        kill: (sig: string) => {
          launch.signals.push(sig);
          resolveExit(0);
        },
      };
    },
    spawnSyncUnsupervised: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
    DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
  }));

  await mockModule(AUTH_PATH, () => ({
    resolveInteractiveLaunch: async () => {
      if (opts.failResolveAt === state.launches.length) {
        throw new Error('daemon proxy unavailable');
      }
      // A fresh address on every resolution — the whole point of re-resolving.
      return {
        target: { model: undefined },
        envVars: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${9000 + state.launches.length}/` },
      };
    },
    launchEnvOverlay: (envVars: Record<string, string>) => ({ ...envVars }),
  }));

  await mockModule(REGISTRY_PATH, () => ({
    INTERACTIVE_SESSIONS_DIR: 'interactive-sessions',
    registerInteractiveSession: async (_root: string, info: { kind: string }) => {
      state.registered++;
      state.registeredKinds.push(info.kind);
      return { pid: process.pid };
    },
    unregisterInteractiveSession: async () => { state.unregistered++; },
    listInteractiveSessions: async () => [],
    describeInteractiveSession: () => '',
  }));

  const { runInteractiveSupervisor } = await import('../../src/supervisor/interactive');
  return { runInteractiveSupervisor, state };
}

/** Status reader that reports one daemon for `changeAfterReads` polls, then another. */
function generationReader(changeAfterReads: number): (root: string) => Promise<DaemonStatus> {
  let reads = 0;
  return async () => {
    const instanceId = reads++ < changeAfterReads ? 'gen-1' : 'gen-2';
    return { running: true, pid: 1, buildTime: 'dev', uptime: 10, instanceId };
  };
}

const base = {
  kind: 'pair' as const,
  root: '/proj',
  cwd: '/proj/wt',
  taskId: 'abcd1234',
  generationPollMs: 5,
  stopGraceMs: 60_000,
  log: () => {},
  errorOut: () => {},
};

afterAll(() => {
  restoreMockedModules();
});

describe('runInteractiveSupervisor', () => {
  test('a daemon restart stops Claude Code and resumes the conversation in place', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['wait', 'exit'] });

    const result = await runInteractiveSupervisor({
      ...base,
      resumeSessionId: 'sess-A',
      readStatus: generationReader(1),
    });

    expect(state.launches.length).toBe(2);
    expect(result.restarts).toBe(1);

    // INVARIANT: never SIGKILL. The child owns unsaved session state, and the
    // point of stopping is to hand the session back intact.
    expect(state.launches[0]!.signals).toEqual(['SIGTERM']);

    // The conversation continues rather than starting over.
    expect(state.launches[1]!.argv).toContain('--resume');
    expect(state.launches[1]!.argv).toContain('sess-A');
  });

  // INVARIANT: this is the actual fix. The child's ANTHROPIC_BASE_URL is baked in
  // at spawn and Claude Code never re-reads it, so a relaunch that reused the old
  // launch env would resume straight back onto the dead proxy port.
  test('the relaunch resolves a fresh proxy address rather than reusing the old one', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['wait', 'exit'] });

    await runInteractiveSupervisor({ ...base, readStatus: generationReader(1) });

    const first = state.launches[0]!.env.ANTHROPIC_BASE_URL;
    const second = state.launches[1]!.env.ANTHROPIC_BASE_URL;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  test('a session the human ends is not relaunched', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['exit'] });

    const result = await runInteractiveSupervisor({
      ...base,
      // Same daemon throughout: nothing to react to.
      readStatus: async () => ({ running: true, pid: 1, instanceId: 'gen-1' }),
    });

    expect(state.launches.length).toBe(1);
    expect(result.restarts).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  // INVARIANT: the registry is how `lazy upgrade` and the daemon can see a pair
  // session at all (host processes are invisible to runner discovery). An entry
  // that outlives its session would warn about a session that is not there.
  test('the session is registered for the run and unregistered on the way out', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['exit'] });

    await runInteractiveSupervisor({
      ...base,
      readStatus: async () => ({ running: true, pid: 1, instanceId: 'gen-1' }),
    });

    expect(state.registered).toBe(1);
    expect(state.unregistered).toBe(1);
  });

  // INVARIANT: no bypass. A child that cannot reach the audit plane must not be
  // launched at all — relaunching into a dead endpoint would make every model
  // call fail, and falling back to a direct Anthropic connection would take the
  // session outside the audit plane entirely.
  test('a relaunch that cannot resolve the new daemon fails instead of guessing', async () => {
    const { runInteractiveSupervisor, state } = await harness({
      exitPlan: ['wait'],
      failResolveAt: 1,
    });
    const errors: string[] = [];

    const result = await runInteractiveSupervisor({
      ...base,
      resumeSessionId: 'sess-A',
      readStatus: generationReader(1),
      errorOut: (m: string) => errors.push(m),
    });

    expect(state.launches.length).toBe(1);
    expect(result.exitCode).toBe(1);
    // The human is told how to get back in, with the session id.
    expect(errors.join('\n')).toContain('lazy pair abcd1234 --resume sess-A');
    // And the registry entry does not outlive the failure.
    expect(state.unregistered).toBe(1);
  });

  test('a failure on the FIRST launch propagates to the caller unchanged', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['wait'], failResolveAt: 0 });

    await expect(runInteractiveSupervisor({
      ...base,
      readStatus: async () => ({ running: true, pid: 1, instanceId: 'gen-1' }),
    })).rejects.toThrow('daemon proxy unavailable');
    expect(state.launches.length).toBe(0);
    expect(state.unregistered).toBe(1);
  });
});

// ONE SUPERVISOR, TWO SURFACES. `lazy chat` is a supervised session too, and it
// differs from `lazy pair` only in what argv Claude Code is handed and what env
// it carries. Those travel as DATA on the config, so the restart machinery above
// applies to chat unchanged — but the argv is the part most likely to be
// silently dropped in the move, and dropping it would take chat's read-only
// lockdown with it.
describe('runInteractiveSupervisor — chat', () => {
  const chatArgs = [
    '--permission-mode', 'plan',
    '--disallowedTools', 'Bash Write Edit',
    '--append-system-prompt', 'you are a chat',
    '--effort', 'medium',
  ];

  test('chat argv and LAZY_TASK survive the launch, and again across a restart', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['wait', 'exit'] });

    await runInteractiveSupervisor({
      ...base,
      kind: 'chat',
      resumeSessionId: 'chat-sess',
      extraArgs: chatArgs,
      extraEnv: { LAZY_TASK: 'abcd1234' },
      readStatus: generationReader(1),
    });

    expect(state.launches.length).toBe(2);
    for (const launch of state.launches) {
      // The read-only lockdown must land on EVERY launch, including the one
      // after a daemon restart — a relaunch that lost it would hand the human a
      // chat session that can write to their repo.
      for (const arg of chatArgs) expect(launch.argv).toContain(arg);
      expect(launch.env.LAZY_TASK).toBe('abcd1234');
    }

    // Order matters: extras sit after --resume, exactly as the pre-supervisor
    // chat command composed them.
    expect(state.launches[0]!.argv).toEqual(['claude', '--resume', 'chat-sess', ...chatArgs]);
  });

  test('a chat session registers as chat, not as a pair session', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['exit'] });

    await runInteractiveSupervisor({
      ...base,
      kind: 'chat',
      extraArgs: chatArgs,
      readStatus: async () => ({ running: true, pid: 1, instanceId: 'gen-1' }),
    });

    expect(state.registeredKinds).toEqual(['chat']);
  });

  test('the failure hint names the right command', async () => {
    const { runInteractiveSupervisor } = await harness({ exitPlan: ['wait'], failResolveAt: 1 });
    const errors: string[] = [];

    await runInteractiveSupervisor({
      ...base,
      kind: 'chat',
      extraArgs: chatArgs,
      readStatus: generationReader(1),
      errorOut: (m: string) => errors.push(m),
    });

    expect(errors.join('\n')).toContain('lazy chat');
    expect(errors.join('\n')).not.toContain('lazy pair');
  });
});

// INVARIANT: a spurious restart is worse than a missed one, because the human is
// watching their own terminal. A baseline read that FAILS says nothing about
// whether the daemon changed — treating it as "no daemon was running" would make
// the next healthy poll look like a restart and SIGTERM a perfectly good session.
describe('runInteractiveSupervisor — generation baseline', () => {
  test('a transient baseline failure does not manufacture a restart', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['exit'] });
    let reads = 0;

    await runInteractiveSupervisor({
      ...base,
      readStatus: async () => {
        // First read blows up (daemon momentarily unreachable); every read after
        // it reports the SAME daemon that was there all along.
        if (reads++ === 0) throw new Error('connection refused');
        return { running: true, pid: 1, instanceId: 'gen-1' };
      },
    });

    expect(state.launches.length).toBe(1);
    expect(state.launches[0]!.signals).toEqual([]);
  });

  test('a baseline that never reads defers to the watch, which re-baselines', async () => {
    const { runInteractiveSupervisor, state } = await harness({ exitPlan: ['wait', 'exit'] });
    let reads = 0;

    // Baseline never succeeds (3 attempts), so it is UNKNOWN. The watch then
    // takes its own baseline on its first successful poll — gen-1 — and only the
    // later change to gen-2 counts as a restart.
    const result = await runInteractiveSupervisor({
      ...base,
      readStatus: async () => {
        if (reads++ < 3) throw new Error('connection refused');
        return { running: true, pid: 1, instanceId: reads < 8 ? 'gen-1' : 'gen-2' };
      },
    });

    expect(result.restarts).toBe(1);
    expect(state.launches.length).toBe(2);
  });
});

describe('interactiveClaudeArgs', () => {
  test('a fresh session is a bare `claude`', async () => {
    const { interactiveClaudeArgs } = await import('../../src/supervisor/interactive');
    expect(interactiveClaudeArgs({})).toEqual(['claude']);
  });

  test('resume, autonomous and model are all threaded through', async () => {
    const { interactiveClaudeArgs } = await import('../../src/supervisor/interactive');
    expect(interactiveClaudeArgs({ resumeSessionId: 's1', autonomous: true, model: 'opus' }))
      .toEqual(['claude', '--resume', 's1', '--dangerously-skip-permissions', '--model', 'opus']);
  });

  test('extraArgs land after the supervisor flags and before --model', async () => {
    const { interactiveClaudeArgs } = await import('../../src/supervisor/interactive');
    expect(interactiveClaudeArgs({ resumeSessionId: 's1', extraArgs: ['--effort', 'high'], model: 'opus' }))
      .toEqual(['claude', '--resume', 's1', '--effort', 'high', '--model', 'opus']);
  });
});
