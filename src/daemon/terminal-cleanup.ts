/** Finished-task resource cleanup. Preview and sweep share fresh lifecycle,
 * lock and member checks; failures are durable admin diagnostics. */
import { createHash } from 'crypto';
import { readdir } from 'fs/promises';
import { join } from 'path';
import type { Storage } from '../storage';
import type { Task, Session } from '../types';
import type { TerminalCleanupItem, TerminalCleanupState } from '../storage/terminal-cleanup-state';
import { findTerminalTaskWorktrees, directorySizeBytes } from '../doctor/findings';
import { cleanupTaskContainer, cleanupWorktree } from '../task/cleanup';
import { displayId, getWorktreePath, taskRef } from '../task/identity';
import { isTerminalStatus } from '../task-state-machine';
import { readLock } from '../utils/lock';
import { createRunner } from '../runner';
import { memberTerminalHolders, endMemberSessions } from '../server/member-terminals';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { listMemberContainers, memberHomesDir, MEMBER_CONTAINER_PREFIX, removeMemberContainer, handBackMemberHome } from './member-container';
import { releaseMemberContainerCredential, memberTerminalGrantLabel } from '../server/member-exec-credential';
import { DiskSpaceError } from '../docker/disk-space';
import { logger } from '../utils/logger';
import { spawn } from '../utils/spawn';
import { listTaskDataVolumeNames, taskDataVolumeName } from '../runner/task-data';

export interface TerminalCleanupDeps {
  inventory(tasks: Task[]): Promise<{ items: TerminalCleanupItem[]; errors: string[] }>;
  locked(path: string): Promise<boolean>;
  members(taskId: string): string[];
  endMembers(taskId: string): Promise<void>;
  remove(item: TerminalCleanupItem, task: Task, session: Session | null): Promise<void>;
}
const key = (i: TerminalCleanupItem) => `${i.taskId}:${i.kind}:${i.id}`;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const empty = (): TerminalCleanupState => ({ lastRun: null, failures: [] });

export function terminalCleanupDeps(root: string, storage: Storage): TerminalCleanupDeps {
  return {
    // readLock includes this process's locks too. checkLock deliberately
    // permits re-entry, which must never authorize a cleanup sweep.
    locked: async path => !!await readLock(path), members: memberTerminalHolders, endMembers: endMemberSessions,
    inventory: async tasks => {
      const items: TerminalCleanupItem[] = (await findTerminalTaskWorktrees(root, storage)).map(w => ({
        kind: 'worktree', id: w.path, taskId: w.taskId, taskCode: w.taskCode, name: w.taskCode, bytes: w.sizeBytes,
      }));
      const errors: string[] = [];
      const binaries = new Set<string>();
      const runners = new Map<string, ReturnType<typeof createRunner>>();
      const containers = new Map<string, Promise<Set<string>>>();
      const volumes = new Map<string, Promise<Set<string> | null>>();
      for (const task of tasks) {
        const session = await storage.getSessionByTaskId(task.id);
        if (!session) continue;
        try {
          const runnerKey = session.runner_type ?? 'default';
          if (!runners.has(runnerKey)) runners.set(runnerKey, createRunner(root, session.runner_type ?? undefined));
          const runner = await runners.get(runnerKey)!;
          if (runner.type === 'docker' || runner.type === 'podman') binaries.add(runner.type);
          const name = session.container_name ?? runner.runNameForTask(taskRef(task));
          let exists: boolean;
          if (runner.type === 'docker' || runner.type === 'podman') {
            const binary = runner.type;
            if (!containers.has(binary)) containers.set(binary, (async () => {
              const p = spawn([binary, 'ps', '-a', '--filter', `label=lazy.project=${root}`, '--format', '{{.Names}}'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
              const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
              if (code !== 0) throw new Error(`Could not list project environments: ${err.trim() || `exit ${code}`}`);
              return new Set(out.trim().split('\n').filter(Boolean));
            })());
            exists = (await containers.get(binary)!).has(name);
          } else {
            const probe = runner.probeRunInfo ? await runner.probeRunInfo(name) : { kind: 'answered' as const, info: await runner.getRunInfo(name) };
            if (probe.kind === 'no-answer') throw new Error(probe.reason);
            exists = !!probe.info;
          }
          if (exists) items.push({ kind: 'task-container', id: name, taskId: task.id, taskCode: displayId(task), name, bytes: null });
        } catch (e) { errors.push(`${displayId(task)}: could not inspect task environment: ${message(e)}`); }
        // A data dir its terminal teardown could not remove (a member still held
        // it). A cheap name listing; a failure to list is logged and leaves the
        // item out — it must never block this sweep's worktrees and containers.
        const runner = await runners.get(session.runner_type ?? 'default')?.catch(() => null);
        if (runner && (runner.type === 'docker' || runner.type === 'podman')) {
          const binary = runner.type;
          if (!volumes.has(binary)) volumes.set(binary, listTaskDataVolumeNames(binary).catch((e) => {
            logger.warn(`Finished-task cleanup could not list task data volumes: ${message(e)}`);
            return null;
          }));
          const vol = taskDataVolumeName(task.id);
          if ((await volumes.get(binary)!)?.has(vol)) items.push({ kind: 'task-data', id: vol, taskId: task.id, taskCode: displayId(task), name: vol, bytes: null });
        }
      }
      let homes: string[] = [];
      try { homes = (await readdir(memberHomesDir(root))).filter(n => n.startsWith(MEMBER_CONTAINER_PREFIX)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const members = new Map<string, string>();
      for (const binary of binaries) {
        try { for (const env of await listMemberContainers(root, binary)) members.set(env.name, env.taskId); }
        catch (e) { errors.push(message(e)); }
      }
      for (const name of new Set([...homes, ...members.keys()])) {
        const task = tasks.find(t => members.get(name) === t.id || (!members.has(name) && name.startsWith(`${MEMBER_CONTAINER_PREFIX}${t.id.slice(0, 8)}-`)));
        if (!task) continue;
        items.push({ kind: 'member-environment', id: name, name, taskId: task.id, taskCode: displayId(task),
          bytes: homes.includes(name) ? await directorySizeBytes(join(memberHomesDir(root), name)) : null });
      }
      // A failed runtime check cannot authorize deleting files a member may
      // still be using. Keep file findings visible, with the actual error.
      if (errors.length) for (const item of items) item.blockedReason = `Environment check failed: ${errors.join('; ')}`;
      return { items, errors };
    },
    remove: async (item, task, session) => {
      if (item.kind === 'worktree') {
        await cleanupWorktree(getWorktreePath(root, task), root, storage, task.id, session?.agent_session_id ?? null);
      } else if (item.kind === 'task-data') {
        const runner = await createRunner(root, session?.runner_type ?? undefined);
        if (!runner.removeTaskData) throw new Error('This runtime has no task data directory to remove.');
        await runner.removeTaskData(task.id);
      } else if (item.kind === 'task-container') {
        if (!session) throw new Error('The task session is no longer available; refresh the cleanup preview.');
        await cleanupTaskContainer(storage, session, taskRef(task), root);
      } else {
        if (item.id === `${task.id}:sessions`) return; // endMembers already completed.
        const runner = await createRunner(root, session?.runner_type ?? undefined);
        if (runner.type !== 'docker' && runner.type !== 'podman') throw new Error('Cannot verify the runtime for this member environment.');
        const env = (await listMemberContainers(root, runner.type)).find(e => e.name === item.id && e.taskId === task.id);
        if (env) {
          if (env.bindingKey && env.email) await releaseMemberContainerCredential(root, env.bindingKey, memberTerminalGrantLabel(env.email, env.name));
          await removeMemberContainer(runner.type, env.name);
        }
        const homes: string[] = await readdir(memberHomesDir(root)).catch((e: NodeJS.ErrnoException): string[] => {
          if (e.code === 'ENOENT') return [];
          throw e;
        });
        if (homes.includes(item.id) && !await handBackMemberHome(root, join(memberHomesDir(root), item.id), storage)) {
          throw new Error('Could not save the member conversation and remove its environment; the files were kept.');
        }
      }
    },
  };
}

export class TerminalCleanupManager {
  private running: Promise<{ freedBytes: number; errors: string[] }> | null = null;
  constructor(private storage: Storage, private root: string, private deps = terminalCleanupDeps(root, storage)) {}

  async view() {
    const tasks = (await this.storage.listTasks()).filter(t => isTerminalStatus(t.status));
    const state = await this.storage.getTerminalCleanupState() ?? empty();
    let inventory;
    try { inventory = await this.deps.inventory(tasks); }
    catch (e) {
      // Failed inspection must leave earlier failures visible, never erase
      // them with an apparently empty inventory.
      inventory = { items: state.failures.map(f => ({ ...f.item })), errors: [message(e)] };
    }
    const { items, errors } = inventory;
    // Inventory helpers also re-list tasks. Filter again against this snapshot.
    const terminal = new Set(tasks.map(t => t.id));
    const current = items.filter(i => terminal.has(i.taskId));
    for (const task of tasks) {
      if (this.deps.members(task.id).length && !current.some(i => i.taskId === task.id && i.kind === 'member-environment')) {
        current.push({ kind: 'member-environment', id: `${task.id}:sessions`, taskId: task.id,
          taskCode: displayId(task), name: 'Member sessions', bytes: null });
      }
    }
    for (const item of current) {
      if (errors.length) item.blockedReason = `Environment check failed: ${errors.join('; ')}`;
      const task = tasks.find(t => t.id === item.taskId)!;
      if (await this.deps.locked(getWorktreePath(this.root, task))) item.blockedReason = 'A live worktree lock is still held.';
      else if (this.deps.members(task.id).length) item.blockedReason = 'Member sessions or environments are still open or being removed.';
    }
    const eligible = current.filter(i => !i.blockedReason);
    const id = createHash('sha256').update(JSON.stringify(eligible.map(key).sort())).digest('hex');
    return { ...state, items: current, errors, plan: { id, items: eligible, reclaimableBytes: eligible.reduce((n, i) => n + (i.bytes ?? 0), 0) } };
  }

  run(reason = 'Automatic finished-task cleanup', planId?: string): Promise<{ freedBytes: number; errors: string[] }> {
    if (this.running) {
      if (planId) throw new DiskSpaceError(409, 'Finished-task cleanup is already running. Refresh the preview when it finishes.');
      return this.running;
    }
    this.running = this.perform(reason, planId).finally(() => { this.running = null; });
    return this.running;
  }

  private async perform(reason: string, planId?: string) {
    const startedAt = new Date().toISOString();
    const state = await this.storage.getTerminalCleanupState() ?? empty();
    const removed: TerminalCleanupItem[] = [], skipped: TerminalCleanupItem[] = [];
    const errors: string[] = [];
    let freedBytes = 0;
    try {
      const view = await this.view();
      if (planId && view.plan.id !== planId) throw new DiskSpaceError(409, 'Finished-task removals changed. Review Free space again.');
      errors.push(...view.errors);
      const selected = planId ? view.plan.items : view.items;
      const taskIds = [...new Set(selected.map(i => i.taskId))];
      for (const id of taskIds) await withTaskLifecycleLock(id, async () => {
        const task = await this.storage.getTask(id);
        // Worktrees last; a task's data volume after its member environments,
        // which are what can still hold it.
        const rank = (i: TerminalCleanupItem) => i.kind === 'worktree' ? 2 : i.kind === 'task-data' ? 1 : 0;
        const candidates = selected.filter(i => i.taskId === id).sort((a, b) => rank(a) - rank(b));
        if (!task || !isTerminalStatus(task.status) || await this.deps.locked(getWorktreePath(this.root, task))) {
          skipped.push(...candidates); return;
        }
        // Task end is the lifecycle trigger for ending environments. A manual
        // Free space confirmation never ends an open member session.
        if (!planId && this.deps.members(id).length) {
          try { await this.deps.endMembers(id); }
          catch (e) {
            const item: TerminalCleanupItem = { kind: 'member-environment', id: `${id}:sessions`, taskId: id, taskCode: displayId(task), name: 'Member sessions', bytes: null };
            this.failed(state, item, e); errors.push(`${item.taskCode}: ${message(e)}`);
          }
        }
        const session = await this.storage.getSessionByTaskId(id);
        let environmentFailed = false;
        for (const item of candidates) {
          // Recheck at the deletion boundary, under the same lock as reopen
          // and member entry. A preview is never authority to remove live work.
          const latest = await this.storage.getTask(id);
          if (!latest || !isTerminalStatus(latest.status) || await this.deps.locked(getWorktreePath(this.root, latest)) ||
            this.deps.members(id).length || view.errors.length || (item.kind === 'worktree' && environmentFailed)) {
            skipped.push(item); continue;
          }
          try {
            if (item.id !== `${id}:sessions`) await this.deps.remove(item, latest, session);
            state.failures = state.failures.filter(f => key(f.item) !== key(item));
            removed.push(item); freedBytes += item.bytes ?? 0;
          } catch (e) {
            // A data volume is not the worktree's environment: its failure must not hold the worktree back.
            if (item.kind !== 'worktree' && item.kind !== 'task-data') environmentFailed = true;
            this.failed(state, item, e); errors.push(`${item.taskCode} (${item.kind}): ${message(e)}`);
          }
        }
      });
      // Retire historical failures only after a successful inventory proves
      // the resource is gone; an unavailable runtime is not proof of cleanup.
      if (!view.errors.length) state.failures = state.failures.filter(f =>
        view.items.some(i => key(i) === key(f.item)) || (f.item.id.endsWith(':sessions') && this.deps.members(f.item.taskId).length > 0));
    } catch (e) {
      if (e instanceof DiskSpaceError) throw e;
      errors.push(message(e));
    }
    state.lastRun = { startedAt, finishedAt: new Date().toISOString(), reason, removed, skipped, ...(errors.length ? { error: errors.join('\n') } : {}) };
    if (!planId) state.lastSweep = state.lastRun;
    await this.storage.saveTerminalCleanupState(state);
    if (errors.length) logger.warn(`Finished-task cleanup: ${errors.join('; ')}`);
    return { freedBytes, errors };
  }

  private failed(state: TerminalCleanupState, item: TerminalCleanupItem, e: unknown) {
    const at = new Date().toISOString();
    const previous = state.failures.find(f => key(f.item) === key(item));
    state.failures = [...state.failures.filter(f => key(f.item) !== key(item)), {
      item, error: message(e), attempts: (previous?.attempts ?? 0) + 1, since: previous?.since ?? at, lastAt: at,
    }];
  }
}

const managers = new WeakMap<Storage, TerminalCleanupManager>();
export function terminalCleanupFor(root: string, storage: Storage): TerminalCleanupManager {
  let manager = managers.get(storage);
  if (!manager) { manager = new TerminalCleanupManager(storage, root); managers.set(storage, manager); }
  return manager;
}
