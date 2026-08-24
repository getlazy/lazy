/**
 * Unit tests for project-scoped runner discovery used by `lazy upgrade`.
 *
 * INVARIANT: `lazy upgrade` run in project A must NEVER enumerate or stop
 * containers belonging to project B. Builder containers have no matching
 * task in storage, so without a project-scoped filter they would leak
 * across projects and `lazy upgrade` would stop other projects' builders.
 *
 * The regression these tests guard against: running `lazy upgrade` in
 * project A would print `Stopping N container(s)...` and kill every
 * `lazy-builder-*` container running anywhere on the host.
 */

import { describe, test, expect, beforeEach, mock, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// Capture the args of every spawn invocation so we can assert that the
// Docker discovery query carries the project label filter.
interface RecordedCall {
  cmd: string[];
}

const recordedCalls: RecordedCall[] = [];
let mockStdout = '';
let mockExitCode = 0;

await mockModule(resolve(import.meta.dir, '../../src/utils/spawn.ts'), () => ({
  DEFAULT_SUBPROCESS_TIMEOUT_MS: 60_000,
  spawnSyncUnsupervised: () => {
    throw new Error('spawnSyncUnsupervised() not expected in these tests');
  },
  spawn: (cmd: string[], _options: unknown) => {
    recordedCalls.push({ cmd });
    return {
      stdout: new Response(mockStdout).body,
      stderr: new Response('').body,
      exited: Promise.resolve(mockExitCode),
    };
  },
}));

// Import after mocks are installed.
const { DockerRunner, PROJECT_LABEL } = await import('../../src/runner/docker-runner');
const { HostProcessRunner } = await import('../../src/runner/host-process-runner');

describe('DockerRunner.discoverProjectBuilderRuns', () => {
  beforeEach(() => {
    recordedCalls.length = 0;
    mockStdout = '';
    mockExitCode = 0;
  });

  // INVARIANT: discovery filters by BOTH the lazy-builder- name prefix AND
  // the lazy.project label. Dropping either filter would let containers
  // from other projects leak into the result set.
  test('filters docker ps by name prefix AND project label', async () => {
    const runner = new DockerRunner('docker');
    await runner.discoverProjectBuilderRuns('/home/user/prg/project-a');

    expect(recordedCalls).toHaveLength(1);
    const { cmd } = recordedCalls[0]!;
    expect(cmd[0]).toBe('docker');
    expect(cmd[1]).toBe('ps');

    // Both filters must be present — a name-only filter would match other
    // projects' builders; a label-only filter could miss task supervisors.
    const filters: string[] = [];
    for (let i = 0; i < cmd.length - 1; i++) {
      if (cmd[i] === '--filter') filters.push(cmd[i + 1]!);
    }
    expect(filters).toContain('name=^lazy-builder-');
    expect(filters).toContain(`label=${PROJECT_LABEL}=/home/user/prg/project-a`);
  });

  // INVARIANT: `lazy upgrade` in project A must never list builders from
  // project B. Since we filter on the `lazy.project` label server-side,
  // project B's builders never appear in the result even when docker ps
  // returns nothing (as it would when the filter excludes them).
  test('returns only containers that docker ps returns (project-scoped)', async () => {
    const runner = new DockerRunner('docker');

    // Simulate docker ps returning only project A's builder — this is what
    // `docker ps --filter label=lazy.project=/project-a` actually produces.
    mockStdout = 'lazy-builder-aaaa1111\n';
    const result = await runner.discoverProjectBuilderRuns('/home/user/prg/project-a');
    expect(result).toEqual(['lazy-builder-aaaa1111']);

    // When the filter excludes everything, no names come back and no other
    // project's builder can sneak in.
    recordedCalls.length = 0;
    mockStdout = '';
    const empty = await runner.discoverProjectBuilderRuns('/home/user/prg/empty-project');
    expect(empty).toEqual([]);
  });

  test('returns empty array when docker ps fails', async () => {
    const runner = new DockerRunner('docker');
    mockExitCode = 1;
    mockStdout = 'garbage';
    expect(await runner.discoverProjectBuilderRuns('/any/project')).toEqual([]);
  });

  test('splits multiple container names on newlines', async () => {
    const runner = new DockerRunner('docker');
    mockStdout = 'lazy-builder-aaaa1111\nlazy-builder-bbbb2222\n';
    const result = await runner.discoverProjectBuilderRuns('/home/user/prg/project-a');
    expect(result).toEqual(['lazy-builder-aaaa1111', 'lazy-builder-bbbb2222']);
  });

  test('podman runner uses the podman binary with the same filters', async () => {
    const runner = new DockerRunner('podman', 'podman');
    await runner.discoverProjectBuilderRuns('/tmp/x');
    expect(recordedCalls[0]!.cmd[0]).toBe('podman');
    const cmd = recordedCalls[0]!.cmd;
    const filters: string[] = [];
    for (let i = 0; i < cmd.length - 1; i++) {
      if (cmd[i] === '--filter') filters.push(cmd[i + 1]!);
    }
    expect(filters).toContain('name=^lazy-builder-');
    expect(filters).toContain(`label=${PROJECT_LABEL}=/tmp/x`);
  });
});

describe('HostProcessRunner.discoverProjectBuilderRuns', () => {
  // INVARIANT: Host-process mode launches the builder as a foreground
  // Claude Code process without a PID file, so there is nothing for
  // `lazy upgrade` to enumerate or stop. Returning a non-empty list here
  // would trick upgrade into killing unrelated host processes.
  test('returns empty array (no tracked builder runs in host-process mode)', async () => {
    const runner = new HostProcessRunner();
    expect(await runner.discoverProjectBuilderRuns('/any/project')).toEqual([]);
  });
});

afterAll(() => {
  restoreMockedModules();
});
