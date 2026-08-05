/**
 * Machine-generated one-shot marking — the source-of-truth predicate for
 * "this Claude session is lazy housekeeping, not a conversation".
 *
 * WHY THIS EXISTS
 * ---------------
 * lazy runs `claude -p` on the HOST for its own bookkeeping: the PR/commit
 * fidelity summary on every accept, `lazy report`'s map-reduce, and LLM memory
 * compaction (see runClaudeOneshot in src/capture/claude.ts). Each of those runs
 * writes a session JSONL into `~/.claude/projects/<encoded-repo>/`, exactly
 * where the daemon capture sweep and `lazy doctor --reimport-conversations`
 * look. They were therefore captured as "builder conversations" and came to
 * dominate the store (~83% of it), drowning real conversations in
 * `lazy builder list` and in search.
 *
 * They are not conversations. Nobody will ever read one. So they are not
 * captured at all.
 *
 * MARKED AT THE SOURCE, NOT SNIFFED AFTER THE FACT
 * ------------------------------------------------
 * `runClaudeOneshot` knows it is a one-shot, so it stamps its prompt with
 * {@link ONESHOT_MARKER} before spawning Claude. Claude records the `-p` prompt
 * verbatim as the session's first user message, so the marker lands at the very
 * head of the JSONL — a durable, deterministic marker that survives a crashed
 * run (the JSONL exists with the prompt even if Claude never returned a result)
 * and needs no registry, no extra CLI flag, and no extra state to keep in sync.
 *
 * Detection deliberately does NOT match on prompt wording ("You are writing the
 * description that will land…"): that is brittle and silently rots the day a
 * prompt is reworded. It matches only lazy's own marker, and only where lazy
 * puts it — as the FIRST thing in the first message's content, within the head
 * of the file. That structural constraint is what keeps a task prompt or a
 * builder transcript that merely *mentions* the marker (e.g. this file being
 * read aloud) from being misclassified: prose can contain the token, but only a
 * real one-shot has `"content":"<marker>` at the head of its JSONL.
 *
 * LIMIT (deliberate): sessions written BEFORE this shipped carry no marker, so
 * they still look like conversations. Nothing content-sniffs them back out —
 * see the CHANGELOG/docs note on cleaning up already-stored housekeeping.
 */

import { open } from 'fs/promises';
import { logger } from '../utils/logger';

/**
 * The marker line prepended to every machine-generated one-shot prompt.
 *
 * Shaped as an HTML comment so it is inert to the model, and carries a fixed
 * nonce so the token is not something a human would type by accident. Changing
 * this string makes every previously-marked session look like a conversation
 * again — version it (`/v2`) rather than editing in place if it ever must
 * change, and keep matching both.
 */
export const ONESHOT_MARKER =
  '<!-- lazy-machine-oneshot/v1/8f2c1d: machine-generated lazy housekeeping run; not captured as a conversation -->';

/**
 * Stamp a one-shot prompt with the marker. The marker sits on its own line
 * followed by a blank line so it cannot run into the prompt's first sentence.
 */
export function markMachineOneshotPrompt(prompt: string): string {
  return `${ONESHOT_MARKER}\n\n${prompt}`;
}

/**
 * How much of a JSONL's head is examined. The first user entry's JSON prefix
 * (`parentUuid`, `cwd`, `sessionId`, `version`, `gitBranch`, …) runs a few
 * hundred bytes even with a long repo path, so 4 KiB is generous while keeping
 * the check to a single small read per session — the capture sweep runs this on
 * every discovered session on every tick.
 */
const HEAD_BYTES = 4096;

/**
 * The marker must appear as the START of the first message's content. Claude
 * records a `-p` prompt as a plain string (`"content":"…"`); the array-of-blocks
 * form is accepted too so a future CLI change in how `-p` is journaled does not
 * silently re-enable capture of every housekeeping run.
 */
const NEEDLES = [`"content":"${ONESHOT_MARKER}`, `"text":"${ONESHOT_MARKER}`];

/** Does this JSONL head carry the marker in a position only lazy could put it? */
export function headHasOneshotMarker(head: string): boolean {
  return NEEDLES.some(needle => head.includes(needle));
}

/**
 * Is `filePath` the session JSONL of a machine-generated lazy one-shot?
 *
 * Reads only the head of the file. An unreadable file is reported as NOT a
 * one-shot: the fallback must always be "treat it as a real conversation", so a
 * transient read failure can never silently drop history. The reason is logged
 * at debug rather than thrown — this runs inside discovery, which is per-session
 * fault-tolerant by design, and the subsequent parse will surface a real
 * problem with the file loudly.
 */
export async function isMachineOneshotSessionFile(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (err) {
    logger.debug(`Could not open ${filePath} to check for the one-shot marker: ${(err as Error).message}`);
    return false;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return headHasOneshotMarker(buf.subarray(0, bytesRead).toString('utf-8'));
  } catch (err) {
    logger.debug(`Could not read ${filePath} to check for the one-shot marker: ${(err as Error).message}`);
    return false;
  } finally {
    await handle.close();
  }
}
