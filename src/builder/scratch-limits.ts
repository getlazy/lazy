/**
 * Size caps for the builder scratch sandbox.
 *
 * WHY CAPS AT ALL: the store travels with the project and is pushed around
 * (external store, remote store, `lazy store push`). An unbounded stream in it
 * is not a theoretical risk — the proxy audit log once grew the store to 677 MiB
 * and broke a push, which is why that log was moved OUT of Storage entirely.
 * Scratch pads are the same shape of hazard: a builder dumping a database
 * export or a heap snapshot into `$LAZY_SCRATCH_DIR` would otherwise put it in
 * the store forever.
 *
 * The difference from the audit log — and why scratch belongs in Storage anyway
 * — is that scratch content is curated by construction: a human-facing artifact
 * a builder wrote on purpose. So it is bounded rather than exiled.
 *
 * WHY THESE NUMBERS: 1 MiB is far more prose than any review message, analysis
 * dump or draft document a builder writes for a human — a 1 MiB markdown file is
 * roughly a 300-page book. 32 MiB of total sandbox leaves room for hundreds of
 * such documents while staying an order of magnitude below anything that makes
 * a store awkward to move.
 *
 * These are deliberately NOT configurable. A knob here invites raising the cap
 * instead of asking why a builder is putting a 200 MB file in a scratch pad,
 * and the answer to that is always "keep it on the host".
 *
 * Own module (rather than living in scratch.ts) so both the storage layer and
 * the capture layer can import the caps without storage depending on the
 * filesystem-facing scratch module.
 */

/** Largest single file whose content is persisted, in bytes. */
export const MAX_SCRATCH_FILE_BYTES = 1024 * 1024;

/** Largest total stored content across the whole sandbox, in bytes. */
export const MAX_SCRATCH_SANDBOX_BYTES = 32 * 1024 * 1024;

/**
 * Reject a scratch write whose content exceeds the per-file cap.
 *
 * Enforced in the storage layer rather than only at the capture site so the cap
 * holds for EVERY caller of `saveScratchFile`, present and future — a bound that
 * only one code path respects is not a bound. Capture classifies oversize files
 * as `skipped: 'too_large'` before they ever get here; anything that reaches
 * this check is a bug in a caller, so it throws rather than silently trimming.
 */
export function assertScratchFileWithinCap(input: {
  path: string;
  content: string;
  skipped?: unknown;
}): void {
  const bytes = Buffer.byteLength(input.content, 'utf-8');
  if (bytes <= MAX_SCRATCH_FILE_BYTES) return;
  throw new Error(
    `Scratch file "${input.path}" is ${formatBytes(bytes)}, over the ` +
    `${formatBytes(MAX_SCRATCH_FILE_BYTES)} per-file cap for persisted scratch content. ` +
    `Content is stored whole or not at all — never truncated. Keep the large file in the ` +
    `live scratch dir ($LAZY_SCRATCH_DIR) and persist a smaller summary instead, or store ` +
    `it with skipped: 'too_large' to record that it exists without its body.`,
  );
}

/** Human-readable byte size, for cap messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
