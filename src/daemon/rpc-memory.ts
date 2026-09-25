/**
 * RPC transport for the memory authoring + compact surface.
 *
 * Thin adapters: validate the params, call the SAME `createMemoryActions()`
 * implementation the daemon's own web handler calls, return its result.
 * Authoring validation and compact orchestration stay in src/memory/, reached
 * through memory-service.ts, so the CLI, this RPC, and the in-process dashboard
 * cannot disagree about what a valid record looks like or when a compact is
 * refused.
 *
 * MODULE CYCLE, deliberately: rpc-handlers imports this module for its dispatch
 * switch, this module imports memory-service, and memory-service imports
 * rpc-handlers for `getOrCreateStorage`. Every edge resolves to a hoisted
 * function declaration and no module in the loop runs anything at import time
 * that reaches another, so evaluation order cannot matter. Keep it that way:
 * do not add top-level code here that CALLS into memory-service.
 *
 * Compact is a long LLM call. The `progress` emitter is the heartbeat
 * envelope's phase stream, so a client that opted into `X-Lazy-Heartbeat`
 * sees "waiting on the model" rather than a silent socket.
 */

import { randomUUID } from 'crypto';
import { createMemoryActions, getMemoryStorage } from './memory-service';
import { actorEmail, actorRole } from '../actor-ref';
import type { ActorInput } from '../types';
import { teamModeEnabled, getUserCredential } from './user-credentials';
import {
  planTurnCredential,
  credentialEnvForPlan,
  releaseTurnCredential,
  TurnCredentialUnavailableError,
  NO_OWNER_CREDENTIAL_MARKER,
} from './turn-credentials';
import { loadCompactContext } from '../memory/run-compact';
import { memoryStatusPayload, compactRunSizeLine } from '../memory/context-status';
import {
  requireString,
  requireNonBlankString,
  optionalString,
  optionalEnum,
} from './rpc-params';
import { RpcError } from './rpc-error';
import type { ProgressEmitter } from './progress';
import type { CompactMode, CompactProgressEvent } from '../memory/run-compact';

const COMPACT_MODES = ['auto', 'llm', 'mechanical'] as const;

/**
 * The actor a memory write is recorded under: the one `applyCallerActor`
 * stamped on the request (a member's token, or the daemon's git identity on a
 * laptop), never a person the request named for itself.
 *
 * INVARIANT: an AGENT never writes shared memory. Memory is injected into every
 * future prompt, so an agent-writable store is a prompt-injection channel; the
 * MCP layer refuses `lazy_memory_save`, and these commands refuse the `agent`
 * role too, so no second door exists.
 */
function memoryWriteActor(params: Record<string, unknown>): ActorInput | undefined {
  const actor = params.actor as ActorInput | undefined;
  if (actorRole(actor) === 'agent') {
    throw new RpcError(403, 'Shared memory is written by people. Agents may read it but not write it.');
  }
  return actor;
}

/**
 * Run `fn` with the credential env a compact's MODEL run must carry.
 *
 * A single-user install, or a mechanical compact (no model at all), runs
 * exactly as before: no env, the builder credential if anything. In team mode
 * the run is billed to the person who asked — as the SPENDER of a launch beside
 * any task, so no task's turn owner is touched — and a person with no
 * credential is REFUSED rather than silently billed to someone else or quietly
 * downgraded to a mechanical compact. With no person at all (a control-plane
 * call) the project's service credential pays, and lacking one the call is
 * refused the same way.
 */
export async function withCompactCredential<T>(
  projectRoot: string,
  actor: ActorInput | undefined,
  mode: CompactMode | undefined,
  fn: (env: Array<{ key: string; value: string }> | undefined) => Promise<T>,
): Promise<T> {
  if (mode === 'mechanical') return fn(undefined);
  if (!(await teamModeEnabled(projectRoot))) return fn(undefined);
  const { offline } = await loadCompactContext(projectRoot);
  // Offline forces the mechanical generator: no model runs, nobody pays.
  if (offline) return fn(undefined);

  const email = actorEmail(actor);
  if (email && !(await getUserCredential(projectRoot, email))) {
    throw new RpcError(
      400,
      `${NO_OWNER_CREDENTIAL_MARKER}: compacting memory with a model is billed to the person who ` +
      `asked — user '${email}' has no Anthropic credential stored in this daemon. ` +
      'Connect your Claude account and retry, or run a mechanical compact, which needs no model.',
    );
  }
  // A key of its own: a compact belongs to no task, and must never re-point a
  // real task's binding.
  const key = `oneshot:memory-compact:${randomUUID()}`;
  try {
    let plan;
    try {
      plan = await planTurnCredential(projectRoot, {
        taskId: key,
        sessionId: key,
        ...(email ? { spender: { email } } : {}),
      });
    } catch (err) {
      if (err instanceof TurnCredentialUnavailableError) throw new RpcError(400, err.message);
      throw err;
    }
    return await fn(credentialEnvForPlan(plan) ?? undefined);
  } finally {
    await releaseTurnCredential(projectRoot, key);
  }
}

function compactProgressToRpc(progress: ProgressEmitter | undefined) {
  return (event: CompactProgressEvent): void => {
    if (!progress) return;
    if (event.state === 'plan') {
      progress({
        kind: 'plan',
        operation: 'compact',
        phases: [
          { id: 'generate', label: 'Generate compact from live records' },
          { id: 'save', label: 'Save compact' },
        ],
      });
      return;
    }
    progress({
      kind: 'phase',
      id: event.label.toLowerCase().includes('save') ? 'save' : 'generate',
      label: event.label,
      state: event.state,
      index: 0,
      total: 2,
      detail: event.detail,
    });
  };
}

export async function handleSaveMemoryRecord(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const actor = memoryWriteActor(params);
  const input = {
    name: requireNonBlankString(params, 'name'),
    description: optionalString(params, 'description'),
    type: optionalString(params, 'type'),
    body: requireString(params, 'body'),
  };
  try {
    return await createMemoryActions(projectRoot, actor).save(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }
}

export async function handleDeleteMemoryRecord(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const actor = memoryWriteActor(params);
  const name = requireNonBlankString(params, 'name');
  try {
    const removed = await createMemoryActions(projectRoot, actor).remove(name);
    if (!removed) {
      throw new RpcError(404, `No memory record named '${name}'.`);
    }
    return removed;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }
}

export async function handleCompactMemory(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const mode = optionalEnum(params, 'mode', COMPACT_MODES) as CompactMode | undefined;
  const model = optionalString(params, 'model');
  const actor = memoryWriteActor(params);
  try {
    const result = await withCompactCredential(projectRoot, actor, mode, (ownerCredentialEnv) =>
      createMemoryActions(projectRoot, actor).compact(
        { mode, model, ...(ownerCredentialEnv ? { ownerCredentialEnv } : {}) },
        compactProgressToRpc(progress),
      ));
    // The run's before→after sentence, spelled by the same function the
    // dashboard's stream prints, so a remote client never re-derives it.
    return { ...result, sizeLine: compactRunSizeLine(result) };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcError(400, message);
  }
}

export async function handleClearMemoryCompact(projectRoot: string, params: Record<string, unknown> = {}) {
  const actor = memoryWriteActor(params);
  return { cleared: await createMemoryActions(projectRoot, actor).clearCompact() };
}

/**
 * The injected-context ANSWER for a memory surface — sizes against
 * `[memory] warn_bytes`, what the compact covers, what it misses — built by the
 * same function the daemon's own dashboard renders (src/memory/context-status.ts).
 * A read: Lazy Teams renders it as-is rather than re-deriving any of it.
 */
export async function handleMemoryStatus(projectRoot: string) {
  const storage = await getMemoryStorage();
  const { warnBytes } = await loadCompactContext(projectRoot);
  const records = await storage.listMemories();
  const compact = await storage.getMemoryCompact();
  return memoryStatusPayload(records, compact, warnBytes);
}
