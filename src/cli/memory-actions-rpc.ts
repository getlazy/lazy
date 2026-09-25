/**
 * A `MemoryActions` implementation backed by the daemon's memory RPC commands.
 *
 * The counterpart of src/daemon/rpc-memory.ts. Together they make the memory
 * port reachable by a client that is NOT the daemon: the from-source web UI
 * is handed one of these instead of `createMemoryActions()`, renders
 * identically, and every mutation lands in memory-service.ts on the daemon
 * side exactly as it does for the daemon's own dashboard.
 *
 * Compact in particular MUST go over RPC rather than running `generateMemoryCompact`
 * in this process: the LLM oneshot uses the daemon's runner. Save/delete could
 * ride RemoteStorage, but then authoring validation would run here AND in the
 * daemon (or only here, skipping the daemon's copy). One RPC keeps one copy.
 *
 * It lives in src/cli/ for the same cycle reason as review-actions-rpc.ts:
 * src/server/ must not import src/daemon/.
 */

import { RpcApplicationError, type DaemonClient } from '../daemon/client';
import type {
  MemoryActions,
  MemorySaveInput,
  CompactMode,
  CompactProgressFn,
  MemoryCompactRunResult,
} from '../server/memory-actions';
import type { MemoryRecord } from '../types';

export function createRpcMemoryActions(client: DaemonClient, projectRoot: string): MemoryActions {
  const call = (command: string, params: Record<string, unknown> = {}, onProgress?: CompactProgressFn) =>
    client.rpc(
      command,
      projectRoot,
      params,
      onProgress
        ? {
            onProgress: (event) => {
              if (event.kind === 'plan') {
                onProgress({
                  label: event.operation,
                  state: 'plan',
                  detail: event.phases.map((p) => p.label).join(' · '),
                });
                return;
              }
              if (event.kind === 'phase') {
                onProgress({
                  label: event.label,
                  // Compact's narration has no 'progress' tick — the RPC
                  // envelope added that state for other long ops. Treat it
                  // as still-running, same as start.
                  state: event.state === 'progress' ? 'start' : event.state,
                  detail: event.detail,
                });
              }
            },
          }
        : undefined,
    );

  return {
    async save(input: MemorySaveInput): Promise<MemoryRecord> {
      return (await call('saveMemoryRecord', { ...input })) as MemoryRecord;
    },
    async remove(name: string): Promise<MemoryRecord | null> {
      try {
        return (await call('deleteMemoryRecord', { name })) as MemoryRecord;
      } catch (err) {
        // The RPC 404s when the name is absent; the in-process port returns
        // null (storage's own idempotent delete). Translate so the web layer
        // cannot tell which implementation it was handed.
        if (err instanceof RpcApplicationError && err.status === 404) return null;
        throw err;
      }
    },
    async compact(
      options: { mode?: CompactMode; model?: string },
      onProgress?: CompactProgressFn,
    ): Promise<MemoryCompactRunResult> {
      return (await call(
        'compactMemory',
        { mode: options.mode, model: options.model },
        onProgress,
      )) as MemoryCompactRunResult;
    },
    async clearCompact(): Promise<boolean> {
      const { cleared } = (await call('clearMemoryCompact')) as { cleared: boolean };
      return cleared;
    },
  };
}
