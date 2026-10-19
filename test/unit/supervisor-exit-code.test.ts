import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSupervisor } from '../../src/supervisor';
import { PROTOCOL_VERSION, readResponse, writeCommand } from '../../src/protocol';
import { spawn } from '../../src/utils/spawn';

describe('one-shot supervisor exit codes', () => {
  let root: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-supervisor-exit-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(join(bin, 'lazy-agent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  });

  async function runGate(commands: string[], protocolVersion = PROTOCOL_VERSION) {
    const protocolDir = join(root, 'protocol');
    writeCommand(protocolDir, {
      type: 'accept_gate',
      task_id: 'test-supervisor-exit',
      command_id: 'test-command',
      protocol_version: protocolVersion,
      accept_gate_commands: commands,
    });
    const exitCode = await runSupervisor({
      protocolDir,
      worktreePath: root,
      oneShot: true,
      runnerType: 'dangerously-host-process-without-any-isolation',
    });
    return { exitCode, response: readResponse(protocolDir) };
  }

  test('a completed command returns zero', async () => {
    const { exitCode, response } = await runGate(['true']);
    expect(exitCode).toBe(0);
    expect(response?.status).toBe('completed');
    expect(response?.command_id).toBe('test-command');
  });

  test('a command-handler exception writes its error and returns nonzero', async () => {
    const { exitCode, response } = await runGate(undefined as unknown as string[]);
    expect(exitCode).toBe(1);
    expect(response?.status).toBe('error');
    expect(response?.command_id).toBe('test-command');
  });

  test('a protocol refusal returns nonzero', async () => {
    const { exitCode, response } = await runGate(['true'], PROTOCOL_VERSION + 1);
    expect(exitCode).toBe(1);
    expect(response?.status).toBe('error');
  });

  for (const entry of ['index.ts', 'agent-entry.ts']) {
    test(`${entry} propagates the supervisor failure to its process exit code`, async () => {
      const protocolDir = join(root, 'protocol');
      writeCommand(protocolDir, {
        type: 'accept_gate',
        task_id: 'test-supervisor-exit',
        protocol_version: PROTOCOL_VERSION + 1,
        accept_gate_commands: ['true'],
      });
      const args = [process.execPath, join(import.meta.dir, '../../src', entry)];
      if (entry === 'index.ts') args.push('supervise', '--runner', 'dangerously-host-process-without-any-isolation');
      args.push('--one-shot', '--protocol-dir', protocolDir, '--worktree', root);
      const proc = spawn(args, {
        env: { ...process.env, LAZY_TEST_PARENT_PID: String(process.pid) },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const [exitCode] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(readResponse(protocolDir)?.status).toBe('error');
    });
  }
});
