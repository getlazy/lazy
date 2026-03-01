/**
 * Protocol file I/O utilities.
 *
 * Handles reading, writing, and watching the protocol directory files:
 *   ~/.lazy/protocol/<task-id>/
 *     command.json    - host → supervisor
 *     response.json   - supervisor → host
 *     status.json     - supervisor checkpoint/heartbeat
 *
 * Protocol directories are per-user operational state for container IPC.
 * They live in ~/.lazy/protocol/ — outside the repo entirely — to avoid
 * polluting the repo with ephemeral IPC artifacts.
 *
 * All writes use atomic temp-file-then-rename to prevent partial reads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { Command, Response, SupervisorStatus } from './types';

/**
 * Get the base directory for protocol files.
 * Defaults to ~/.lazy/protocol. Override with LAZY_PROTOCOL_BASE for testing.
 */
function protocolBase(): string {
  return process.env.LAZY_PROTOCOL_BASE || join(homedir(), '.lazy', 'protocol');
}

/**
 * Get the protocol directory path for a task.
 *
 * Protocol dirs live at ~/.lazy/protocol/<taskId>/ — per-user operational
 * state, not in the repo. Inside containers, the host-side protocol dir
 * is bind-mounted at the same path.
 */
export function protocolDir(taskId: string): string {
  return join(protocolBase(), taskId);
}

function commandPath(dir: string): string {
  return join(dir, 'command.json');
}

function responsePath(dir: string): string {
  return join(dir, 'response.json');
}

function statusPath(dir: string): string {
  return join(dir, 'status.json');
}

/**
 * Atomic write: write to temp file then rename.
 */
function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

/**
 * Safe JSON read: returns null if file doesn't exist or can't be parsed.
 */
function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// --- Command operations (host writes, supervisor reads) ---

/**
 * Write a command for the supervisor to pick up.
 * Clears any previous response before writing the new command.
 */
export function writeCommand(dir: string, command: Command): void {
  mkdirSync(dir, { recursive: true });
  // Clear previous response so supervisor knows this is a fresh command
  const rPath = responsePath(dir);
  if (existsSync(rPath)) {
    try { unlinkSync(rPath); } catch { /* best effort */ }
  }
  atomicWrite(commandPath(dir), JSON.stringify(command, null, 2));
}

/**
 * Read the pending command. Returns null if no command is waiting.
 */
export function readCommand(dir: string): Command | null {
  return safeReadJson<Command>(commandPath(dir));
}

/**
 * Consume (delete) the command file after processing.
 */
export function consumeCommand(dir: string): void {
  const p = commandPath(dir);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
}

/**
 * Check if a command is pending without fully reading it.
 */
export function hasCommand(dir: string): boolean {
  return existsSync(commandPath(dir));
}

// --- Response operations (supervisor writes, host reads) ---

/**
 * Write the supervisor's response for the host to read.
 */
export function writeResponse(dir: string, response: Response): void {
  atomicWrite(responsePath(dir), JSON.stringify(response, null, 2));
}

/**
 * Read the supervisor's response. Returns null if no response yet.
 */
export function readResponse(dir: string): Response | null {
  return safeReadJson<Response>(responsePath(dir));
}

/**
 * Check if a response is available without fully reading it.
 */
export function hasResponse(dir: string): boolean {
  return existsSync(responsePath(dir));
}

/**
 * Consume (delete) the response file after processing.
 */
export function consumeResponse(dir: string): void {
  const p = responsePath(dir);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
}

// --- Status operations (supervisor writes, host reads for recovery) ---

/**
 * Write/update the supervisor's status checkpoint.
 */
export function writeStatus(dir: string, status: SupervisorStatus): void {
  atomicWrite(statusPath(dir), JSON.stringify(status, null, 2));
}

/**
 * Read the supervisor's status. Returns null if no status file.
 */
export function readStatus(dir: string): SupervisorStatus | null {
  return safeReadJson<SupervisorStatus>(statusPath(dir));
}

/**
 * Clear the status file (e.g., on clean shutdown).
 */
export function clearStatus(dir: string): void {
  const p = statusPath(dir);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
}

// --- Watch utilities ---

/**
 * Poll for a command to appear. Returns the command when found, or null on timeout.
 * @param dir Protocol directory
 * @param intervalMs Poll interval in milliseconds (default 500ms)
 * @param timeoutMs Maximum wait time, 0 = wait forever (default 0)
 */
export async function waitForCommand(dir: string, intervalMs: number = 500, timeoutMs: number = 0): Promise<Command | null> {
  const start = Date.now();
  while (true) {
    const cmd = readCommand(dir);
    if (cmd) return cmd;

    if (timeoutMs > 0 && (Date.now() - start) >= timeoutMs) {
      return null;
    }

    await Bun.sleep(intervalMs);
  }
}

/**
 * Poll for a response to appear. Returns the response when found, or null on timeout.
 * @param dir Protocol directory
 * @param intervalMs Poll interval in milliseconds (default 1000ms)
 * @param timeoutMs Maximum wait time, 0 = wait forever (default 0)
 */
export async function waitForResponse(dir: string, intervalMs: number = 1000, timeoutMs: number = 0): Promise<Response | null> {
  const start = Date.now();
  while (true) {
    const resp = readResponse(dir);
    if (resp) return resp;

    if (timeoutMs > 0 && (Date.now() - start) >= timeoutMs) {
      return null;
    }

    await Bun.sleep(intervalMs);
  }
}

// --- Protocol directory management ---

/**
 * Ensure the protocol directory exists.
 */
export function ensureProtocolDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Clean up all protocol files (used when task completes or container is torn down).
 */
export function cleanProtocol(dir: string): void {
  for (const file of ['command.json', 'response.json', 'status.json']) {
    const p = join(dir, file);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
}

/**
 * Remove the protocol directory entirely (best-effort).
 * Called when a task reaches a terminal state (accepted/rejected/closed).
 */
export function removeProtocolDir(dir: string): void {
  try {
    // Remove files first, then the directory
    cleanProtocol(dir);
    if (existsSync(dir)) {
      const { rmdirSync } = require('fs');
      rmdirSync(dir);
    }
  } catch { /* best effort */ }
}
