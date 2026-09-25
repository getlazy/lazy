/**
 * Raised-item resolution helpers shared by accept, unblock, and review.
 *
 * Accept refuses while any raised item is open (protected-files-shaped:
 * all-or-nothing). Unblock may optionally resolve items attributably via the
 * same resolution payload — never by parsing feedback prose.
 *
 * Resolutions schedule a pending comment on the item; the next unblock/accept
 * materializes those comments into real comments (comments are append-only,
 * so we never write one at resolve time — undo is overwrite or unresolve).
 *
 * INVARIANT: both promote actions are STRUCTURAL — lazy itself creates the task
 * at materialize time; the comment is only informational. They differ solely in
 * the parent pointer (peer → the originating task's parent; subtask → the
 * originating task). Promote-to-subtask was originally a comment ONLY ("promote
 * this into its own subtask and work it there"), which silently did nothing when
 * the resolution was materialized by an ACCEPT: the comment landed on a task
 * that was completing, no agent turn ever ran, and no subtask was ever created.
 *
 * See docs/design/structural-agent-questions.md.
 */

import type { Storage } from '../storage/interface';
import type {
  ActorInput,
  ActiveRaisedResolveAction,
  RaisedItem,
  RaisedItemResolution,
  RaisedItemResolveAction,
  RaisedItemStatus,
  Task,
} from '../types';
import { ACTIVE_RAISED_ACTIONS, isTerminalStatus } from '../types';
import { raisedDisplayBody, raisedTitle } from '../raised/title';
import { parentTaskIdOf } from '../task-target';
import { acceptRefusal, acceptWithRaisedResolutionsCommand, shellQuote } from './accept-refusal';
import { RpcError } from './rpc-error';

/**
 * The items that GATE accept: open AND blocking.
 *
 * INVARIANT: only blocking items gate. A non-blocking raised item is what used
 * to be a follow-up — a passive note for later triage — and a task must be
 * acceptable with any number of them still open. See
 * docs/design/raised-items-unified.md.
 */
export function openRaisedItems(items: RaisedItem[]): RaisedItem[] {
  return items.filter(i => i.status === 'open' && i.blocking);
}

/** Every open item, blocking or not (review listings, resolvable set). */
export function allOpenRaisedItems(items: RaisedItem[]): RaisedItem[] {
  return items.filter(i => i.status === 'open');
}

/** True when a resolution's comment is still undoable (not yet a real comment). */
export function raisedCommentIsPending(item: RaisedItem): boolean {
  return item.status !== 'open'
    && Boolean(item.pending_comment)
    && item.comment_delivered_at == null;
}

export function isActiveRaisedAction(action: string): action is ActiveRaisedResolveAction {
  return (ACTIVE_RAISED_ACTIONS as readonly string[]).includes(action);
}

/** Recover the action from a stored status (for rebuild / display). */
export function actionForRaisedStatus(status: RaisedItemStatus): RaisedItemResolveAction | null {
  switch (status) {
    case 'responded':
      return 'respond';
    case 'promoted_subtask':
      return 'promote_subtask';
    case 'promoted_peer':
      return 'promote_peer';
    case 'dismissed':
      return 'dismiss';
    case 'acknowledged':
      return 'acknowledge';
    case 'answered':
      return 'answer';
    case 'open':
      return null;
  }
}

function quoteRaisedContent(content: string): string {
  return content
    .trim()
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

/**
 * Build the comment that will be delivered on the next unblock/accept.
 * Always quotes the raised item so a short reply still carries its subject.
 */
export function buildPendingRaisedComment(
  item: RaisedItem,
  action: RaisedItemResolveAction,
  response?: string | null,
  extras?: { promotedTaskRef?: string },
): string {
  // Quote the DISPLAY body, not the raw `content` field: title, content and
  // explanation are independent fields, so what the human decided on is their
  // composition. Quoting one of them would show the agent a decision attached
  // to a body it cannot recognize.
  const quoted = `Regarding raised item ${item.id.slice(0, 8)}:\n${quoteRaisedContent(raisedDisplayBody(item))}`;
  const note = response?.trim() ?? '';

  switch (action) {
    case 'respond':
    case 'answer':
      return `${quoted}\n\n${note}`;
    case 'promote_subtask': {
      // Informational only — lazy created the subtask itself at materialize
      // time. Never an instruction to the agent to create one: on an accept
      // there is no next turn to carry it out.
      const sub = extras?.promotedTaskRef
        ? `This was promoted to a subtask (${extras.promotedTaskRef}) under this task; the work is tracked there. ` +
          `Do not re-raise it and do not create another task for it. If you are still working, you may ` +
          `lazy_wait on it and accept it, or leave it for the human.`
        : `This will be promoted to a subtask (created on the next unblock or accept). Do not re-raise it.`;
      return `${quoted}\n\n${sub}` + (note ? `\n\n${note}` : '');
    }
    case 'promote_peer': {
      const peer = extras?.promotedTaskRef
        ? `This was promoted to a peer task (${extras.promotedTaskRef}). Do not re-raise it; that work is tracked there.`
        : `This will be promoted to a peer task (created on the next unblock or accept). Do not re-raise it.`;
      return `${quoted}\n\n${peer}` + (note ? `\n\n${note}` : '');
    }
    case 'dismiss':
      return `${quoted}\n\nDismissed: ${note}`;
    case 'acknowledge':
      return note
        ? `${quoted}\n\nAcknowledged: ${note}`
        : `${quoted}\n\nAcknowledged.`;
  }
}

function actionRequiresResponse(action: RaisedItemResolveAction): boolean {
  return action === 'respond' || action === 'dismiss' || action === 'answer';
}

function rejectLegacyOrUnknownAction(action: unknown): asserts action is ActiveRaisedResolveAction {
  if (action === 'answer') {
    throw new RpcError(
      400,
      `Raised resolution action "answer" is no longer valid. ` +
      `Use respond, promote_subtask, promote_peer, dismiss, or acknowledge.`,
    );
  }
  if (!isActiveRaisedAction(String(action))) {
    throw new RpcError(
      400,
      `Raised resolution action must be respond, promote_subtask, promote_peer, dismiss, ` +
      `or acknowledge (got ${JSON.stringify(action)})`,
    );
  }
}

function requireResponseIfNeeded(action: RaisedItemResolveAction, response: string | undefined, itemId: string): void {
  if (actionRequiresResponse(action) && !(response && response.trim())) {
    throw new RpcError(
      400,
      `Raised item ${itemId.slice(0, 8)} ${action} requires a response ` +
      `(${action === 'dismiss' ? 'dismiss reason' : 'response text'})`,
    );
  }
}

export interface NormalizedRaisedResolution {
  item: RaisedItem;
  action: ActiveRaisedResolveAction;
  response?: string;
  pending_comment: string;
}

/**
 * Validate a caller-supplied resolution set against the open items.
 * Returns the normalized list (ids resolved to full ids) or throws.
 *
 * Two different sets, deliberately:
 * - `open` is the set accept GATES on — the blocking items. All-or-nothing:
 *   every one must be named exactly once.
 * - `resolvable` is the set a caller MAY name, which also contains the open
 *   non-blocking items. Accept never requires them, but a reviewer who is
 *   already in the resolution flow can acknowledge or dismiss one in the same
 *   breath rather than making a second trip through `lazy raised`.
 *
 * Every active verb applies to every item regardless of the flag. `acknowledge`
 * and `dismiss` are the same act — "I saw it and I am taking no action" — and
 * differ only in valence, which is worth recording but is not a rule anyone has
 * to learn: both close the gate on a blocking item.
 *
 * It defaults to `open` so callers that only ever had a gating set keep today's
 * behavior. Unknown ids and missing required responses are refused loudly.
 */
export function validateRaisedResolutions(
  open: RaisedItem[],
  resolutions: RaisedItemResolution[] | undefined,
  displayId: string,
  resolvable: RaisedItem[] = open,
): NormalizedRaisedResolution[] {
  // Nothing gates. Re-passing resolutions after they were already stored
  // (review-page Apply, a previous accept that failed after persist, --wait
  // retry) must not refuse; same posture as re-passing --approve-file after
  // violations were already marked approved. So ids that no longer resolve are
  // skipped here rather than thrown on — but ids that DO name a still-open
  // non-blocking item are honored, or a resolution passed to an accept with no
  // blocking items would vanish without a word.
  if (open.length === 0) {
    if (!resolutions || resolutions.length === 0) return [];
    const stillOpen = new Map(resolvable.flatMap(i => [
      [i.id, i] as const,
      [i.id.slice(0, 8), i] as const,
    ]));
    const out: NormalizedRaisedResolution[] = [];
    const seenIds = new Set<string>();
    for (const res of resolutions) {
      if (!res.id || typeof res.id !== 'string') {
        throw new RpcError(400, 'Each raised resolution must have a string id');
      }
      rejectLegacyOrUnknownAction(res.action);
      const item = stillOpen.get(res.id) ?? [...stillOpen.values()].find(i => i.id.startsWith(res.id));
      if (!item) continue;
      if (seenIds.has(item.id)) {
        throw new RpcError(400, `Raised item ${item.id.slice(0, 8)} is named more than once in resolutions`);
      }
      requireResponseIfNeeded(res.action, res.response, item.id);
      seenIds.add(item.id);
      const response = res.response != null && res.response !== '' ? res.response : undefined;
      out.push({
        item,
        action: res.action,
        ...(response != null ? { response } : {}),
        pending_comment: buildPendingRaisedComment(item, res.action, response),
      });
    }
    return out;
  }

  if (resolutions === undefined) {
    const ids = open.map(i => i.id);
    const summary = open
      .map(i => `  - ${i.id.slice(0, 8)}: ${i.content.slice(0, 80)}${i.content.length > 80 ? '…' : ''}`)
      .join('\n');
    throw acceptRefusal(
      409,
      `Task ${displayId} has ${open.length} open raised item(s) that must be ` +
      `responded to, promoted, dismissed, or acknowledged before accept:\n${summary}`,
      {
        reason: 'open-raised-items',
        next: 'Respond, promote to a subtask or peer task, or dismiss every open raised item, then accept again.',
        command: acceptWithRaisedResolutionsCommand(displayId, ids.map(id => id.slice(0, 8))),
        files: ids.map(id => id.slice(0, 8)),
      },
    );
  }

  // Built from `resolvable`, not `open`: naming an open non-blocking item is
  // allowed, it is only the blocking ones that accept requires.
  const byId = new Map<string, RaisedItem>();
  for (const item of resolvable) {
    byId.set(item.id, item);
    byId.set(item.id.slice(0, 8), item);
  }

  const seen = new Set<string>();
  const normalized: NormalizedRaisedResolution[] = [];

  for (const res of resolutions) {
    if (!res.id || typeof res.id !== 'string') {
      throw new RpcError(400, 'Each raised resolution must have a string id');
    }
    rejectLegacyOrUnknownAction(res.action);
    const action = res.action;
    const item = byId.get(res.id) ?? [...byId.values()].find(i => i.id.startsWith(res.id));
    if (!item) {
      throw new RpcError(
        400,
        `Raised resolution names unknown or already-resolved item id: ${res.id}`,
      );
    }
    if (seen.has(item.id)) {
      throw new RpcError(400, `Raised item ${item.id.slice(0, 8)} is named more than once in resolutions`);
    }
    requireResponseIfNeeded(action, res.response, item.id);
    seen.add(item.id);
    const response = res.response != null && res.response !== '' ? res.response : undefined;
    normalized.push({
      item,
      action,
      ...(response != null ? { response } : {}),
      pending_comment: buildPendingRaisedComment(item, action, response),
    });
  }

  const missing = open.filter(i => !seen.has(i.id));
  if (missing.length > 0) {
    const missingIds = missing.map(i => i.id.slice(0, 8));
    throw acceptRefusal(
      409,
      `Missing resolution for raised item(s): ${missingIds.join(', ')}. All open items must be resolved.`,
      {
        reason: 'open-raised-items',
        next: 'Resolve the remaining raised items — resolution is all-or-nothing.',
        command: acceptWithRaisedResolutionsCommand(
          displayId,
          open.map(i => i.id.slice(0, 8)),
        ),
        files: missingIds,
      },
    );
  }

  return normalized;
}

function lookupOpenOrPendingItem(
  items: RaisedItem[],
  resId: string,
): RaisedItem | undefined {
  const exact = items.find(i => i.id === resId || i.id.slice(0, 8) === resId || i.id.startsWith(resId));
  if (!exact) return undefined;
  // Open, or resolved but not yet delivered (overwrite / change before unblock).
  // Legacy acknowledge/answer rows have no pending_comment and are still undoable
  // until something writes comment_delivered_at.
  if (exact.status === 'open' || exact.comment_delivered_at == null) {
    return exact;
  }
  return undefined;
}

/**
 * Resolve one item (review page / Teams Apply). Builds the pending comment
 * and stores it — does not write a real comment.
 *
 * Overwrites an existing resolution when the comment has not been delivered
 * yet (undo + change).
 */
export async function resolveOneRaisedItem(
  storage: Storage,
  taskId: string,
  itemId: string,
  resolution: { action: RaisedItemResolveAction; actor: ActorInput; response?: string | null },
): Promise<RaisedItem> {
  rejectLegacyOrUnknownAction(resolution.action);
  const all = await storage.getTaskRaisedItems(taskId);
  const item = all.find(i => i.id === itemId || i.id.startsWith(itemId));
  if (!item) {
    throw new RpcError(400, `Raised resolution names unknown item id: ${itemId}`);
  }
  if (item.comment_delivered_at != null) {
    throw new RpcError(
      400,
      `Raised item ${item.id.slice(0, 8)} was already delivered to the agent; it cannot be changed`,
    );
  }
  requireResponseIfNeeded(resolution.action, resolution.response ?? undefined, item.id);
  const response = resolution.response ?? undefined;
  return storage.resolveRaisedItem(taskId, item.id, {
    action: resolution.action,
    actor: resolution.actor,
    response: response ?? null,
    pending_comment: buildPendingRaisedComment(item, resolution.action, response),
  });
}

/**
 * Apply validated resolutions to storage. Caller must have already validated
 * (or pass requireComplete=true for accept's all-or-nothing gate).
 *
 * When `requireComplete` is false (unblock), resolutions are optional: only
 * the named items are resolved; others stay open.
 *
 * Already-resolved items whose comment is still pending may be overwritten
 * (change before unblock).
 */
export async function applyRaisedResolutions(
  storage: Storage,
  taskId: string,
  displayId: string,
  resolutions: RaisedItemResolution[] | undefined,
  actor: ActorInput,
  opts: { requireComplete: boolean },
): Promise<{ resolved: RaisedItem[]; warnings: string[] }> {
  const all = await storage.getTaskRaisedItems(taskId);
  const open = openRaisedItems(all);
  const warnings: string[] = [];

  if (opts.requireComplete) {
    // Gate on the blocking items; let the caller additionally name any open
    // non-blocking one (accept is where a reviewer is already looking at them).
    const normalized = validateRaisedResolutions(
      open,
      resolutions,
      displayId,
      allOpenRaisedItems(all),
    );
    const resolved: RaisedItem[] = [];
    for (const n of normalized) {
      resolved.push(await storage.resolveRaisedItem(taskId, n.item.id, {
        action: n.action,
        actor,
        response: n.response ?? null,
        pending_comment: n.pending_comment,
      }));
    }
    if (resolved.length > 0) {
      warnings.push(
        `Resolved ${resolved.length} raised item(s): ${resolved.map(r => `${r.id.slice(0, 8)}=${r.status}`).join(', ')}`,
      );
    }
    return { resolved, warnings };
  }

  // Unblock path — optional partial resolution.
  if (!resolutions || resolutions.length === 0) {
    return { resolved: [], warnings };
  }

  const resolved: RaisedItem[] = [];
  const seen = new Set<string>();
  for (const res of resolutions) {
    if (!res.id || typeof res.id !== 'string') {
      throw new RpcError(400, 'Each raised resolution must have a string id');
    }
    rejectLegacyOrUnknownAction(res.action);
    const action = res.action;
    const item = lookupOpenOrPendingItem(all, res.id);
    if (!item) {
      throw new RpcError(
        400,
        `Raised resolution names unknown or already-delivered item id: ${res.id}`,
      );
    }
    if (seen.has(item.id)) {
      throw new RpcError(400, `Raised item ${item.id.slice(0, 8)} is named more than once in resolutions`);
    }
    requireResponseIfNeeded(action, res.response, item.id);
    seen.add(item.id);
    const response = res.response ?? undefined;
    resolved.push(await storage.resolveRaisedItem(taskId, item.id, {
      action,
      actor,
      response: response ?? null,
      pending_comment: buildPendingRaisedComment(item, action, response),
    }));
  }

  if (resolved.length > 0) {
    warnings.push(
      `Resolved ${resolved.length} raised item(s) on unblock: ${resolved.map(r => `${r.id.slice(0, 8)}=${r.status}`).join(', ')}`,
    );
  }
  return { resolved, warnings };
}

function taskDisplayRef(task: Task): string {
  return task.code ?? task.id.slice(0, 8);
}

type PromotionKind = 'subtask' | 'peer';

function buildPromotedTaskPrompt(
  item: RaisedItem,
  originating: Task,
  kind: PromotionKind,
  response?: string | null,
): string {
  const ref = taskDisplayRef(originating);
  const goal = originating.goal.trim();
  const relation = kind === 'subtask' ? 'as a subtask of' : 'as a peer of';
  const provenance =
    `Promoted from raised item ${item.id} ${relation} task ${ref}` +
    (goal ? `: ${goal}` : '.');
  const extra = response?.trim() ? `\n\nReviewer note:\n${response.trim()}` : '';
  // An agent-authored proposed_prompt is meant to be used verbatim; fall back
  // to the item's own body when it filed free text instead.
  const body = item.proposed_prompt?.trim() || item.content.trim();
  return `${body}${extra}\n\n---\n\n${provenance}`;
}

/**
 * Create the task a promote_subtask / promote_peer resolution stands for.
 *
 * The two differ ONLY in the parent pointer. Both inherit the originating
 * task's agent, model and effort deliberately: a promotion is a continuation of
 * the same piece of work, so it must not silently land on the project default
 * agent (or a cheaper effort) just because it was created by the resolver
 * rather than by a human at `lazy create`.
 */
async function createPromotedTask(
  storage: Storage,
  item: RaisedItem,
  originating: Task,
  kind: PromotionKind,
  actor: ActorInput,
): Promise<Task> {
  const parentId = kind === 'subtask'
    ? originating.id
    : (parentTaskIdOf(originating) ?? undefined);
  const goal = item.title?.trim() || raisedTitle(item.content, 200);

  // A structured item carries the code the agent proposed; otherwise derive one
  // from the goal. Either way a collision is suffixed rather than dropped —
  // listings show codes, and a bare hex id is the defect that rule prevents.
  const {
    allocatePromotedCode,
    defaultPromotedCodeFromRaised,
    inheritOriginatingLaunchSettings,
  } = await import('../raised/promote-task');
  let code = defaultPromotedCodeFromRaised(item, goal);
  if (code) {
    const taken = new Set(
      (await storage.listTasks())
        .filter(t => t.code && !isTerminalStatus(t.status))
        .map(t => t.code as string),
    );
    code = allocatePromotedCode(code, taken);
  }

  const created = await storage.createTask(
    goal,
    parentId,
    undefined,
    code,
    undefined,
    originating.agent_id,
    actor,
  );
  await storage.updateTaskPrompt(
    created.id,
    buildPromotedTaskPrompt(item, originating, kind, item.resolution),
  );
  // Same helper the storage promote path uses, so the two promotion routes
  // cannot drift on what "inherit the originating task's launch settings" means.
  await inheritOriginatingLaunchSettings(storage, created.id, originating);
  return created;
}

/**
 * Write pending raised-item comments as real comments, and create the tasks
 * that promote_subtask / promote_peer resolutions stand for. Called from
 * unblock and accept — the moment the resolution becomes permanent.
 *
 * INVARIANT: promotion is structural on BOTH surfaces. Asking the agent to
 * create the subtask (the original promote_subtask design) is a no-op when the
 * resolution is materialized by an accept: the task is completing and no turn
 * will ever read the comment.
 *
 * On accept, the child created here is picked up by accept's own
 * `reparentChildren` step (which runs later, and reads children from storage),
 * so it lands on the accepted task's target rather than on a merged branch.
 *
 * Legacy acknowledge/answer/dismiss records have no pending_comment and are
 * skipped (they never scheduled a comment).
 */
export async function materializePendingRaisedComments(
  storage: Storage,
  taskId: string,
  actor: ActorInput,
): Promise<{
  comments: number;
  peerTasks: string[];
  subtasks: string[];
  warnings: string[];
  deliveredItemIds: string[];
}> {
  const originating = await storage.getTask(taskId);
  if (!originating) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const items = await storage.getTaskRaisedItems(taskId);
  const pending = items.filter(i =>
    i.status !== 'open'
    && i.comment_delivered_at == null
    && (i.pending_comment || i.status === 'promoted_peer' || i.status === 'promoted_subtask'),
  );

  let comments = 0;
  const peerTasks: string[] = [];
  const subtasks: string[] = [];
  const warnings: string[] = [];
  const deliveredItemIds: string[] = [];

  for (const item of pending) {
    const action = actionForRaisedStatus(item.status);
    let body = item.pending_comment ?? '';
    let promotedTaskId = item.promoted_task_id ?? undefined;
    let promotedTaskCode: string | undefined;

    const promotionKind: PromotionKind | null =
      item.status === 'promoted_peer' ? 'peer'
        : item.status === 'promoted_subtask' ? 'subtask'
          : null;

    if (promotionKind && !promotedTaskId) {
      const created = await createPromotedTask(storage, item, originating, promotionKind, actor);
      promotedTaskId = created.id;
      promotedTaskCode = created.code ?? undefined;
      (promotionKind === 'peer' ? peerTasks : subtasks).push(created.id);
      const shortRef = created.code ?? created.id.slice(0, 8);
      body = buildPendingRaisedComment(
        item,
        action ?? (promotionKind === 'peer' ? 'promote_peer' : 'promote_subtask'),
        item.resolution,
        { promotedTaskRef: `${shortRef} (${created.id.slice(0, 8)})` },
      );
      warnings.push(
        `Created ${promotionKind} task ${shortRef} from raised item ${item.id.slice(0, 8)}`,
      );
    }

    if (!body.trim() && action) {
      body = buildPendingRaisedComment(item, action, item.resolution);
    }
    if (!body.trim()) {
      // Legacy record with no pending comment and no rebuildable action — skip.
      continue;
    }

    await storage.createComment(taskId, body, actor);
    await storage.markRaisedItemCommentDelivered(taskId, item.id, {
      promoted_task_id: promotedTaskId ?? null,
      ...(promotedTaskCode ? { promoted_task_code: promotedTaskCode } : {}),
      pending_comment: body,
    });
    deliveredItemIds.push(item.id);
    comments += 1;
  }

  if (comments > 0) {
    warnings.push(
      `Delivered ${comments} raised-item comment${comments === 1 ? '' : 's'} ` +
      `(scheduled at resolve, written on unblock/accept).`,
    );
  }

  return { comments, peerTasks, subtasks, warnings, deliveredItemIds };
}

/** Short notice for the next agent turn when items were resolved on unblock. */
export function buildRaisedResolvedNotice(
  resolved: RaisedItem[],
  taskDisplayId: string,
): string | null {
  if (resolved.length === 0) return null;
  const n = resolved.length;
  const ids = resolved.map(r => r.id.slice(0, 8)).join(', ');
  return (
    `## Raised items resolved\n\n` +
    `${n} raised item${n === 1 ? ' was' : 's were'} resolved by the reviewer ` +
    `(${ids}). Comments for those items are in this turn's comments — ` +
    `they quote the original question. Details also on ` +
    `lazy_show(task_id="${taskDisplayId}").`
  );
}

/** Format a pasteable CLI flag line for one resolution (tests / remedies). */
export function raisedResolutionFlag(res: RaisedItemResolution): string {
  const id = shellQuote(res.id.slice(0, 8));
  if (res.action === 'respond' || res.action === 'answer') {
    return `--respond-raised ${id}=${shellQuote(res.response ?? '')}`;
  }
  if (res.action === 'promote_subtask') {
    return res.response
      ? `--promote-raised-subtask ${id}=${shellQuote(res.response)}`
      : `--promote-raised-subtask ${id}`;
  }
  if (res.action === 'promote_peer') {
    return res.response
      ? `--promote-raised-peer ${id}=${shellQuote(res.response)}`
      : `--promote-raised-peer ${id}`;
  }
  if (res.action === 'acknowledge') {
    return res.response
      ? `--acknowledge-raised ${id}=${shellQuote(res.response)}`
      : `--acknowledge-raised ${id}`;
  }
  return `--dismiss-raised ${id}=${shellQuote(res.response ?? '')}`;
}
