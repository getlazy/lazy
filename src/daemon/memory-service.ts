/**
 * Memory service — the daemon-side implementation of the web memory writes.
 *
 * The web layer (src/server/) must not import src/daemon/ (the daemon already
 * imports the server, so the reverse edge would be a cycle). It declares the
 * narrow `MemoryActions` port instead, and this is what the daemon injects —
 * the same arrangement as message-service.ts.
 *
 * Authoring validation (`prepareAuthoredMemoryWrite`) and compact orchestration
 * (`runMemoryCompact`) live in src/memory/, shared with the CLI. This file
 * supplies the two things the web layer cannot: the daemon's Storage instance,
 * and the actor.
 *
 * ACTOR: every write names a role AND, where one can be named, the PERSON.
 *   - over RPC (`saveMemoryRecord` & co. — the CLI, Lazy Teams), the handler
 *     passes the actor `applyCallerActor` stamped from the caller: a member's
 *     token on a managed host, the daemon's git identity on a laptop;
 *   - from the daemon's own dashboard, a loopback surface the machine's owner
 *     sits in front of, the role is `human` and the person is the daemon's git
 *     identity when it is configured — the same person a laptop's CLI write
 *     names. Unconfigured, the write keeps the bare role, as it always did.
 * Compact is derived state, and its `generated_by` follows the same rule.
 */

import { getOrCreateStorage } from './rpc-handlers';
import type { MemoryActions, MemorySaveInput } from '../server/memory-actions';
import type { Storage } from '../storage';
import type { ActorInput, MemoryRecord } from '../types';
import { resolveGitIdentity } from '../identity';
import { isManagedMode } from '../config/managed';
import { sanitizeUserText } from '../utils/sanitize-text';
import {
  normalizeMemoryName,
  prepareAuthoredMemoryWrite,
} from '../memory';
import { assertBesideLaunchAllowed } from './usage-pause';
import { loadConfig } from '../config/loader';
import {
  loadCompactContext,
  runMemoryCompact,
  clearMemoryCompact,
  type CompactMode,
  type CompactProgressFn,
  type MemoryCompactRunResult,
} from '../memory/run-compact';

/**
 * The dashboard's actor: `human`, plus the daemon's git identity when it is
 * configured. Resolved per write (cached 60s inside `resolveGitIdentity`), so a
 * config fixed while the daemon runs is picked up without a restart.
 */
async function dashboardActor(projectRoot: string): Promise<ActorInput> {
  // Managed mode names people by token only; the environment names nobody.
  if (isManagedMode()) return 'human';
  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) return 'human';
  const { email, name } = resolution.identity;
  return { role: 'human', email, ...(name ? { name } : {}) };
}

/**
 * A `MemoryActions` over any Storage, bound to a project root (compact needs
 * `[memory] warn_bytes` and offline mode from that project's config).
 *
 * Two callers, both of which are the daemon acting: the daemon's own dashboard
 * passes its in-process Storage, and the from-source dev server passes a
 * `RemoteStorage`, whose writes are the daemon's storage RPC — except compact,
 * which the RPC client implementation (src/cli/memory-actions-rpc.ts) sends as
 * the `compactMemory` command so the LLM call runs in the daemon, not in the
 * dev-server process.
 */
export function createStorageMemoryActions(
  getStorage: () => Promise<Storage>,
  projectRoot: string,
  actorInput?: ActorInput,
): MemoryActions {
  const who = async (): Promise<ActorInput> => actorInput ?? dashboardActor(projectRoot);
  return {
    async save(input: MemorySaveInput): Promise<MemoryRecord> {
      const storage = await getStorage();
      // Look up by the NORMALIZED name so "VM Credentials Idea" and
      // "vm-credentials-idea" update the same record rather than creating a
      // near-duplicate. Invalid names throw here, before any write.
      const name = normalizeMemoryName(input.name);
      const existing = await storage.getMemory(name);
      const prepared = prepareAuthoredMemoryWrite(
        {
          name,
          description: input.description,
          type: input.type,
          // INTAKE BOUNDARY: a raw NUL from a form would corrupt every read
          // surface (and this text is injected into prompts). Escape at the door.
          body: sanitizeUserText(input.body),
        },
        existing,
      );
      return storage.saveMemory(prepared, await who());
    },

    async remove(nameInput: string): Promise<MemoryRecord | null> {
      const storage = await getStorage();
      const name = normalizeMemoryName(nameInput);
      return storage.deleteMemory(name, await who());
    },

    async compact(
      options: { mode?: CompactMode; model?: string; ownerCredentialEnv?: Array<{ key: string; value: string }> },
      onProgress?: CompactProgressFn,
    ): Promise<MemoryCompactRunResult> {
      const storage = await getStorage();
      // INVARIANT ([usage_pause]): a compact that runs a model spends the
      // builder role's credential, and a person asked for it — so a paused
      // credential REFUSES it before anything runs. Judged HERE, in the one
      // compact path, because there are two doors to it: the `compactMemory`
      // RPC (`lazy memory compact`, Lazy Teams) and the daemon dashboard's own
      // compact button, which calls these actions in process. Gating only the
      // RPC left the button spending a paused credential. A mechanical or
      // offline compact runs no model and is never judged.
      if (options.mode !== 'mechanical' && !(await loadCompactContext(projectRoot)).offline) {
        await assertBesideLaunchAllowed(projectRoot, {
          config: await loadConfig(projectRoot),
          actor: await who(),
          what: 'a memory compact with a model',
          note: 'A mechanical compact needs no model: lazy memory compact --mechanical',
        });
      }
      return runMemoryCompact({
        storage,
        projectRoot,
        mode: options.mode,
        model: options.model,
        actor: await who(),
        onProgress,
        ...(options.ownerCredentialEnv ? { ownerCredentialEnv: options.ownerCredentialEnv } : {}),
      });
    },

    async clearCompact(): Promise<boolean> {
      const storage = await getStorage();
      return clearMemoryCompact(storage);
    },
  };
}

/**
 * The daemon's own implementation, bound to its single long-lived Storage.
 * `actor` is the RPC caller's stamped actor; omitted (the dashboard), the
 * daemon's own git identity is used.
 */
export function createMemoryActions(projectRoot: string, actor?: ActorInput): MemoryActions {
  return createStorageMemoryActions(getOrCreateStorage, projectRoot, actor);
}

/** The daemon's Storage, for the memory READ commands (src/daemon/rpc-memory.ts). */
export function getMemoryStorage(): Promise<Storage> {
  return getOrCreateStorage();
}
