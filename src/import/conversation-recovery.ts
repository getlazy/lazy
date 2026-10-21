/**
 * Conversation recovery files: the hand-off for a conversation captured while
 * the daemon was down.
 *
 * Only the daemon owns storage, so a CLI process that finishes a builder or
 * pairing session with no daemon to talk to cannot persist what it captured.
 * Instead it writes each conversation as plain JSON into
 * `<project>/.lazy/recovery/conversations/` — no storage lock, no Storage
 * interface — and the daemon's reconciler drains that directory on every tick
 * (so also right after startup), saving each one through the no-regression
 * guard and deleting the file only once the save succeeded.
 *
 * The directory is UNTRUSTED input: builder containers mount the data dir
 * read-write, so anything a container wrote can be sitting here. The drain
 * therefore validates shape, refuses symlinks and oversize files, and never
 * trusts an attribution (`memberEmail` is forced to null, exactly as the
 * daemon's user-token capture route does).
 */

import { join } from 'path';
import { access, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import type { Storage } from '../storage';
import type { StoredConversation } from '../storage/types';
import { saveConversationWithoutRegression } from './conversation-storage';
import { logger } from '../utils/logger';

const RECOVERY_FORMAT = 'lazy-conversation-recovery';
const RECOVERY_VERSION = 1;
/** Generous for a long session; bounds what one planted file can make the daemon read. */
const MAX_RECOVERY_FILE_BYTES = 256 * 1024 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INVALID_SUFFIX = '.invalid';

interface ConversationRecoveryFile {
  format: typeof RECOVERY_FORMAT;
  version: number;
  label: string;
  writtenAt: string;
  conversation: StoredConversation;
}

/**
 * `<root>/.lazy/recovery/conversations` — or `.workshop/` for an un-migrated
 * repo, matching getDataDir's rule but resolved with fs/promises because the
 * daemon calls this on every reconcile tick.
 */
export async function conversationRecoveryDir(lazyRoot: string): Promise<string> {
  const exists = async (p: string) => access(p).then(() => true, () => false);
  const dataDir = (await exists(join(lazyRoot, '.lazy'))) || !(await exists(join(lazyRoot, '.workshop')))
    ? '.lazy'
    : '.workshop';
  return join(lazyRoot, dataDir, 'recovery', 'conversations');
}

/**
 * Write one conversation to the recovery directory. Written to a temp name and
 * renamed, so the daemon never reads a half-written file. Throws on failure —
 * the caller must tell the human the conversation was not saved.
 */
export async function writeConversationRecoveryFile(
  lazyRoot: string,
  conversation: StoredConversation,
  label: string,
): Promise<string> {
  const dir = await conversationRecoveryDir(lazyRoot);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `conversation-${timestamp}-${conversation.sessionId}.json`;
  const body: ConversationRecoveryFile = {
    format: RECOVERY_FORMAT,
    version: RECOVERY_VERSION,
    label,
    writtenAt: new Date().toISOString(),
    conversation,
  };
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(body), 'utf-8');
  await rename(tmpPath, finalPath);
  return finalPath;
}

/** A file that can never be stored, as opposed to a save that may succeed later. */
class InvalidRecoveryFile extends Error {}

function isMessageList(v: unknown): boolean {
  return Array.isArray(v) && v.every(m =>
    m !== null && typeof m === 'object' &&
    typeof (m as { uuid?: unknown }).uuid === 'string' &&
    typeof (m as { role?: unknown }).role === 'string');
}

function validate(parsed: unknown): { label: string; conversation: StoredConversation } {
  if (!parsed || typeof parsed !== 'object') throw new InvalidRecoveryFile('not a JSON object');
  const file = parsed as Partial<ConversationRecoveryFile>;
  if (file.format !== RECOVERY_FORMAT) throw new InvalidRecoveryFile('not a lazy conversation recovery file');
  const c = file.conversation as unknown as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') throw new InvalidRecoveryFile('missing conversation');
  if (typeof c.sessionId !== 'string' || !SAFE_SESSION_ID.test(c.sessionId)) {
    throw new InvalidRecoveryFile('conversation has no safe session id');
  }
  if (!isMessageList(c.messages)) throw new InvalidRecoveryFile('conversation messages are malformed');
  if (!Array.isArray(c.subagents) || !c.subagents.every(s =>
    s !== null && typeof s === 'object' && isMessageList((s as { messages?: unknown }).messages))) {
    throw new InvalidRecoveryFile('conversation subagents are malformed');
  }
  if (!c.stats || typeof c.stats !== 'object') throw new InvalidRecoveryFile('conversation stats are malformed');
  return {
    label: typeof file.label === 'string' ? file.label : 'session',
    // Never trust an attribution from a file anyone with the data dir could write.
    conversation: { ...(c as unknown as StoredConversation), memberEmail: null },
  };
}

export interface RecoveryDrainResult {
  recovered: string[];
  /** Files that can never be stored, renamed to `*.invalid` so they are not retried. */
  invalid: string[];
  /** Files whose save failed and stay in place for the next tick. */
  failed: Array<{ file: string; error: string }>;
}

/**
 * Save every pending recovery file into storage, oldest first, deleting each
 * only after its save succeeded. An invalid file is renamed aside once (one
 * warning); a failed SAVE is left in place and the call throws, so it is
 * retried next tick and shows in sweep health.
 */
export async function drainConversationRecovery(
  storage: Storage,
  lazyRoot: string,
): Promise<RecoveryDrainResult> {
  const dir = await conversationRecoveryDir(lazyRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: [], invalid: [], failed: [] };
    throw new Error(`failed to read conversation recovery directory ${dir}: ${(err as Error).message}`);
  }

  const result: RecoveryDrainResult = { recovered: [], invalid: [], failed: [] };
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const path = join(dir, name);
    try {
      let loaded: { label: string; conversation: StoredConversation };
      try {
        const info = await lstat(path);
        if (!info.isFile()) throw new InvalidRecoveryFile('not a regular file');
        if (info.size > MAX_RECOVERY_FILE_BYTES) throw new InvalidRecoveryFile(`larger than ${MAX_RECOVERY_FILE_BYTES} bytes`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, 'utf-8'));
        } catch (err) {
          throw new InvalidRecoveryFile(`unreadable JSON: ${(err as Error).message}`);
        }
        loaded = validate(parsed);
      } catch (err) {
        if (!(err instanceof InvalidRecoveryFile)) throw err;
        await rename(path, `${path}${INVALID_SUFFIX}`);
        result.invalid.push(path);
        logger.warn(`Conversation recovery file ${path} was set aside as ${path}${INVALID_SUFFIX}: ${err.message}`);
        continue;
      }
      await saveConversationWithoutRegression(storage, loaded.conversation);
      await unlink(path);
      result.recovered.push(loaded.conversation.sessionId);
      logger.info(`Recovered ${loaded.label} conversation ${loaded.conversation.sessionId.substring(0, 8)} captured while the daemon was down`);
    } catch (err) {
      result.failed.push({ file: path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.failed.length > 0) {
    throw new Error(
      `could not recover ${result.failed.length} conversation file(s); they stay in place for retry: ` +
      result.failed.map(f => `${f.file}: ${f.error}`).join('; '),
    );
  }
  return result;
}
