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
import { join, basename } from 'path';
import { homedir } from 'os';
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
  /** Path to a file containing the system prompt */
  systemPromptFile: string;
  /** Path to the builder config JSON (host + port + token) */
  builderConfigPath: string;
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
  const claudeHome = homedir();
  const beforeTimes = getSessionFileTimes(claudeHome, config.worktreePath);

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
  const monitor = startCaptureMonitor(config.worktreePath, claudeHome, beforeTimes, createStorage);

  log('[builder] Launching Claude Code interactively...');

  // Launch Claude Code with inherited stdin/stdout/stderr
  const proc = Bun.spawn(claudeArgs, {
    cwd: config.worktreePath,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  log(`[builder] Claude Code exited with code ${exitCode}`);

  // Final capture
  const detectedSessionId = await monitor.stop();
  if (detectedSessionId) {
    log(`[builder] Captured conversation: ${detectedSessionId}`);
    // Print session ID to stderr (stdout is Claude's territory)
    console.error(`\nBuilder session: ${detectedSessionId}`);
  }

  // Signal shutdown to host HTTP server
  try {
    const { signalShutdown } = await import('../builder/client');
    await signalShutdown(builderConfig.host, builderConfig.port, builderConfig.token);
    log('[builder] Shutdown signal sent to host');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[builder] Failed to signal shutdown: ${msg}`);
  }

  process.exit(exitCode);
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

function findActiveSessionFile(
  beforeTimes: Map<string, number>,
  claudeHome: string,
  lazyRoot: string,
): string | null {
  const afterTimes = getSessionFileTimes(claudeHome, lazyRoot);

  let newestFile: string | null = null;
  let newestMtime = 0;

  for (const [file, mtime] of afterTimes) {
    const beforeMtime = beforeTimes.get(file);
    if (beforeMtime === undefined || mtime !== beforeMtime) {
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestFile = file;
      }
    }
  }

  return newestFile;
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
        const fileName = findActiveSessionFile(beforeTimes, claudeHome, lazyRoot);
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
        const fileRef = activeFile ?? findActiveSessionFile(beforeTimes, claudeHome, lazyRoot);
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
