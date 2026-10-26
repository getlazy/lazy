import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beginSupervisorCommand, registerSupervisorAgent, registerSupervisorHook, reportSupervisorExit, writeSupervisorResponse } from '../../src/protocol/supervisor-receipt';
import { runTurnHookCommand } from '../../src/supervisor/post-turn-check';
import { consumeCommand, consumeResponse, readCommand, readResponse, writeCommand } from '../../src/protocol/io';
import type { AskCommand, ErrorResponse } from '../../src/protocol/types';

let dir: string;
const command: AskCommand = { type: 'ask', task_id: 'task', goal: 'test', prompt: 'test', command_id: 'first' };
const response: ErrorResponse = { status: 'error', error: 'original error', phase: 'work', command_id: 'first' };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'supervisor-receipt-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('supervisor invocation receipts', () => {
  // INVARIANT: completing a hook retires only its own PID. Recovery must still
  // end a live harness and must never signal a completed hook's recycled PID.
  test('the real hook runner clears its receipt without clearing the harness', async () => {
    const harness = Bun.spawn(['sleep', '60']);
    try {
      beginSupervisorCommand(dir, command);
      registerSupervisorAgent(harness.pid);
      expect((await runTurnHookCommand('echo ready', dir, 5000)).exitCode).toBe(0);
      const receipt = JSON.parse(await readFile(join(dir, `supervisor-${process.pid}.json`), 'utf8'));
      expect(receipt.agent_pid).toBe(harness.pid);
      expect(receipt.hook_pid).toBeUndefined();
      reportSupervisorExit(dir, process.pid, 137);
      await harness.exited;
      expect(harness.signalCode).toBe('SIGKILL');
    } finally {
      if (harness.exitCode === null) harness.kill('SIGKILL');
      await harness.exited;
    }
  });

  // INVARIANT: invalid hook ownership cannot signal the recovery process or
  // publish a failure claiming cleanup succeeded when it could not run.
  test('an invalid hook PID refuses recovery before publishing failure', () => {
    beginSupervisorCommand(dir, command);
    registerSupervisorHook(process.pid);
    expect(() => reportSupervisorExit(dir, process.pid, 137)).toThrow('Invalid hook pid');
    expect(readResponse(dir)).toBeNull();
  });

  // INVARIANT: a dead supervisor must not leave its old harness doing work
  // beside the next turn. Only that harness is killed, never its descendants.
  test('a crash ends the registered harness before publishing the failed turn', async () => {
    const harness = Bun.spawn(['sleep', '60']);
    try {
      beginSupervisorCommand(dir, command);
      registerSupervisorAgent(harness.pid);
      reportSupervisorExit(dir, process.pid, 137);
      await harness.exited;
      expect(harness.signalCode).toBe('SIGKILL');
      expect(readResponse(dir)).toMatchObject({ status: 'error', command_id: 'first' });
    } finally {
      if (harness.exitCode === null) harness.kill('SIGKILL');
      await harness.exited;
    }
  });

  // INVARIANT: a container staying alive cannot hide a dead supervisor from a
  // synchronous waiter or the reconciler. Its failed command still gets an answer.
  test('a supervisor killed after consuming its command reports a correlated error', () => {
    writeCommand(dir, command);
    beginSupervisorCommand(dir, command);
    consumeCommand(dir);
    reportSupervisorExit(dir, process.pid, 137);
    expect(readResponse(dir)).toMatchObject({ status: 'error', command_id: 'first', error: expect.stringContaining('137') });
  });

  // INVARIANT: publishing a failed command must retire its pending delivery,
  // including a crash between receipt creation and mailbox consumption.
  test('a crash before command consumption cannot replay the failed command', () => {
    writeCommand(dir, command);
    beginSupervisorCommand(dir, command);
    reportSupervisorExit(dir, process.pid, 137);
    expect(readResponse(dir)).toMatchObject({ status: 'error', command_id: 'first' });
    expect(readCommand(dir)).toBeNull();
  });

  // INVARIANT: retiring a crashed turn cannot consume a newer queued command.
  test('an unfinished receipt preserves a different pending command', () => {
    beginSupervisorCommand(dir, command);
    writeCommand(dir, { ...command, command_id: 'next' });
    reportSupervisorExit(dir, process.pid, 137);
    expect(readResponse(dir)).toMatchObject({ status: 'error', command_id: 'first' });
    expect(readCommand(dir)).toMatchObject({ command_id: 'next' });
  });

  test('a legacy command without an id is retired only when its contents match', () => {
    const legacy = { ...command, command_id: undefined };
    writeCommand(dir, legacy);
    beginSupervisorCommand(dir, legacy);
    reportSupervisorExit(dir, process.pid, 137);
    expect(readCommand(dir)).toBeNull();
    beginSupervisorCommand(dir, legacy);
    writeCommand(dir, { ...legacy, prompt: 'A newer command' });
    reportSupervisorExit(dir, process.pid, 137);
    expect(readCommand(dir)?.type).toBe('ask');
    expect(readCommand(dir)).toMatchObject({ prompt: 'A newer command' });
  });

  // INVARIANT: wait(2) may finish after the daemon consumed a response AND
  // queued a next command. The old process must neither replay nor consume it.
  test('an acknowledged failed turn cannot consume a queued next command', () => {
    writeCommand(dir, command);
    beginSupervisorCommand(dir, command);
    consumeCommand(dir);
    writeSupervisorResponse(dir, response);
    consumeResponse(dir);
    writeCommand(dir, { ...command, command_id: 'next' });
    reportSupervisorExit(dir, process.pid, 1);
    expect(readResponse(dir)).toBeNull();
    expect(readCommand(dir)).toMatchObject({ command_id: 'next' });
  });

  test('a startup crash reports and consumes its still-pending command', () => {
    writeCommand(dir, command);
    reportSupervisorExit(dir, process.pid, 1);
    expect(readResponse(dir)).toMatchObject({ status: 'error', command_id: 'first' });
    expect(readCommand(dir)).toBeNull();
  });

  test('an answer saved before a crash is published intact', async () => {
    beginSupervisorCommand(dir, command);
    await writeFile(join(dir, `supervisor-${process.pid}.json`), JSON.stringify(response));
    reportSupervisorExit(dir, process.pid, 137);
    expect(readResponse(dir)).toEqual(response);
  });

  test('an idle supervisor and a stop cannot claim the next command', () => {
    reportSupervisorExit(dir, process.pid, 137);
    expect(readResponse(dir)).toBeNull();
    writeCommand(dir, { ...command, command_id: 'next' });
    reportSupervisorExit(dir, process.pid, 42);
    expect(readCommand(dir)).toMatchObject({ command_id: 'next' });
    expect(readResponse(dir)).toBeNull();
  });
});
