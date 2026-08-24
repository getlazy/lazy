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
import { randomUUID } from 'crypto';
import { getHome } from '../utils/home';
import type { Command, Response, SupervisorStatus } from './types';
import { PROTOCOL_VERSION } from './types';
import { PROGRESS_FILE } from './progress';
import type { ResolvedConfig, MaintainEntry } from '../config/types';
import { buildAgentSandboxArgs } from '../runner/host-sandbox';

/**
 * Common policy fields for every start/unblock command.
 *
 * Centralizes fields that must be on every command — callers spread
 * the result into their command object so nobody forgets them.
 *
 * `protocol_version` is injected here so every command sent to the
 * supervisor passes the version gate. See PROTOCOL_VERSION for bump rules.
 */
export function commonCommandFields(config: ResolvedConfig): {
  protocol_version: number;
  turn_started_at: string;
  watchdog_output_timeout_ms?: number;
  wind_down_timeout_ms?: number;
  protected_patterns: string[];
  post_turn_check?: string;
  post_turn_timeout?: number;
  agent_extra_args?: string[];
  maintain?: MaintainEntry[];
} {
  return {
    protocol_version: PROTOCOL_VERSION,
    turn_started_at: new Date().toISOString(),
    ...(config.agent.watchdog_output_timeout_ms !== 0 && {
      watchdog_output_timeout_ms: config.agent.watchdog_output_timeout_ms,
    }),
    // wind_down_timeout_ms is included even when 0 (disabled) so the
    // supervisor sees the explicit opt-out instead of falling back to a default.
    wind_down_timeout_ms: config.agent.wind_down_timeout_ms,
    protected_patterns: config.permissions.protected,
    ...(config.checks.post_turn !== '' && {
      post_turn_check: config.checks.post_turn,
      post_turn_timeout: config.checks.post_turn_timeout,
    }),
    ...computeAgentExtraArgs(config),
    // Maintained-file groups (opt-in). Only sent when configured — omitted
    // entirely on the default empty config so the supervisor skips the check.
    ...(config.automation.maintain.length > 0 && {
      maintain: config.automation.maintain,
    }),
  };
}

/**
 * Compute the extra `claude` CLI args that confine a headless agent turn under
 * the host OS sandbox.
 *
 * Only the host-process runner running Claude Code in "sandbox" mode gets these
 * (a `--settings <json>` enabling the OS sandbox). They are intentionally NOT
 * emitted for:
 *   - docker/podman runners — the container is already the boundary, and the
 *     in-container agent keeps plain `--dangerously-skip-permissions`;
 *   - permission_mode = "bypass" — the explicit full-bypass opt-in;
 *   - non-Claude agents (cursor, qa) — `--settings` is Claude-Code-specific.
 *
 * Returns `{}` (no field) in every other case so the command stays unchanged.
 */
function computeAgentExtraArgs(config: ResolvedConfig): { agent_extra_args?: string[] } {
  // Optional chaining: callers (and tests) may pass partial configs. Anything
  // other than a host-process Claude agent in sandbox mode gets no extra args.
  const isHost = config.runner?.type === 'dangerously-host-process-without-any-isolation';
  const isClaude = config.agent?.agent_id === 'claude-code';
  if (!isHost || !isClaude) return {};

  const extra = buildAgentSandboxArgs({
    mode: config.runner.permission_mode,
    allowedDomains: config.runner.sandbox_allowed_domains,
    allowWeakerNested: config.runner.sandbox_allow_weaker_nested,
    denyRead: config.runner.sandbox_deny_read,
    denyWrite: config.runner.sandbox_deny_write,
  });
  return extra.length > 0 ? { agent_extra_args: extra } : {};
}

/**
 * Get the base directory for protocol files.
 * Defaults to ~/.lazy/protocol. Override with LAZY_PROTOCOL_BASE for testing.
 */
function protocolBase(): string {
  return process.env.LAZY_PROTOCOL_BASE || join(getHome(), '.lazy', 'protocol');
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
  // INVARIANT: a command starts a turn, and a turn starts with no progress.
  // The agent's self-reported progress line (progress.json) is per-TURN
  // ephemera, so clearing it here — the one place every turn passes through —
  // is what makes "a stale message from a finished turn never lingers" a
  // structural guarantee rather than eight call sites that must remember.
  const pPath = join(dir, PROGRESS_FILE);
  if (existsSync(pPath)) {
    try { unlinkSync(pPath); } catch { /* best effort */ }
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
  // waiting.json is included: a torn-down turn cannot still be blocked on a
  // subtask, so leaving the marker behind would render a dead task as waiting.
  // progress.json likewise — a torn-down turn is not making progress.
  for (const file of ['command.json', 'response.json', 'status.json', 'waiting.json', PROGRESS_FILE]) {
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
