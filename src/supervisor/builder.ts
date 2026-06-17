/**
 * Builder supervisor — runs the builder's Claude Code session.
 *
 * Unlike the agent supervisor (which uses a command/response protocol),
 * the builder supervisor runs a single interactive Claude Code session:
 *   1. Launches Claude Code interactively (stdin/stdout/stderr inherited)
 *   2. After exit, captures the conversation from JSONL files into storage
 *   3. Signals shutdown to the host HTTP server
 *
 * MCP config (lazy MCP server entry in ~/.claude.json) is prepared by the
 * runner on the host side before launching the supervisor. In Docker mode,
 * a merged config file is mounted into the container.
 *
 * Tool execution: The MCP server runs in proxy mode — tool calls are
 * forwarded over HTTP to the host-side builder server via TCP.
 * This means the container needs no CLI, no storage access, no git.
 *
 * This module runs inside the Docker container's supervisor process,
 * NOT on the host CLI side.
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { spawn } from '../utils/spawn';
import { join, basename } from 'path';
import { getHome } from '../utils/home';
import { log, logError, setLogFile } from './log';

// JSONL parsing for conversation capture
import {
  encodeProjectPath,
  discoverAllProjectSessions,
  parseConversation,
  extractSummary,
  conversationStats,
  createParseState,
  parseJsonlLines,
  type JsonlParseState,
} from '../import/claude-code-logs';
import { toStoredConversation } from '../import/conversation-storage';
import type { StoredConversation } from '../storage/types';

/** How often to check for JSONL changes and re-capture (ms) */
const CAPTURE_INTERVAL_MS = 30_000;

export interface BuilderSupervisorConfig {
  /** Path to the repo root (working directory for Claude Code) */
  worktreePath: string;
  /**
   * Stable per-builder identifier (the `lazy-builder-<builderId>` run name).
   * When present, the detected Claude sessionId is stamped onto a matching
   * builder-resume-intent on exit so the host relaunch loop can resume the same
   * conversation deterministically. Docker mode passes this; host-process mode
   * (which learns the sessionId directly) does not.
   */
  builderId?: string;
  /** Path to a file containing the system prompt */
  systemPromptFile: string;
  /** Path to the builder config JSON (host + port + token) — used for conversation capture */
  builderConfigPath: string;
  /** Path to the daemon MCP config JSON — routes MCP tool calls through daemon */
  daemonConfigPath?: string;
  /** Additional args to pass to Claude Code */
  claudeExtraArgs?: string[];
  /** Debug mode */
  debug?: boolean;
}

/**
 * Run the builder supervisor.
 *
 * This is the entry point called by agent-entry.ts (Docker mode) or
 * index.ts hidden command (host-process mode).
 */
export async function runBuilderSupervisor(config: BuilderSupervisorConfig): Promise<void> {
  const { createStorage } = await import('../storage');

  // Redirect log output to a file so it doesn't leak into the interactive
  // Claude session (stdout/stderr are Claude's territory during the session).
  // Use /tmp since the repo may be mounted read-only in Docker mode.
  const builderLogFile = `/tmp/lazy-builder-${Date.now()}.log`;
  setLogFile(builderLogFile);

  log('[builder] Starting builder supervisor');
  log(`[builder] Worktree: ${config.worktreePath}`);

  // Read system prompt from file
  const systemPrompt = readFileSync(config.systemPromptFile, 'utf-8');
  log(`[builder] System prompt loaded (${systemPrompt.length} chars)`);

  // Read builder config for MCP proxy setup
  const builderConfig = JSON.parse(readFileSync(config.builderConfigPath, 'utf-8'));
  log(`[builder] Builder config loaded (host: ${builderConfig.host}, port: ${builderConfig.port})`);

  // Claude home for JSONL discovery
  const claudeHome = getHome();
  const beforeTimes = getSessionFileTimes(claudeHome, config.worktreePath);

  // When launched with `--resume <id>`, that session IS the one being driven —
  // Claude appends to <id>.jsonl in place. Capture/stamp must anchor to it
  // rather than guessing by mtime, because ~/.claude/projects/<proj> is shared
  // (other builder runs, a plain `claude` in the same repo) and an unrelated
  // session with a newer mtime would otherwise be detected — resuming the WRONG
  // conversation after an upgrade. See pickActiveSessionFile.
  const resumeSessionId = parseResumeSessionId(config.claudeExtraArgs);
  if (resumeSessionId) {
    log(`[builder] Launched with --resume ${resumeSessionId}; anchoring capture to it`);
  }

  // Build Claude args
  const claudeArgs = [
    'claude',
    '--append-system-prompt', systemPrompt,
    ...(config.claudeExtraArgs ?? []),
  ];

  if (config.debug) {
    log(`[builder] Claude args: ${claudeArgs.join(' ')}`);
  }

  // Start background incremental capture
  const monitor = startCaptureMonitor(config.worktreePath, claudeHome, beforeTimes, createStorage, resumeSessionId);

  log('[builder] Launching Claude Code interactively...');

  // Launch Claude Code with inherited stdin/stdout/stderr
  const proc = spawn(claudeArgs, {
    cwd: config.worktreePath,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 0, // Long-running: builder Claude Code session can run for hours
  });

  const exitCode = await proc.exited;
  log(`[builder] Claude Code exited with code ${exitCode}`);

  // Final capture
  const detectedSessionId = await monitor.stop();
  if (detectedSessionId) {
    log(`[builder] Captured conversation: ${detectedSessionId}`);
    // Print session ID to stderr (stdout is Claude's territory)
    console.error(`\nBuilder session: ${detectedSessionId}`);

    // Stamp the sessionId onto a matching builder-resume-intent so the host
    // relaunch loop can resume the exact same conversation. In docker mode the
    // host gets sessionId: null from the runner — only the in-container
    // supervisor knows the id — so this is the host's deterministic source.
    // Best-effort and non-blocking: a failure here must not affect exit.
    if (config.builderId) {
      await stampSessionIdOntoResumeIntent(
        config.builderId,
        config.worktreePath,
        detectedSessionId,
        createStorage,
      );
    }
  }

  // Signal shutdown to host HTTP server (host-process mode without daemon MCP proxy)
  if (!config.daemonConfigPath) {
    try {
      const { signalShutdown } = await import('../builder/client');
      await signalShutdown(builderConfig.host, builderConfig.port, builderConfig.token);
      log('[builder] Shutdown signal sent to host');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[builder] Failed to signal shutdown: ${msg}`);
    }
  } else {
    log('[builder] Using daemon MCP proxy — no shutdown signal needed');
  }

  process.exit(exitCode);
}

/**
 * Stamp the detected Claude sessionId onto an existing builder-resume-intent.
 *
 * Only updates an intent that already exists for this builderId — it never
 * creates one. An intent is written by `lazy upgrade` before it stops the
 * builder container; if there is no intent, this was a normal quit/crash and
 * there is nothing to resume, so creating a record here would make the host
 * relaunch loop fire spuriously. The intent's data dir is mounted read-write
 * into the container, so the host reads the stamped sessionId after the
 * container exits.
 *
 * Best-effort: any failure is logged and swallowed so it cannot affect the
 * builder's exit path.
 */
export async function stampSessionIdOntoResumeIntent(
  builderId: string,
  projectRoot: string,
  sessionId: string,
  storageFactory: StorageFactory,
): Promise<void> {
  let storage: import('../storage/interface').Storage | null = null;
  try {
    storage = await storageFactory(projectRoot);
    const intents = await storage.listBuilderResumeIntents(projectRoot);
    const existing = intents.find(i => i.builderId === builderId);
    if (!existing) {
      // No upgrade-written intent — normal exit, nothing to resume.
      log(`[builder] No resume intent for ${builderId}; skipping sessionId stamp`);
      return;
    }
    if (existing.sessionId === sessionId) {
      return; // Already stamped (idempotent).
    }
    await storage.saveBuilderResumeIntent({ ...existing, sessionId });
    log(`[builder] Stamped sessionId ${sessionId} onto resume intent ${builderId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[builder] Failed to stamp sessionId onto resume intent: ${msg}`);
  } finally {
    if (storage) {
      await storage.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation capture
// ---------------------------------------------------------------------------

function getSessionFileTimes(claudeHome: string, lazyRoot: string): Map<string, number> {
  const encodedPath = encodeProjectPath(lazyRoot);
  const projectDir = join(claudeHome, '.claude', 'projects', encodedPath);
  const times = new Map<string, number>();

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        try {
          const mtime = statSync(join(projectDir, entry)).mtimeMs;
          times.set(entry, mtime);
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Project directory doesn't exist yet
  }

  return times;
}

/**
 * Extract the `--resume <id>` session id from the args passed to Claude, or null
 * if the builder was started fresh.
 */
export function parseResumeSessionId(args: string[] | undefined): string | null {
  if (!args) return null;
  const i = args.indexOf('--resume');
  if (i >= 0 && i + 1 < args.length) {
    const id = args[i + 1]?.trim();
    return id ? id : null;
  }
  return null;
}

/**
 * Decide which JSONL file holds the live builder session, given the mtimes
 * before launch and after, plus the explicit `--resume` id (if any).
 *
 * Pure (no fs) so the resolution order is unit-testable. Order:
 *   1. If launched with `--resume <id>` and `<id>.jsonl` exists, that is the
 *      session — Claude appends to it in place. This is authoritative: it stops
 *      an unrelated session in the shared ~/.claude/projects/<proj> dir (other
 *      builders, a plain `claude` in the repo) from hijacking detection just
 *      because it has a newer mtime. THIS is the bug that resumed the wrong
 *      conversation after an upgrade.
 *   2. Otherwise (fresh session): the newest file that is genuinely NEW since
 *      launch. A from-scratch session writes a brand-new sessionId file.
 *   3. Last resort: the newest file whose mtime merely changed (legacy
 *      heuristic) — only when there is no resume id and no new file.
 */
export function pickActiveSessionFile(
  beforeTimes: Map<string, number>,
  afterTimes: Map<string, number>,
  resumeSessionId: string | null,
): string | null {
  if (resumeSessionId) {
    const resumedFile = `${resumeSessionId}.jsonl`;
    if (afterTimes.has(resumedFile)) return resumedFile;
  }

  let newestFile: string | null = null;
  let newestMtime = -1;

  // Prefer genuinely-new files (created after launch) — a from-scratch session.
  for (const [file, mtime] of afterTimes) {
    if (!beforeTimes.has(file) && mtime > newestMtime) {
      newestMtime = mtime;
      newestFile = file;
    }
  }
  if (newestFile) return newestFile;

  // Last resort: newest file whose mtime changed since launch.
  for (const [file, mtime] of afterTimes) {
    const beforeMtime = beforeTimes.get(file);
    if (beforeMtime !== undefined && mtime !== beforeMtime && mtime > newestMtime) {
      newestMtime = mtime;
      newestFile = file;
    }
  }

  return newestFile;
}

function findActiveSessionFile(
  beforeTimes: Map<string, number>,
  claudeHome: string,
  lazyRoot: string,
  resumeSessionId: string | null,
): string | null {
  const afterTimes = getSessionFileTimes(claudeHome, lazyRoot);
  return pickActiveSessionFile(beforeTimes, afterTimes, resumeSessionId);
}

function resolveSessionPath(claudeHome: string, lazyRoot: string, fileName: string): string {
  const encodedPath = encodeProjectPath(lazyRoot);
  return join(claudeHome, '.claude', 'projects', encodedPath, fileName);
}

function readNewLines(filePath: string, fromOffset: number): { text: string; newOffset: number } {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return { text: '', newOffset: fromOffset };
  }

  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize <= fromOffset) {
      return { text: '', newOffset: fromOffset };
    }

    const bytesToRead = fileSize - fromOffset;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, fromOffset);
    const raw = buffer.toString('utf-8');

    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { text: '', newOffset: fromOffset };
    }

    const completeText = raw.substring(0, lastNewline + 1);
    const bytesConsumed = Buffer.byteLength(completeText, 'utf-8');
    return { text: completeText, newOffset: fromOffset + bytesConsumed };
  } finally {
    closeSync(fd);
  }
}

function buildIncrementalConversation(
  sessionId: string,
  projectPath: string,
  state: JsonlParseState,
): StoredConversation {
  const allTimestamps = state.messages
    .map(m => m.timestamp)
    .filter(t => t)
    .sort();
  const startedAt = allTimestamps[0] ?? null;
  const endedAt = allTimestamps[allTimestamps.length - 1] ?? null;

  const summary = state.messages.find(m => m.role === 'user' && m.text.trim())?.text.split('\n')[0]?.substring(0, 200) ?? '(empty conversation)';
  const userMsgs = state.messages.filter(m => m.role === 'user');
  const asstMsgs = state.messages.filter(m => m.role === 'assistant');

  return {
    sessionId,
    projectPath,
    cwd: state.metadata.cwd ?? null,
    version: state.metadata.version ?? null,
    gitBranch: state.metadata.gitBranch ?? null,
    startedAt,
    endedAt,
    importedAt: Date.now(),
    summary,
    stats: {
      messageCount: state.messages.length,
      userMessageCount: userMsgs.length,
      assistantMessageCount: asstMsgs.length,
      subagentCount: 0,
      totalTokens: state.usage.inputTokens + state.usage.outputTokens + state.usage.cacheCreationTokens + state.usage.cacheReadTokens,
    },
    totalUsage: state.usage,
    messages: state.messages,
    subagents: [],
  };
}

type StorageFactory = (lazyRoot: string) => Promise<import('../storage/interface').Storage>;

function startCaptureMonitor(
  lazyRoot: string,
  claudeHome: string,
  beforeTimes: Map<string, number>,
  storageFactory: StorageFactory,
  resumeSessionId: string | null,
): { stop: () => Promise<string | null> } {
  let byteOffset = 0;
  let activeFile: string | null = null;
  let sessionId: string | null = null;
  let projectPath: string | null = null;
  const parseState = createParseState();
  let stopped = false;
  let inFlight = false;
  let storage: import('../storage/interface').Storage | null = null;

  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      if (!activeFile) {
        const fileName = findActiveSessionFile(beforeTimes, claudeHome, lazyRoot, resumeSessionId);
        if (!fileName) return;

        activeFile = resolveSessionPath(claudeHome, lazyRoot, fileName);
        sessionId = basename(fileName, '.jsonl');

        const available = await discoverAllProjectSessions(lazyRoot);
        const match = available.find(s => s.sessionId === sessionId);
        projectPath = match?.projectPath ?? encodeProjectPath(lazyRoot);
      }

      const { text, newOffset } = readNewLines(activeFile, byteOffset);
      if (!text) return;

      byteOffset = newOffset;
      parseJsonlLines(text, parseState);

      if (sessionId && parseState.messages.length > 0) {
        if (!storage) {
          storage = await storageFactory(lazyRoot);
        }
        const stored = buildIncrementalConversation(sessionId, projectPath!, parseState);
        await storage.saveConversation(stored);
        log(`[builder] Incremental capture: ${parseState.messages.length} messages, offset ${byteOffset}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[builder] Incremental capture failed: ${msg}`);
    } finally {
      inFlight = false;
    }
  }, CAPTURE_INTERVAL_MS);

  return {
    stop: async (): Promise<string | null> => {
      stopped = true;
      clearInterval(timer);

      let detectedSessionId: string | null = sessionId;
      try {
        const fileRef = activeFile ?? findActiveSessionFile(beforeTimes, claudeHome, lazyRoot, resumeSessionId);
        if (fileRef) {
          const sid = basename(fileRef, '.jsonl');
          detectedSessionId = sid;
          const available = await discoverAllProjectSessions(lazyRoot);
          const match = available.find(s => s.sessionId === sid);
          if (match) {
            if (!storage) {
              storage = await storageFactory(lazyRoot);
            }
            const conversation = await parseConversation(match.projectPath, match.sessionId);
            const summary = extractSummary(conversation);
            const stats = conversationStats(conversation);
            const stored = toStoredConversation(conversation, summary, stats);
            await storage.saveConversation(stored);
            log('[builder] Final conversation capture completed');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[builder] Final capture failed: ${msg}`);
      } finally {
        if (storage) {
          await storage.close();
        }
      }

      return detectedSessionId;
    },
  };
}
