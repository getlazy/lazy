/**
 * The port through which the web memory pages MUTATE shared memory.
 *
 * Same shape and same reason as `MessageActions` (./message-actions.ts): reads
 * in the web layer go through the `Storage` instance it was handed, but every
 * WRITE goes through this port, which is implemented in the daemon
 * (src/daemon/memory-service.ts). The web handler never calls `saveMemory` /
 * `deleteMemory` / `saveMemoryCompact` itself, and never takes the storage lock.
 *
 * WHY A PORT AND NOT STORAGE DIRECTLY. `storage.saveMemory` is mechanistic —
 * it stores what it is given, which is the contract the import path needs.
 * Authoring (name slug, type enum, description length, non-empty body) lives
 * OUTSIDE storage, on every surface that a human types into (`lazy memory save`,
 * `lazy_memory_save`, this UI). Routing writes through this port is how the
 * dashboard gets that validation without becoming a second authoring
 * implementation, and how compact (an LLM call, not a storage method) stays a
 * daemon operation.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests), the pages still RENDER — listing and showing are plain storage reads
 * — but the mutating routes answer 503 rather than half-working.
 */

import type { MemoryRecord, MemoryCompact } from '../types';
import type {
  CompactMode,
  CompactProgressFn,
  MemoryCompactRunResult,
} from '../memory/run-compact';

export type { CompactMode, CompactProgressFn, MemoryCompactRunResult };

/** Fields the create/update form posts. Description/type optional on update. */
export interface MemorySaveInput {
  name: string;
  description?: string;
  type?: string;
  body: string;
}

export interface MemoryActions {
  /** Create or update a record. Authoring validation happens here, not in Storage. */
  save(input: MemorySaveInput): Promise<MemoryRecord>;
  /**
   * Tombstone a record. History is preserved. Returns the tombstoned record,
   * or null when the name was already absent (idempotent, matching storage).
   */
  remove(name: string): Promise<MemoryRecord | null>;
  /**
   * Regenerate the derived compact from the live records. Streams progress
   * through `onProgress` so a long LLM call is never silent.
   */
  compact(
    options: {
      mode?: CompactMode;
      model?: string;
      /** Team mode: bills the model run to the asking member (daemon-side only). */
      ownerCredentialEnv?: Array<{ key: string; value: string }>;
    },
    onProgress?: CompactProgressFn,
  ): Promise<MemoryCompactRunResult>;
  /** Delete the compact; injection falls back to the full index. */
  clearCompact(): Promise<boolean>;
}

/** Re-export so pages that render a compact run don't import from src/memory. */
export type { MemoryCompact };
