/**
 * Capture a Codex builder's conversations from its native rollout JSONL.
 *
 * Codex writes one rollout per thread under `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-<timestamp>-<thread id>.jsonl`, and a resumed thread APPENDS to the
 * rollout it was recorded in. Read off codex-cli 0.164.0 (a real `codex exec`
 * against a scripted Responses server; the trimmed rollout is
 * test/fixtures/codex/codex-rollout-0.164.0.jsonl), and the same record shapes
 * the earlier 0.152.1 verification found:
 *
 *   session_meta                — `payload.session_id` / `id`, `cwd`, `cli_version`
 *   turn_context                — `payload.turn_id`, `payload.model`
 *   response_item / message     — `payload.role` user|assistant|developer,
 *                                 `payload.content[].type` input_text|output_text
 *   event_msg / token_count     — `payload.info.last_token_usage` (one model call)
 *
 * Only user and assistant messages are a conversation. Codex also records, as
 * USER messages, the context it injects itself (`<environment_context>`, the
 * project's instructions); those are not anything the person typed and are
 * left out, as Claude Code's own injected records are.
 *
 * Usage is per model call (`last_token_usage`), attached to the assistant
 * message it produced, and summed into the conversation's total — the same
 * shape a Claude builder's conversation has, so every reader (the Builders
 * page, `lazy view`, token stats) treats both alike. OpenAI's
 * `input_tokens` INCLUDES cached input, so cached tokens are subtracted to
 * avoid counting them twice.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import type { Storage } from '../storage';
import type { TokenUsage } from '../types';
import type { ConversationMessage, ParsedConversation } from './claude-code-logs';
import { conversationStats, extractSummary } from './claude-code-logs';
import { toStoredConversation } from './conversation-storage';
import type { CaptureResult } from './capture-session';

export interface CodexRolloutFile {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  size: number;
}

/** Rollout files keyed by path → the size/mtime last seen. */
export type CodexRolloutSnapshot = Map<string, { mtimeMs: number; size: number }>;

const ZERO_USAGE = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });

function addUsage(target: TokenUsage, value: TokenUsage): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cacheCreationTokens += value.cacheCreationTokens;
  target.cacheReadTokens += value.cacheReadTokens;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** OpenAI counters → lazy counters, without counting cached input twice. */
function parseUsage(value: unknown): TokenUsage | null {
  const raw = object(value);
  if (!raw) return null;
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cached = raw.cached_input_tokens === undefined ? 0 : count(raw.cached_input_tokens);
  const cacheWrite = raw.cache_write_input_tokens === undefined ? 0 : count(raw.cache_write_input_tokens);
  if (input === null || output === null || cached === null || cacheWrite === null) return null;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cached,
  };
}

const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function sessionIdFromFilename(filePath: string): string | null {
  return basename(filePath).match(ROLLOUT_NAME)?.[1] ?? null;
}

/** Context Codex records as a "user" message on its own initiative. */
const INJECTED_USER_CONTEXT = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md instructions for )/;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    // Bounded: sessions/YYYY/MM/DD is exactly three levels.
    if (entry.isDirectory() && depth < 3) await walk(path, depth + 1, out);
    else if (entry.isFile() && ROLLOUT_NAME.test(entry.name)) out.push(path);
  }
}

/** Every rollout below `<codexHome>/sessions`. */
export async function discoverCodexRollouts(codexHome: string): Promise<CodexRolloutFile[]> {
  const paths: string[] = [];
  await walk(join(codexHome, 'sessions'), 0, paths);
  const files: CodexRolloutFile[] = [];
  for (const filePath of paths.sort()) {
    try {
      const info = await stat(filePath);
      files.push({ sessionId: sessionIdFromFilename(filePath)!, filePath, mtimeMs: info.mtimeMs, size: info.size });
    } catch (err) {
      // Gone between the listing and the stat: nothing to capture.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return files;
}

export async function snapshotCodexRollouts(codexHome: string): Promise<CodexRolloutSnapshot> {
  const snapshot: CodexRolloutSnapshot = new Map();
  for (const file of await discoverCodexRollouts(codexHome)) {
    snapshot.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size });
  }
  return snapshot;
}

function textOf(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map(object)
    .filter((b): b is Record<string, unknown> => b !== null && (b.type === 'input_text' || b.type === 'output_text'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Parse one rollout (fresh or resumed-and-appended) into a conversation. */
export function parseCodexRolloutText(content: string, filePath: string): ParsedConversation {
  const messages: ConversationMessage[] = [];
  const totalUsage = ZERO_USAGE();
  let sessionId = sessionIdFromFilename(filePath) ?? basename(filePath, '.jsonl');
  let cwd: string | null = null;
  let version: string | null = null;
  let gitBranch: string | null = null;
  let model: string | null = null;
  let pendingAssistant: ConversationMessage | null = null;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | null;
    try {
      record = object(JSON.parse(line));
    } catch (err) {
      // A rollout being appended can end in a half-written line; the next pass reads it whole.
      if (err instanceof SyntaxError) continue;
      throw err;
    }
    const payload = object(record?.payload);
    if (!record || !payload) continue;
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';

    if (record.type === 'session_meta') {
      const id = typeof payload.session_id === 'string' ? payload.session_id : payload.id;
      if (typeof id === 'string') sessionId = id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.cli_version === 'string') version = payload.cli_version;
      const git = object(payload.git);
      if (git && typeof git.branch === 'string') gitBranch = git.branch;
    } else if (record.type === 'turn_context') {
      model = typeof payload.model === 'string' ? payload.model : model;
    } else if (record.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = textOf(payload);
      if (!text || (role === 'user' && INJECTED_USER_CONTEXT.test(text))) continue;
      const message: ConversationMessage = {
        uuid: typeof payload.id === 'string' ? payload.id : `${sessionId}-${messages.length}`,
        parentUuid: messages.at(-1)?.uuid ?? null,
        timestamp,
        role,
        text,
        model: role === 'assistant' ? model : null,
        usage: null,
      };
      messages.push(message);
      if (role === 'assistant') pendingAssistant = message;
    } else if (record.type === 'event_msg' && payload.type === 'token_count') {
      const usage = parseUsage(object(payload.info)?.last_token_usage);
      if (!usage) continue;
      addUsage(totalUsage, usage);
      // A token_count follows the model call it measures; when that call
      // produced visible text, the message carries the call's usage.
      if (pendingAssistant) {
        pendingAssistant.usage = usage;
        pendingAssistant = null;
      }
    }
  }

  const stamps = messages.map((m) => m.timestamp).filter(Boolean).sort();
  return {
    sessionId,
    projectPath: filePath,
    cwd,
    version,
    gitBranch,
    startedAt: stamps[0] ?? null,
    endedAt: stamps.at(-1) ?? null,
    messages,
    subagents: [],
    totalUsage,
  };
}

export async function parseCodexRollout(filePath: string): Promise<ParsedConversation> {
  return parseCodexRolloutText(await readFile(filePath, 'utf8'), filePath);
}

function changed(file: CodexRolloutFile, seen: CodexRolloutSnapshot | undefined): boolean {
  const prior = seen?.get(file.filePath);
  return !prior || prior.size !== file.size || prior.mtimeMs !== file.mtimeMs;
}

/**
 * Persist every rollout created or appended since `before`. `alreadyCaptured`
 * (mutated) makes repeated incremental passes skip files unchanged since they
 * were last saved. Each file fails independently, into `errors` — never
 * swallowed; the caller reports them (src/supervisor/builder.ts).
 */
export async function captureCodexBuilderRollouts(
  codexHome: string,
  before: CodexRolloutSnapshot,
  storage: Storage,
  alreadyCaptured?: CodexRolloutSnapshot,
): Promise<CaptureResult> {
  const owned = (await discoverCodexRollouts(codexHome)).filter((f) => changed(f, before));
  const captured: string[] = [];
  const errors: Array<{ sessionId: string; error: Error }> = [];
  let newest: CodexRolloutFile | null = null;
  for (const file of owned) {
    if (!newest || file.mtimeMs > newest.mtimeMs) newest = file;
    if (!changed(file, alreadyCaptured)) continue;
    try {
      const conversation = await parseCodexRollout(file.filePath);
      // Codex writes the rollout before the first message lands: wait for content.
      if (conversation.messages.length === 0) continue;
      await storage.saveConversation(
        toStoredConversation(conversation, extractSummary(conversation), conversationStats(conversation)),
      );
      captured.push(conversation.sessionId);
      alreadyCaptured?.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size });
    } catch (err) {
      errors.push({ sessionId: file.sessionId, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { captured, newestSessionId: newest?.sessionId ?? null, errors };
}
