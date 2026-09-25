/**
 * Shared compact orchestration — generate, reject-if-bigger, save.
 *
 * Both `lazy memory compact` (CLI) and the daemon web UI / `compactMemory` RPC
 * run THIS function rather than each re-implementing the rejection invariant.
 * Generation itself lives in `./compact.ts`; this file is the "should we save
 * it, and what do we tell the human" layer that used to live only in the CLI.
 *
 * Progress is a callback of human-readable phase events so a CLI can print
 * them, an RPC can wrap them in the heartbeat envelope, and a browser can
 * stream them as HTML — one narration, three transports.
 */

import { join } from 'path';
import type { Storage } from '../storage/interface';
import type { ActorInput, MemoryCompact, MemoryRecord } from '../types';
import { loadConfig } from '../config/loader';
import { isOfflineMode } from '../utils/offline';
import {
  assembleMemorySection,
  isLiveMemory,
} from './index';
import {
  generateMemoryCompact,
  type CompactMode,
} from './compact';

export type { CompactMode };

/** One phase of a compact run, for any surface that narrates progress. */
export interface CompactProgressEvent {
  /** Human label ("Generate compact from live records"). */
  label: string;
  state: 'plan' | 'start' | 'done' | 'skipped' | 'failed';
  detail?: string;
}

export type CompactProgressFn = (event: CompactProgressEvent) => void;

/**
 * What a compact run did. `saved` is the compact now in the store (or the
 * previous one when this run wrote nothing). `rejected` is the load-bearing
 * case: a candidate existed but would have grown injection, so nothing was
 * written.
 */
export interface MemoryCompactRunResult {
  saved: MemoryCompact | null;
  rejected: boolean;
  notes: string[];
  liveCount: number;
  beforeBytes: number;
  afterBytes: number;
  plainBytes: number;
  warnBytes: number;
  previous: MemoryCompact | null;
  /** One-line outcome for a banner ("Compacted 62 records using mechanical"). */
  message: string;
}

export interface RunMemoryCompactOptions {
  storage: Storage;
  /** Project root — used to load `[memory] warn_bytes` and offline mode. */
  projectRoot: string;
  mode?: CompactMode;
  model?: string;
  /** Role, and — when the write can be attributed — the person. */
  actor: ActorInput;
  onProgress?: CompactProgressFn;
  /** See GenerateCompactOptions.ownerCredentialEnv. */
  ownerCredentialEnv?: Array<{ key: string; value: string }>;
}

/**
 * Load the compact-relevant config for a project: the advisory size threshold
 * and whether offline mode is on (which forces the mechanical generator).
 *
 * Split out so the RPC handler and the in-process action port resolve the same
 * two values the same way, rather than each guessing which config keys matter.
 */
export async function loadCompactContext(projectRoot: string): Promise<{
  warnBytes: number;
  offline: boolean;
}> {
  const config = await loadConfig(projectRoot);
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  return { warnBytes: config.memory.warn_bytes, offline };
}

/**
 * Run one compaction: read the live records, generate a candidate from them
 * (never from the previous compact), refuse it if it would grow injection,
 * otherwise overwrite the compact slot.
 *
 * INVARIANT: records are never modified. The only write is `saveMemoryCompact`.
 */
export async function runMemoryCompact(
  options: RunMemoryCompactOptions,
): Promise<MemoryCompactRunResult> {
  const mode: CompactMode = options.mode ?? 'auto';
  const { storage, actor, onProgress } = options;
  const { warnBytes, offline } = await loadCompactContext(options.projectRoot);

  const emit = (event: CompactProgressEvent): void => {
    try {
      onProgress?.(event);
    } catch {
      // Narration must never fail the compact — a hung-up browser or a
      // dropped RPC stream is observational, not operational.
    }
  };

  const records: MemoryRecord[] = await storage.listMemories();
  const live = records.filter(isLiveMemory);
  const previous = await storage.getMemoryCompact();

  const sectionBytes = (compact: MemoryCompact | null): number =>
    assembleMemorySection(records, 'builder', { compact, warnBytes }).measured.bytes;

  const beforeBytes = sectionBytes(previous);
  const plainBytes = sectionBytes(null);

  const base = {
    notes: [] as string[],
    liveCount: live.length,
    beforeBytes,
    afterBytes: beforeBytes,
    plainBytes,
    warnBytes,
    previous,
  };

  if (live.length === 0) {
    emit({
      label: 'No memory records to compact',
      state: 'plan',
      detail: 'Add a record first; compaction is a summary of existing records.',
    });
    return {
      ...base,
      saved: previous,
      rejected: false,
      message: 'No memory records to compact.',
    };
  }

  const generatorDetail = mode === 'mechanical'
    ? 'mechanical, no model'
    : offline
      ? `${mode} — offline mode is on, so the mechanical path will be used`
      : mode === 'llm'
        ? `llm (required)${options.model ? `, ${options.model}` : ', Claude CLI default'}`
        : `llm, falling back to mechanical${options.model ? ` (${options.model})` : ''}`;

  emit({
    label: `Compacting ${live.length} memory record(s)`,
    state: 'plan',
    detail:
      `last compact: ${previous
        ? `${new Date(previous.generated_at).toISOString()} (${previous.method}, ${previous.covered.length} record(s))`
        : 'never'}` +
      ` · generator: ${generatorDetail}`,
  });

  emit({
    label: 'Generate compact from live records',
    state: 'start',
    detail: mode !== 'mechanical' && !offline
      ? 'waiting on the model — this usually takes a few seconds'
      : undefined,
  });

  let result;
  try {
    result = await generateMemoryCompact(live, {
      mode,
      model: options.model,
      targetBytes: warnBytes,
      offline,
      ...(options.ownerCredentialEnv ? { ownerCredentialEnv: options.ownerCredentialEnv } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ label: 'Generate compact from live records', state: 'failed', detail: message });
    throw err;
  }

  emit({
    label: 'Generate compact from live records',
    state: 'done',
    detail: result.notes[0],
  });

  if (!result.input) {
    emit({
      label: 'Save compact',
      state: 'skipped',
      detail: 'candidate would not shrink the injected context — existing compact unchanged',
    });
    return {
      ...base,
      saved: previous,
      rejected: true,
      notes: result.notes,
      message: 'No compact written — compaction would not shrink the injected context.',
    };
  }

  emit({ label: 'Save compact', state: 'start' });
  const saved = await storage.saveMemoryCompact(result.input, actor);
  const afterBytes = sectionBytes(saved);
  emit({
    label: 'Save compact',
    state: 'done',
    detail: `${saved.method}${saved.model ? ` (${saved.model})` : ''}, ${saved.covered.length} record(s)`,
  });

  return {
    ...base,
    saved,
    rejected: false,
    notes: result.notes,
    afterBytes,
    message:
      `Compacted ${saved.covered.length} memory record(s) using ${saved.method} compaction` +
      `${saved.model ? ` (${saved.model})` : ''}.`,
  };
}

/** Drop the compact so injection falls back to the full index. Derived state — always safe. */
export async function clearMemoryCompact(storage: Storage): Promise<boolean> {
  return storage.clearMemoryCompact();
}
