/**
 * Unit tests: in-container builder continuity across daemon restarts.
 *
 * INVARIANT: when the daemon generation changes, the supervisor stops Claude,
 * refreshes launch env, and relaunches with `--resume <id>` — not a fresh session.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import type { DaemonStatus } from '../../src/daemon/lifecycle';

const SPAWN_PATH = resolve(import.meta.dir, '../../src/utils/spawn.ts');
const SUPERVISOR_BUILDER_PATH = resolve(import.meta.dir, '../../src/supervisor/builder.ts');
const CONTINUITY_PATH = resolve(import.meta.dir, '../../src/builder/continuity.ts');

const gen1 = (): DaemonStatus => ({
  running: true,
  pid: 100,
  instanceId: 'gen-1',
  version: '0.22.1140',
});

const gen2 = (): DaemonStatus => ({
  running: true,
  pid: 200,
  instanceId: 'gen-2',
  version: '0.22.1141',
});

describe('runBuilderWithContinuity', () => {
  afterEach(() => {
    restoreMockedModules();
  });

  test('relaunches with --resume after a daemon generation change', async () => {
    const launches: string[][] = [];
    let pollCount = 0;
    let finishFirst: ((code: number) => void) | undefined;

    await mockModule(SPAWN_PATH, () => ({
      spawn: (args: string[]) => {
        launches.push([...args]);
        if (launches.length === 1) {
          return {
            exited: new Promise<number>((resolve) => { finishFirst = resolve; }),
            kill: () => { finishFirst?.(0); },
          };
        }
        return { exited: Promise.resolve(17), kill: () => {} };
      },
      spawnSyncUnsupervised: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const realSupervisor = await import(SUPERVISOR_BUILDER_PATH);
    await mockModule(SUPERVISOR_BUILDER_PATH, () => ({
      ...realSupervisor,
      preflightAgentBinaryWithRetry: async () => {},
    }));

    const { runBuilderWithContinuity } = await import(CONTINUITY_PATH);

    const readStatus = async (): Promise<DaemonStatus> => {
      pollCount += 1;
      // Baseline at loop start + first watch poll stay on gen-1; next poll is the restart.
      return pollCount <= 2 ? gen1() : gen2();
    };

    const resultPromise = runBuilderWithContinuity({
      daemonConfigPath: '/tmp/daemon-mcp.json',
      projectRoot: '/proj',
      worktreePath: '/proj',
      baseEnv: { HOME: '/home/user' },
      log: () => {},
      errorOut: () => {},
      readStatus,
      fetchLaunchEnv: async () => ({
        authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:9999' }],
        lazyVersion: '0.22.1141',
      }),
      resolveResumeId: async () => 'session-resume-abc',
      pollMs: 5,
      sleep: async () => {},
      buildClaudeArgs: (resumeId: string | null) => {
        const args = ['claude', '--verbose'];
        if (resumeId) args.push('--resume', resumeId);
        return args;
      },
    });

    // Let the generation watch poll and observe the restart.
    await new Promise((r) => setTimeout(r, 30));

    const result = await resultPromise;

    expect(result.restarts).toBe(1);
    expect(result.exitCode).toBe(17);
    expect(launches).toHaveLength(2);
    expect(launches[0]).not.toContain('--resume');
    expect(launches[1]).toEqual(['claude', '--verbose', '--resume', 'session-resume-abc']);
  });

  test('passes through exit code when the daemon generation is unchanged', async () => {
    const launches: string[][] = [];

    await mockModule(SPAWN_PATH, () => ({
      spawn: (args: string[]) => {
        launches.push([...args]);
        return { exited: Promise.resolve(9), kill: () => {} };
      },
      spawnSyncUnsupervised: () => ({ exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }),
      DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
    }));

    const realSupervisor = await import(SUPERVISOR_BUILDER_PATH);
    await mockModule(SUPERVISOR_BUILDER_PATH, () => ({
      ...realSupervisor,
      preflightAgentBinaryWithRetry: async () => {},
    }));

    const { runBuilderWithContinuity } = await import(CONTINUITY_PATH);

    const result = await runBuilderWithContinuity({
      daemonConfigPath: '/tmp/daemon-mcp.json',
      projectRoot: '/proj',
      worktreePath: '/proj',
      baseEnv: {},
      log: () => {},
      errorOut: () => {},
      readStatus: async () => gen1(),
      fetchLaunchEnv: async () => ({ authEnvVars: [] }),
      pollMs: 50,
      sleep: async () => {},
      buildClaudeArgs: () => ['claude'],
    });

    expect(result).toEqual({ exitCode: 9, restarts: 0 });
    expect(launches).toHaveLength(1);
  });
});
