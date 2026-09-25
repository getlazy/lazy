/**
 * Pair and Chat over the web-shell WebSocket — the same PTY/exec path as a
 * plain container shell, with a different command inside.
 *
 * Pair takes the pairing lock and moves the task to `pairing`, exactly as
 * `lazy pair` does: unblock/accept refuse until the session ends. Chat does
 * not take that lock and does not change the task's agent/model/effort; it
 * does take the worktree lock so a daemon-driven turn cannot start underneath
 * the conversation (the CLI's rule).
 *
 * A dropped WebSocket must not leave the task locked forever. The daemon
 * process is still alive after a drop, so the PID-based pairing lock would
 * never go stale on its own. Closing the socket starts a 30s grace; if no
 * new Pair connection for this task arrives, the lock is released and the
 * task is parked. The UI states the timeout in one line.
 *
 * One Pair session per task. A second attempt is refused with who holds it.
 */

import type { Storage } from '../storage';
import type { Task, Session, ActorInput } from '../types';
import { getActor } from '../constants';
import { getWorktreePath } from '../task/identity';
import { pairInContainerCmd } from '../supervisor/pair';
import { resolveInteractiveLaunch, launchEnvOverlay } from '../credentials/interactive-auth';
import { profileForAgentName, profileNameForAgent } from '../config/agent-profiles';
import { loadConfig } from '../config/loader';
import { pairSessionModel } from '../task/launch-identity-view';
import { readProjectSettings, resolveProjectModel } from '../daemon/project-settings';
import { getAgent } from '../agent/registry';
import { webInteractiveRefusal } from '../daemon/usage-pause';
import {
  acquirePairingLock,
  removePairingLock,
  checkPairingLock,
} from '../utils/pairing-lock';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { parkTaskPaused } from '../utils/paused-status';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import { actorEmail } from '../actor-ref';
import { taskTurnRunning } from '../daemon/member-entry';
import { recordSessionCommits } from '../task/session-commits';

/**
 * A reconnect inside the grace window resumes the SAME person's hold. Another
 * member taking it over would pair under the first member's name — the park
 * and "session ended" rows would name somebody who was no longer there.
 */
function sameHolder(held: ActorInput, next: ActorInput): boolean {
  return (actorEmail(held) ?? null) === (actorEmail(next) ?? null);
}

/** How long a dropped Pair/Chat keeps the lock before we release it. */
export const WEB_PAIR_GRACE_MS = 30_000;

export type ShellSessionMode = 'shell' | 'pair' | 'chat';

export function parseShellSessionMode(value: string | null): ShellSessionMode {
  if (value === 'pair' || value === 'chat') return value;
  return 'shell';
}

export interface PairExecPlan {
  cmd: string[];
  env: string[];
  /** Called when the WebSocket (and therefore the exec) has closed. */
  onClose: () => void;
  /** Called when the upgrade itself failed — release immediately, no grace. */
  abort: () => void;
}

interface HeldPair {
  worktreePath: string;
  connections: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
  storage: Storage;
  taskId: string;
  /** Who the pairing's rows name — the attaching member where there is one. */
  actor: ActorInput;
}

interface HeldChat {
  worktreePath: string;
  actor: ActorInput;
  connections: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const heldPairs = new Map<string, HeldPair>();
const heldChats = new Map<string, HeldChat>();

/**
 * Whose web Pair holds this task right now (the email its rows name), or null
 * when no web Pair does — or one does that names nobody (the laptop owner).
 * A member's entry uses it to let a member's own second terminal in beside
 * their Pair, and nobody else's.
 */
export function webPairHolderEmail(taskId: string): string | null {
  const live = heldPairs.get(taskId);
  return live ? (actorEmail(live.actor) ?? null) : null;
}

/**
 * Whether a web Chat holds this task right now, and whose (the email its rows
 * name; null for one that names nobody — the laptop owner's dashboard Chat,
 * which runs in the TASK's container). The same use as {@link webPairHolderEmail}.
 */
export function webChatHolder(taskId: string): { held: boolean; email: string | null } {
  const live = heldChats.get(taskId);
  return live ? { held: true, email: actorEmail(live.actor) ?? null } : { held: false, email: null };
}

/**
 * Build the in-container command for Pair or Chat, or a refusal the upgrader
 * turns into an HTTP response. `mode` is `pair` or `chat` — never `shell`.
 */
export async function planPairOrChatExec(opts: {
  root: string;
  storage: Storage;
  task: Task;
  session: Session;
  mode: 'pair' | 'chat';
  /**
   * The attaching MEMBER, on a shared daemon (the session-attach route passes
   * the person its token names). When set, the session runs in the member's
   * OWN container (src/daemon/member-container.ts), whose environment carries
   * their credential and nothing else, and pair's rows name them. Unset on a
   * single-person daemon, where the channel role is the whole story.
   */
  member?: { email: string; name?: string } | null;
}): Promise<{ ok: true; plan: PairExecPlan } | { ok: false; status: number; message: string }> {
  const { root, storage, task, session, mode } = opts;
  const member = opts.member ?? null;
  const actor: ActorInput = member
    ? { role: getActor(), email: member.email, ...(member.name ? { name: member.name } : {}) }
    : getActor();
  const resolved = await resolveModeAgent(root, task);
  if (!resolved.ok) return resolved;
  const { worktreePath, config, profile, harness, agent, agentDesc } = resolved;
  if (member) {
    const memberRefusal = memberAgentRefusal(task, profile, config);
    if (memberRefusal) return { ok: false, status: 409, message: memberRefusal };
  }

  // [usage_pause]: a web Pair or Chat spends a credential like a turn — the
  // task's, or a member's OWN on a shared daemon — and the person at the page
  // is the human channel. PEEKED here so a paused credential refuses early;
  // ADMITTED — the one-shot override taken, if that is what lets it through —
  // only after the lock's own refusals (takeModeLock), just before the lock. A
  // reconnect inside the grace window is the same session and is not judged
  // again, as a running turn never is.
  const reconnecting = mode === 'pair'
    ? heldPairs.get(task.id)?.graceTimer != null
    : heldChats.get(task.id)?.graceTimer != null;
  const spender = member?.email ?? null;
  if (!reconnecting) {
    const peeked = await webInteractiveRefusal(root, task, config, mode, true, spender);
    if (peeked) return peeked;
  }
  const admit = async () => (reconnecting ? null : webInteractiveRefusal(root, task, config, mode, false, spender));

  // What the task's next turn would run, resolved on the host — never raw
  // task.model, which is null on a task that has not run yet. Read BEFORE
  // anything is acquired: a throw here must not leave a lock behind.
  const modelId = pairSessionModel({
    task,
    config,
    projectModel: resolveProjectModel(await readProjectSettings(storage), config),
  });
  // A FRESH read where the mode lock is taken: the task the route resolved
  // is from before the member's entry. For a member on a shared daemon a live
  // binding counts as a running turn too (a launch binds before it flips to
  // `working`) — the entry already refused both, so this is belt and braces.
  const fresh = (await storage.getTask(task.id)) ?? task;
  const locked = member && (fresh.status === 'working' || (await taskTurnRunning(root, storage, task.id)))
    ? {
        ok: false as const,
        status: 409,
        message: `A turn is running on task ${task.code ?? task.id}. Wait for it to end, then open the terminal again.`,
      }
    : await takeModeLock({ task: fresh, worktreePath, storage, actor, mode, agent, agentDesc, harness, admit });
  if (!locked.ok) return locked;

  const runnerType = session.runner_type ?? task.runner_type ?? 'docker';
  const cmd = pairInContainerCmd({
    taskId: task.id,
    worktreePath,
    harness,
    runnerType,
    sessionId: session.agent_session_id ?? null,
    modelId,
    chat: mode === 'chat',
    // The member's own container: a lazy-built home, no lazy_* tools (there is
    // no token in it for anything to read — raise 544ca836 tracks giving a
    // member's Pair tools of their own), and Claude Code told to ignore the
    // worktree's settings and any MCP server lazy did not write.
    memberSession: member !== null,
  });

  const env = ['TERM=xterm-256color'];
  // A member's container was created with their credential as its only one;
  // the exec adds nothing. Locally the exec refreshes the task container's.
  if (!member) {
    try {
      const { envVars } = await resolveInteractiveLaunch(root, mode === 'chat' ? 'lazy chat' : 'lazy pair', {
        surface: 'container',
        identity: {
          role: 'builder',
          taskId: task.id,
          label: `${mode}:${task.id}`,
          profile,
        },
      });
      for (const [key, value] of Object.entries(launchEnvOverlay(envVars))) {
        env.push(`${key}=${value}`);
      }
    } catch (err) {
      // The container already has launch-time env. Re-passing is how a daemon
      // restart's new proxy address reaches an existing container; failing that
      // is not a reason to refuse the session — the baked env still works when
      // the daemon has not moved.
      logger.warn(
        `web ${mode} could not refresh auth env (using the container's baked env): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: true,
    plan: {
      cmd,
      env,
      onClose: () => {
        if (mode === 'pair') schedulePairRelease(task.id);
        else scheduleChatRelease(task.id);
      },
      abort: () => {
        if (mode === 'pair') void releasePair(task.id);
        else void releaseChat(task.id);
      },
    },
  };
}

/**
 * The task's agent as Pair/Chat would run it: the worktree, the config, and the
 * profile/harness the CLI's pair path resolves (the TASK's agent, not the
 * builder's — pairing and chat run that agent in that container, so their
 * traffic belongs on its upstream). One resolution for the planner and the
 * preflight, so the page and the upgrade cannot disagree about it.
 */
async function resolveModeAgent(root: string, task: Task): Promise<
  | { ok: true; worktreePath: string; config: Awaited<ReturnType<typeof loadConfig>>; profile: string; harness: string; agent: ReturnType<typeof getAgent>; agentDesc: string }
  | { ok: false; status: number; message: string }
> {
  const worktreePath = getWorktreePath(root, task);
  if (!(await pathExists(worktreePath))) {
    return { ok: false, status: 409, message: `Worktree missing for task ${task.code ?? task.id} at ${worktreePath}.` };
  }
  let config;
  try {
    config = await loadConfig(root);
  } catch (err) {
    return { ok: false, status: 500, message: `Could not load project config: ${err instanceof Error ? err.message : String(err)}` };
  }
  const profile = profileNameForAgent(task.agent_id);
  let harness: string;
  try {
    harness = profileForAgentName(config, profile, `task ${task.code ?? task.id}`).harness;
  } catch (err) {
    return { ok: false, status: 409, message: err instanceof Error ? err.message : String(err) };
  }
  const agent = getAgent(harness);
  const agentDesc = harness === profile ? profile : `${profile} (${harness})`;
  return { ok: true, worktreePath, config, profile, harness, agent, agentDesc };
}

/**
 * A MEMBER's Pair and Chat run in the member's own container, on the member's
 * own Claude account: so only a task whose agent is Claude Code on Anthropic's
 * own API can be paired or chatted with that way. Any other agent spends a
 * credential the member does not have (a Cursor or OpenAI key, a profile's own
 * named key) or talks to a server their account means nothing to.
 */
function memberAgentRefusal(
  task: Task,
  profileName: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
): string | null {
  const profile = profileForAgentName(config, profileName, `task ${task.code ?? task.id}`);
  if (profile.harness === 'claude-code' && profile.credential === 'anthropic' && !profile.endpointPinned) return null;
  return (
    `Pair and Chat here run Claude Code on your own Claude account, and task ${task.code ?? task.id} runs the ` +
    `"${profile.name}" agent, which uses a different model service or credential. Open a Shell instead.`
  );
}

/** The agent rules of Pair and Chat, shared by the lock and the preflight. */
function agentModeRefusal(
  task: Task,
  mode: 'pair' | 'chat',
  agent: ReturnType<typeof getAgent>,
  agentDesc: string,
  harness: string,
): string | null {
  if (mode === 'pair' && !agent.supportsPairing()) {
    return `Cannot pair on a ${agentDesc} task — that agent does not support pairing.`;
  }
  if (mode === 'chat' && task.agent_id && task.agent_id !== 'claude-code' && harness !== 'claude-code') {
    return `Task ${task.code ?? task.id} runs on the "${agentDesc}" agent — chat only supports Claude Code tasks.`;
  }
  return null;
}

/** Take the lock a Pair or Chat holds for its lifetime, or refuse with why. */
async function takeModeLock(opts: {
  task: Task;
  worktreePath: string;
  storage: Storage;
  actor: ActorInput;
  mode: 'pair' | 'chat';
  agent: ReturnType<typeof getAgent>;
  agentDesc: string;
  harness: string;
  /**
   * [usage_pause] admission, run after this function's own refusals and just
   * before the lock — the one-shot override is taken here, if that is what
   * lets the session through, so it is never spent on a session refused anyway.
   */
  admit: () => Promise<{ ok: false; status: number; message: string } | null>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const { task, worktreePath, storage, actor, mode, agent, agentDesc, harness, admit } = opts;
  const agentRefusal = agentModeRefusal(task, mode, agent, agentDesc, harness);
  if (agentRefusal) return { ok: false, status: 409, message: agentRefusal };
  if (mode === 'pair') {
    // The CLI's rule: pairing takes over the agent's session, which a running
    // turn owns. Wait for it to pause.
    if (task.status === 'working') {
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} is currently working — its agent is mid-turn. Pair once it pauses.`,
      };
    }
    const refused = await admit();
    if (refused) return refused;
    const prepared = await preparePairLock(task, worktreePath, storage, actor);
    if (!prepared.ok) return prepared;
  } else {
    // Chat mirrors the CLI: only a paused task, Claude Code only (checked
    // above), no pairing lock, no model/effort change. A working task's agent
    // owns the session.
    if (task.status !== 'blocked' && task.status !== 'conflict') {
      if (task.status === 'working') {
        return {
          ok: false,
          status: 409,
          message: `Task ${task.code ?? task.id} is currently working — its agent is mid-turn. Wait for it to pause, then retry.`,
        };
      }
      if (task.status === 'pairing') {
        return {
          ok: false,
          status: 409,
          message: `Task ${task.code ?? task.id} is in a pairing session. Exit the pairing session first.`,
        };
      }
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} is '${task.status}', not 'blocked' or 'conflict'. A chat only runs against a paused task.`,
      };
    }
    const existingPair = checkPairingLock(worktreePath);
    if (existingPair) {
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} is already being paired on (PID ${existingPair.pid}). Exit the pairing session first.`,
      };
    }
    const refused = await admit();
    if (refused) return refused;
    const prepared = await prepareChatLock(task, worktreePath, actor);
    if (!prepared.ok) return prepared;
  }
  return { ok: true };
}

async function preparePairLock(
  task: Task,
  worktreePath: string,
  storage: Storage,
  actor: ActorInput,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const live = heldPairs.get(task.id);
  if (live && live.connections > 0) {
    return {
      ok: false,
      status: 409,
      message: `Task ${task.code ?? task.id} is already being paired on in this browser session. Close that Pair terminal first.`,
    };
  }
  if (live && live.graceTimer) {
    if (!sameHolder(live.actor, actor)) {
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} is still held by ${actorEmail(live.actor) ?? 'another session'}'s Pair, which ends within 30 seconds of its disconnect. Try again shortly.`,
      };
    }
    // Reconnect inside the grace window: keep the lock, cancel the release.
    clearTimeout(live.graceTimer);
    live.graceTimer = null;
    live.connections = 1;
    return { ok: true };
  }

  const existing = checkPairingLock(worktreePath);
  if (existing) {
    return {
      ok: false,
      status: 409,
      message:
        `Task ${task.code ?? task.id} is already being paired on (PID ${existing.pid}, started ${existing.started_at}). ` +
        `End that session first, or clear a stale lock with: lazy pair ${task.code ?? task.id} --unlock`,
    };
  }

  acquirePairingLock(worktreePath);
  try {
    await storage.updateTaskStatus(task.id, 'pairing', actor);
    await storage.updateTaskMetadata(task.id, 'pairing_pid', String(process.pid));
    await storage.updateTaskMetadata(task.id, 'pairing_started_at', new Date().toISOString());
  } catch (err) {
    removePairingLock(worktreePath);
    return {
      ok: false,
      status: 500,
      message:
        `Could not lock the task for pairing: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  heldPairs.set(task.id, {
    worktreePath,
    connections: 1,
    graceTimer: null,
    storage,
    taskId: task.id,
    actor,
  });
  return { ok: true };
}

function schedulePairRelease(taskId: string): void {
  const live = heldPairs.get(taskId);
  if (!live) return;
  live.connections = Math.max(0, live.connections - 1);
  if (live.connections > 0) return;
  if (live.graceTimer) clearTimeout(live.graceTimer);
  live.graceTimer = setTimeout(() => {
    void releasePair(taskId);
  }, WEB_PAIR_GRACE_MS);
}

async function releasePair(taskId: string): Promise<void> {
  const live = heldPairs.get(taskId);
  if (!live) return;
  heldPairs.delete(taskId);
  try {
    await parkTaskPaused(live.storage, taskId, live.actor);
    await live.storage.updateTaskMetadata(taskId, 'pairing_pid', '');
    await live.storage.updateTaskMetadata(taskId, 'pairing_started_at', '');
    const session = await live.storage.getSessionByTaskId(taskId);
    if (session) {
      // The same record `lazy pair` writes at its end, through the one
      // resolver: commits made while paired belong to the task now, not
      // whenever a later turn happens to pick them up.
      const scan = await recordSessionCommits(live.storage, session, live.worktreePath, taskId.substring(0, 8));
      const made = scan.commits.length > 0
        ? `\n\nCommits recorded:\n${scan.commits.map((c) => `- ${c.sha.substring(0, 8)} ${c.message}`).join('\n')}`
        : '';
      const sequence = await live.storage.getNextTurnSequence(session.id);
      await live.storage.createTurn({
        sessionId: session.id,
        sequence,
        role: 'human',
        content: `[pairing session]\n\nWeb pairing session ended.${made}`,
        actor: live.actor,
      });
    }
  } catch (err) {
    logger.warn(
      `web pair failed to park task ${taskId.substring(0, 8)} after disconnect: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  removePairingLock(live.worktreePath);
}

async function prepareChatLock(
  task: Task,
  worktreePath: string,
  actor: ActorInput,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const live = heldChats.get(task.id);
  if (live && live.connections > 0) {
    return {
      ok: false,
      status: 409,
      message: `Task ${task.code ?? task.id} already has a Chat session open in this browser. Close that terminal first.`,
    };
  }
  if (live && live.graceTimer) {
    if (!sameHolder(live.actor, actor)) {
      return {
        ok: false,
        status: 409,
        message: `Task ${task.code ?? task.id} is still held by ${actorEmail(live.actor) ?? 'another session'}'s Chat, which ends within 30 seconds of its disconnect. Try again shortly.`,
      };
    }
    clearTimeout(live.graceTimer);
    live.graceTimer = null;
    live.connections = 1;
    return { ok: true };
  }

  const existing = await checkLock(worktreePath);
  if (existing) {
    return {
      ok: false,
      status: 409,
      message:
        `Task ${task.code ?? task.id} is locked by another process (PID ${existing.pid}, ${existing.command}). ` +
        `A chat needs the task idle. Retry once that operation finishes.`,
    };
  }
  await acquireLock(worktreePath, 'lazy chat (web)');
  heldChats.set(task.id, { worktreePath, actor, connections: 1, graceTimer: null });
  return { ok: true };
}

function scheduleChatRelease(taskId: string): void {
  const live = heldChats.get(taskId);
  if (!live) return;
  live.connections = Math.max(0, live.connections - 1);
  if (live.connections > 0) return;
  if (live.graceTimer) clearTimeout(live.graceTimer);
  live.graceTimer = setTimeout(() => {
    void releaseChat(taskId);
  }, WEB_PAIR_GRACE_MS);
}

async function releaseChat(taskId: string): Promise<void> {
  const live = heldChats.get(taskId);
  if (!live) return;
  heldChats.delete(taskId);
  try {
    await removeLock(live.worktreePath);
  } catch (err) {
    logger.warn(
      `web chat failed to release the worktree lock for ${taskId.substring(0, 8)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test seam: drop in-memory hold state between cases. */
export function resetWebPairStateForTests(): void {
  for (const live of heldPairs.values()) {
    if (live.graceTimer) clearTimeout(live.graceTimer);
  }
  for (const live of heldChats.values()) {
    if (live.graceTimer) clearTimeout(live.graceTimer);
  }
  heldPairs.clear();
  heldChats.clear();
}

/**
 * Why Pair or Chat would be refused for this member right now, WITHOUT taking
 * anything — the `attachSession` preflight, so a client can say so on the
 * button instead of opening a socket that is refused with no readable reason.
 * The same rules `takeModeLock` enforces (it stays the authority at upgrade).
 */
export async function pairOrChatRefusal(
  root: string,
  task: Task,
  mode: 'pair' | 'chat',
  memberEmail: string | null,
): Promise<string | null> {
  const name = task.code ?? task.id;
  // The agent rules first: a Cursor task cannot be paired on, a non-Claude
  // task cannot be chatted with, whatever else holds.
  const resolved = await resolveModeAgent(root, task);
  if (!resolved.ok) return resolved.message;
  const agentRefusal = agentModeRefusal(task, mode, resolved.agent, resolved.agentDesc, resolved.harness);
  if (agentRefusal) return agentRefusal;
  if (memberEmail) {
    const memberRefusal = memberAgentRefusal(task, resolved.profile, resolved.config);
    if (memberRefusal) return memberRefusal;
  }
  const worktreePath = resolved.worktreePath;
  const pairLock = checkPairingLock(worktreePath);
  const heldPair = heldPairs.get(task.id);
  if (mode === 'pair') {
    if (task.status === 'working') return `Task ${name} is currently working — its agent is mid-turn. Pair once it pauses.`;
    if (heldPair && (heldPair.connections > 0 || !sameHolder(heldPair.actor, memberEmail ? { role: getActor(), email: memberEmail } : getActor()))) {
      return `Somebody is already pairing on task ${name}.`;
    }
    if (!heldPair && pairLock) return `Task ${name} is already being paired on.`;
    return null;
  }
  if (task.status !== 'blocked' && task.status !== 'conflict') {
    return `Chat runs only while the task is waiting for you (it is ${task.status}).`;
  }
  if (pairLock) return `Task ${name} is in a pairing session. Chat once it ends.`;
  const heldChat = heldChats.get(task.id);
  if (heldChat && heldChat.connections > 0) return `Task ${name} already has a Chat open.`;
  if (heldChat && !sameHolder(heldChat.actor, memberEmail ? { role: getActor(), email: memberEmail } : getActor())) {
    return `Another member's Chat on task ${name} is ending (within 30 seconds). Try again shortly.`;
  }
  if (!heldChat) {
    const worktreeLock = await checkLock(worktreePath);
    if (worktreeLock) return `Task ${name} is busy (${worktreeLock.command}). Chat once that finishes.`;
  }
  return null;
}
