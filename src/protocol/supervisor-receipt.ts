/**
 * A receipt belongs to ONE supervisor invocation. Publishing a response RENAMES
 * the receipt into response.json, atomically ending ownership of that command.
 * The shell wrapper can therefore settle a killed supervisor without replaying
 * an answer the daemon already consumed, even if it consumed it before wait(2).
 *
 * Sync I/O is necessary here: these operations are part of the existing sync
 * mailbox transaction (consume command / publish response). No async work runs
 * between a receipt becoming an answer and its atomic rename into the mailbox.
 * Registering a harness or hook PID likewise finishes before the spawn step yields,
 * so crash recovery does not have to infer which child belongs to this turn.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { Command, Response } from './types';
import { consumeCommand, readCommand, supersedeResponse, writeResponse } from './io';

interface ActiveCommand { command_id?: string; command_fingerprint?: string; agent_pid?: number; hook_pid?: number }
type Receipt = ActiveCommand | Response;
let activeReceipt: { path: string; command: ActiveCommand } | null = null;

function receiptPath(dir: string, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid supervisor pid: ${pid}`);
  return join(dir, `supervisor-${pid}.json`);
}

function save(path: string, receipt: Receipt): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt));
  renameSync(`${path}.tmp`, path);
}

function commandFingerprint(command: Command): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

export function beginSupervisorCommand(dir: string, command: Command): void {
  const path = receiptPath(dir, process.pid);
  activeReceipt = { path, command: {
    command_id: 'command_id' in command ? command.command_id : undefined,
    command_fingerprint: commandFingerprint(command),
  } };
  save(path, activeReceipt.command);
  writeFileSync(`${path}.started`, '');
}

/** The common watchdog registers every harness, including wrap-up invocations. */
export function registerSupervisorAgent(pid: number): () => void {
  return registerSupervisorProcess('agent_pid', pid);
}

/** The shared hook runner registers the current pre/post-turn command. */
export function registerSupervisorHook(pid: number): () => void {
  return registerSupervisorProcess('hook_pid', pid);
}

function registerSupervisorProcess(field: 'agent_pid' | 'hook_pid', pid: number): () => void {
  const receipt = activeReceipt;
  if (!receipt || !existsSync(receipt.path)) return () => {};
  receipt.command[field] = pid;
  save(receipt.path, receipt.command);
  return () => {
    if (receipt.command[field] !== pid || !existsSync(receipt.path)) return;
    delete receipt.command[field];
    save(receipt.path, receipt.command);
  };
}

/** Same response protocol, with an atomic handoff from this process's receipt. */
export function writeSupervisorResponse(dir: string, response: Response): void {
  const path = receiptPath(dir, process.pid);
  if (!existsSync(path)) {
    writeResponse(dir, response); // Legacy loop / host runner has no receipt.
    return;
  }
  save(path, response);
  renameSync(path, join(dir, 'response.json'));
  activeReceipt = null;
}

/** Internal wrapper callback, before the next supervisor starts. */
export function reportSupervisorExit(dir: string, pid: number, exitCode: number): void {
  const path = receiptPath(dir, pid);
  const started = existsSync(`${path}.started`);
  if (started) unlinkSync(`${path}.started`);
  if (!existsSync(path)) {
    if (started) return; // Our answer was published; a pending command is NEXT turn's.
    // A startup crash can precede reading the command. Report it rather than
    // looping forever with a pending command and a live container.
    const command = readCommand(dir);
    if (!command || command.type === 'stop' || exitCode === 0 || exitCode === 42) return;
    save(path, { command_id: 'command_id' in command ? command.command_id : undefined });
    consumeCommand(dir);
  }
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
  // A crash can land after saving the receipt but before consumeCommand().
  // Retire only this command, never a newer turn already queued by the daemon.
  const pending = readCommand(dir);
  if (pending && pending.type !== 'stop' && (receipt.command_id
    ? pending.command_id === receipt.command_id
    : 'command_fingerprint' in receipt && receipt.command_fingerprint === commandFingerprint(pending))) {
    consumeCommand(dir);
  }
  for (const field of ['agent_pid', 'hook_pid'] as const) {
    const ownedPid = field in receipt ? (receipt as ActiveCommand)[field] : undefined;
    if (ownedPid === undefined) continue;
    // A SIGKILLed supervisor cannot reap its harness or hook. End those processes,
    // never the services it spawned, before a new turn can start beside it.
    const label = field === 'agent_pid' ? 'agent' : 'hook';
    if (!Number.isSafeInteger(ownedPid) || ownedPid <= 1 || ownedPid === process.pid) {
      throw new Error(`Invalid ${label} pid in supervisor receipt: ${ownedPid}`);
    }
    try { process.kill(ownedPid, 'SIGKILL'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new Error(`Could not end ${label} ${ownedPid} after supervisor ${pid} exited: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  supersedeResponse(dir);
  if (!('status' in receipt)) {
    save(path, {
      status: 'error',
      error: `Supervisor exited unexpectedly with code ${exitCode}. The task environment is still running.`,
      phase: 'work',
      command_id: receipt.command_id,
    });
  }
  // If the supervisor died between saving its answer and publishing it, the
  // receipt IS its answer. Do not replace it with a generic crash message.
  renameSync(path, join(dir, 'response.json'));
}
