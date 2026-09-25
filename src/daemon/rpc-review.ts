/**
 * RPC transport for the review surface.
 *
 * WHY THIS EXISTS
 * `ReviewActions` (src/server/review-actions.ts) is the port every mutation of
 * the review loop goes through, and it was reachable only IN-PROCESS: the
 * daemon injected `createReviewActions()` into its own web handler and that was
 * the entire surface. Any other client — a web UI served from source, a remote
 * client talking to a daemon on another host — had no way to review at all.
 *
 * These handlers are the missing transport, and nothing more. Every one of them
 * is a thin adapter: validate the params, call the SAME `createReviewActions()`
 * implementation the daemon's own handler calls, return its result. The review
 * logic stays in review-service.ts, which is what keeps CLAUDE.md's "never lose
 * human feedback" ordering — persist the comment through Storage BEFORE any
 * dispatch is attempted — in one place with one copy.
 *
 * This is a general daemon capability, not a dev-server feature. The dev server
 * is simply the first client of it.
 *
 * Every parameter is parsed by src/daemon/rpc-params.ts rather than cast: this
 * is an external surface, and `POST /rpc/reviewPostComment` is reachable by any
 * hand-rolled caller with a token.
 *
 * MODULE CYCLE, deliberately: rpc-handlers imports this module for its dispatch
 * switch, this module imports review-service, and review-service imports
 * rpc-handlers for `getOrCreateStorage`/`handleDiff`. Every edge resolves to a
 * hoisted function declaration and no module in the loop runs anything at
 * import time that reaches another, so evaluation order cannot matter. Keep it
 * that way: do not add top-level code here that CALLS into review-service.
 */

import { createReviewActions, discussionPromotions } from './review-service';
import { computeNavCounts } from '../server/nav-counts';
import { RpcError } from './rpc-error';
import {
  requireString,
  requireNonBlankString,
  requireNumber,
  requireBoolean,
  requireEnum,
  optionalString,
  optionalNumber,
  optionalEnum,
  optionalStringArray,
  optionalRaisedResolutions,
  optionalActorInput,
  requireReviewDraftPatch,
  optionalBoolean,
} from './rpc-params';
import { reviewerKey } from '../review-draft';
import { reportProseBlocks } from '../review/prose-blocks';
import { buildVerifyState } from '../review/verify-state';
import { latestAgentWorkTurn } from '../task/turn-context';
import { getOrCreateStorage } from './rpc-handlers';
import type { ActorIdentity } from './actor-tokens';
import type { ReviewCommentSide, ReviewCommentIntent } from '../types';
import type { ProgressEmitter } from './progress';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../review/task-level-anchor';
import { hasAnyQueuedComment, hasAnyAsk } from '../server/review-actions';
import { parseUnifiedDiff, mermaidDiffDiagrams } from '../server/review-diff';
import { loadMarkdownSources, renderMarkdownDocument } from '../server/review-markdown';

const SIDES: readonly ReviewCommentSide[] = ['old', 'new'];
const INTENTS: readonly ReviewCommentIntent[] = ['ask', 'comment'];

export async function handleReviewQueue(projectRoot: string) {
  return { queue: await createReviewActions(projectRoot).listQueue() };
}

export async function handleReviewDiff(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const region = typeof params.region === 'string' && params.region.trim()
    ? params.region.trim()
    : undefined;
  return { diff: await createReviewActions(projectRoot).getDiff(taskId, { region }) };
}

/** The task's region cover as summary rows — the Changes tab's regions strip. */
export async function handleReviewRegions(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  return createReviewActions(projectRoot).listRegions(taskId);
}

/**
 * Per-line unit attribution for the subtask-blame gutter.
 *
 * `paths` is validated as an array of non-blank strings before it reaches the
 * service — an external surface confirms its inputs. The response carries an
 * ARRAY because JSON has no Map; the client rebuilds the keying.
 */
export async function handleReviewLineAttribution(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const raw = params.paths;
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new RpcError(400, 'paths must be an array of non-empty file paths.');
  }
  const files = await createReviewActions(projectRoot)
    .lineAttribution(taskId, raw as string[]);
  return { files: [...files.values()] };
}

/**
 * A line range of one file at the task's diff refs, for the expand-context
 * controls. Read-only, and validated twice on purpose: here as an external RPC
 * surface (types and presence), and again in review/file-lines.ts against the
 * files the diff actually contains — a caller with a token must not be able to
 * read an arbitrary path out of a worktree.
 */
export async function handleReviewFileLines(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  return createReviewActions(projectRoot).getFileLines(taskId, {
    path: requireNonBlankString(params, 'path'),
    side: requireEnum(params, 'side', SIDES),
    start: requireNumber(params, 'start'),
    end: requireNumber(params, 'end'),
  });
}

/**
 * What the review page PRESENTS rather than lists, for a client that renders
 * the diff itself (Lazy Teams): every markdown file rendered as a document,
 * and every complete mermaid fence in the diff as a diagram with its anchors.
 *
 * Which stretches fold, which passages are accented, where removed text is
 * shown, which line a comment on a document or a diagram anchors to, which
 * fences count as complete and what id keys each diagram's draft are all
 * decided by the functions the daemon's own page renders with
 * (`renderMarkdownDocument`, `mermaidDiffDiagrams`). A client wraps them in its
 * own chrome; it never re-derives any of it.
 *
 * The source text is read through `getFileLines`, the port the expand controls
 * use, so the files readable here are exactly the files in this diff. A file
 * that cannot be rendered (unreadable, too long, a shape the renderer does not
 * model) is simply absent from `documents`: the client keeps its line diff.
 *
 * Cost: this computes the task diff a second time per Changes load (the first
 * is `reviewDiff`). Folding both into one reply behind an opt-in flag would
 * halve that and guarantee the two agree; not done yet.
 */
export async function handleReviewPresentations(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const region = optionalString(params, 'region')?.trim() || undefined;
  return reviewPresentations(createReviewActions(projectRoot), taskId, region);
}

/** The two review-port reads `reviewPresentations` needs — a seam for its tests. */
export type PresentationReads = Pick<ReturnType<typeof createReviewActions>, 'getDiff' | 'getFileLines'>;

export async function reviewPresentations(actions: PresentationReads, taskId: string, region?: string) {
  const files = parseUnifiedDiff(await actions.getDiff(taskId, { region }));
  const sources = await loadMarkdownSources(files, (query) => actions.getFileLines(taskId, query));
  const documents = [];
  const diagrams = [];
  for (const file of files) {
    const doc = renderMarkdownDocument(file, sources.get(file.path), { allowComments: false });
    if (doc) documents.push({ path: file.path, ...doc });
    const blocks = mermaidDiffDiagrams(file);
    if (blocks.length > 0) diagrams.push({ path: file.path, blocks });
  }
  return { documents, diagrams };
}

/**
 * The latest report's prose blocks with the anchors the daemon's dashboard
 * gives them (`reportProseBlocks`), for a client that renders the report
 * itself. Lazy Teams matches its own rendered blocks to these by text, so a
 * conversation hangs under the same passage on both surfaces — and it never
 * holds a copy of the anchor hash that could drift from `proseAnchorLine`.
 */
export async function handleReviewProseAnchors(params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) throw new RpcError(404, `Task not found: ${taskId}`);
  const session = await storage.getSessionByTaskId(resolved.task.id);
  const report = session ? await storage.getTurnReportBySession(resolved.task.id, session.id) : null;
  return { blocks: reportProseBlocks(report) };
}

export async function handleReviewComments(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const comments = await createReviewActions(projectRoot).listComments(taskId);
  return {
    comments,
    everQueued: hasAnyQueuedComment(comments),
    everAsked: hasAnyAsk(comments),
    promotions: await discussionPromotions(taskId, comments),
  };
}


export async function handleReviewPostComment(projectRoot: string, params: Record<string, unknown>) {
  // This command stores a comment and launches nothing. An ask is `reviewAsk`.
  // Refusing at the boundary — before createReviewActions — is the billing
  // contract: a leftover launch here would spend without a turn owner, because
  // this command is not in TURN_LAUNCHING_COMMANDS. Silent fallback is forbidden.
  const intent = optionalEnum(params, 'intent', INTENTS);
  if (intent === 'ask') {
    throw new RpcError(
      400,
      "reviewPostComment stores a comment and does not launch a turn. To ask the agent, use the reviewAsk command.",
    );
  }
  const taskId = requireString(params, 'taskId');
  const file = requireNonBlankString(params, 'file');
  // The (task) sentinel guard lives in review-service.postComment so both the
  // RPC adapter and the web route share the same protection.
  const comment = await createReviewActions(projectRoot).postComment(taskId, {
    threadId: optionalString(params, 'threadId'),
    file,
    // Not optionalNumber: an unanchored comment renders detached from the code
    // it is about, which is a silently useless comment rather than a rejected one.
    line: requireNumber(params, 'line'),
    side: requireEnum(params, 'side', SIDES),
    content: requireNonBlankString(params, 'content'),
    // Hardcoded: this RPC is comment-only. Omitted intent used to mean ask
    // (same default as in-process ReviewActions); that default must not survive
    // on a command that cannot own a turn.
    intent: 'comment',
    anchorSnippet: optionalString(params, 'anchorSnippet'),
  });
  return { comment };
}

/**
 * First ask from the review surface. Always intent=ask, always a turn-launching
 * command — that is why it is not folded into `reviewPostComment`.
 *
 * `reviewPostComment` stores a comment and launches nothing, so it stays off
 * `TURN_LAUNCHING_COMMANDS` (a control plane that minted a per-user token for
 * every comment would attribute a spend that never happened). The first ask
 * used to ride that same command with `intent: 'ask'`, so Teams could not
 * route it through an actor token the way it does every other turn. This
 * command is the sibling of `reviewRetryAsk`: one job, always a turn, always
 * billed to the caller.
 *
 * `reviewPostComment` refuses `intent: 'ask'` with a 400 that names this
 * command. A leftover launch on a non-turn-launching RPC would spend without
 * a turn owner — the silent fallback the per-user billing mandate forbids.
 */
export async function handleReviewAsk(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const content = requireNonBlankString(params, 'content');
  const fileParam = optionalString(params, 'file');
  const lineParam = optionalNumber(params, 'line');
  const hasFile = fileParam != null && fileParam !== '';
  const hasLine = lineParam != null;

  // Omit file (or pass the task sentinel with line 0) for a task-level ask;
  // pass a real path + line + side for a line-anchored question.
  // Reject partial or inconsistent anchors:
  //   - A line number alone (no file) is ambiguous — reject it
  //   - The (task) sentinel with a non-zero line is inconsistent — reject it
  //   - A real file requires line and side
  let anchor: { file: string; line: number; side: 'old' | 'new' };

  if (!hasFile && hasLine) {
    // Line without file is ambiguous — reject rather than guess.
    throw new RpcError(400, 'A line number without a file is ambiguous. Omit both for a task-level ask, or provide file, line and side for a line-anchored question.');
  }

  if (!hasFile) {
    // No file, no line: task-level ask.
    anchor = TASK_LEVEL_REVIEW_ANCHOR;
  } else if (fileParam === TASK_LEVEL_REVIEW_ANCHOR.file) {
    // Explicit (task) sentinel: line must be 0 or omitted.
    if (hasLine && lineParam !== TASK_LEVEL_REVIEW_ANCHOR.line) {
      throw new RpcError(
        400,
        `The task-level anchor '${TASK_LEVEL_REVIEW_ANCHOR.file}' requires line ${TASK_LEVEL_REVIEW_ANCHOR.line}, not ${lineParam}.`,
      );
    }
    anchor = TASK_LEVEL_REVIEW_ANCHOR;
  } else {
    // Real file: require line and side.
    anchor = {
      file: fileParam,
      line: requireNumber(params, 'line'),
      side: requireEnum(params, 'side', SIDES),
    };
  }

  const comment = await createReviewActions(projectRoot).postComment(taskId, {
    threadId: optionalString(params, 'threadId'),
    file: anchor.file,
    line: anchor.line,
    side: anchor.side,
    content,
    intent: 'ask',
    anchorSnippet: optionalString(params, 'anchorSnippet'),
  });
  return { comment };
}

export async function handleReviewRetryAsk(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const commentId = requireString(params, 'commentId');
  return { comment: await createReviewActions(projectRoot).retryAsk(taskId, commentId) };
}

export async function handleReviewWithdrawComment(projectRoot: string, params: Record<string, unknown>) {
  const taskId = requireString(params, 'taskId');
  const commentId = requireString(params, 'commentId');
  return { comment: await createReviewActions(projectRoot).withdrawComment(taskId, commentId) };
}

export async function handleReviewUnblock(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const taskId = requireString(params, 'taskId');
  // Non-blank, matching `lazy unblock`: an empty feedback message is the one
  // input that would launch a work turn saying nothing at all.
  const message = requireNonBlankString(params, 'message');
  const raisedResolutions = optionalRaisedResolutions(params);
  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept):
  // every unblock door refuses a stale approval list, this one included. The
  // plain RPC and the MCP tool already did; leaving the third silently dropping
  // the field is how a remote client keeps sending `approvedFiles: []` — which
  // used to mean "revert everything" — and believes it decided something.
  if (params.approvedFiles !== undefined) {
    throw new RpcError(400,
      'unblock no longer takes approvedFiles: protected-file approval happens at accept. ' +
      'Unblock with feedback alone, then approve the files on the review page or with ' +
      '`lazy accept <task> --approve-file <file>`.');
  }
  return await createReviewActions(projectRoot).unblock(
    taskId,
    message,
    raisedResolutions,
    progress,
    { keepFeedbackDraft: optionalBoolean(params, 'keepFeedbackDraft') },
  );
}

export async function handleReviewAccept(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const taskId = requireString(params, 'taskId');
  const reason = optionalString(params, 'reason');
  // Optional, and never logged anywhere on the way through: present only when
  // the reviewer is clearing a protection gate from the page.
  const passphrase = optionalString(params, 'passphrase');
  const raisedResolutions = optionalRaisedResolutions(params);
  const approvedFiles = optionalStringArray(params, 'approvedFiles');
  return await createReviewActions(projectRoot).accept(
    taskId,
    reason,
    passphrase,
    raisedResolutions,
    progress,
    approvedFiles,
    { allowQueuedComments: optionalBoolean(params, 'allowQueuedComments') },
  );
}

export async function handleReviewSync(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
) {
  const taskId = requireString(params, 'taskId');
  return await createReviewActions(projectRoot).sync(taskId, progress);
}

export async function handleReviewViolationDecision(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const file = requireNonBlankString(params, 'file');
  const approved = requireBoolean(params, 'approved');
  const violations = await createReviewActions(projectRoot).setViolationDecision(
    taskId,
    file,
    approved,
  );
  return { violations };
}

/**
 * Whose draft these two verbs are about is the TOKEN's identity, never a
 * request field — there is deliberately no `reviewer` parameter. The one
 * definition of that key is `reviewerKey` in src/review-draft.ts; the same
 * function keys the daemon's own web routes and the clear on a delivered
 * unblock/accept, so a reload cannot land on a different key than the save.
 */
export async function handleReviewGetDraft(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  const taskId = requireString(params, 'taskId');
  const draft = await createReviewActions(projectRoot).getDraft(taskId, reviewerKey(caller));
  return { draft };
}

export async function handleReviewSaveDraft(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  const taskId = requireString(params, 'taskId');
  const patch = requireReviewDraftPatch(params);
  const draft = await createReviewActions(projectRoot).saveDraft(
    taskId,
    reviewerKey(caller),
    patch,
  );
  return { draft };
}

/**
 * The Verify tab as data: the latest agent turn's how_to_verify steps (each
 * with the review-draft key and hash its Verified tick is stored under), the
 * superseded steps of earlier sessions, and how many of the current steps the
 * CALLER's draft has ticked. Same rules the daemon dashboard's Verify tab
 * renders with (src/review/verify-state.ts), so a client never re-splits,
 * re-partitions or re-hashes. Ticks are written through `reviewSaveDraft`'s
 * `viewedFiles`, like every other viewed tick. Pass `history: false` to skip
 * the superseded sessions (`earlier` then comes back empty).
 */
export async function handleReviewVerify(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity,
) {
  const taskId = requireString(params, 'taskId');
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) throw new RpcError(404, `Task not found: ${taskId}`);
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const last = latestAgentWorkTurn(turns);
  // `history: false` skips every earlier session: a caller counting ticks on a
  // page that shows no superseded list must not pay for reading them all.
  const history = params.history !== false;
  let reports: Awaited<ReturnType<typeof storage.getTaskTurnReports>>;
  if (history) {
    reports = await storage.getTaskTurnReports(task.id);
  } else {
    const own = last?.session_id ? await storage.getTurnReportBySession(task.id, last.session_id) : null;
    reports = own ? [own] : [];
  }
  const draft = await createReviewActions(projectRoot).getDraft(task.id, reviewerKey(caller));
  return buildVerifyState(
    reports,
    last?.session_id ? { session_id: last.session_id, sequence: last.sequence } : null,
    draft.viewed_files ?? {},
  );
}

const RAISED_ACTIONS = ['respond', 'promote_subtask', 'promote_peer', 'dismiss', 'acknowledge'] as const;

export async function handleReviewResolveRaised(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const itemId = requireNonBlankString(params, 'itemId');
  const action = requireEnum(params, 'action', RAISED_ACTIONS);
  const response = optionalString(params, 'response');
  const item = await createReviewActions(projectRoot).resolveRaisedItem(taskId, itemId, {
    action,
    ...(response != null ? { response } : {}),
  }, optionalActorInput(params));
  return { item };
}

export async function handleReviewUnresolveRaised(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const itemId = requireNonBlankString(params, 'itemId');
  const item = await createReviewActions(projectRoot).unresolveRaisedItem(
    taskId,
    itemId,
    optionalActorInput(params),
  );
  return { item };
}

export async function handleReviewFlagRaised(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const itemId = requireNonBlankString(params, 'itemId');
  const blocking = params.blocking === true || params.blocking === 'true';
  const item = await createReviewActions(projectRoot).setRaisedItemBlocking(
    taskId,
    itemId,
    blocking,
    optionalActorInput(params),
  );
  return { item };
}

export async function handleReviewPromoteDiscussion(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const threadId = requireNonBlankString(params, 'threadId');
  const goal = optionalString(params, 'goal');
  const prompt = optionalString(params, 'prompt');
  const code = optionalString(params, 'code');
  // Subtask is the default here, not peer: a discussion about THIS task's work
  // is usually work under it. The reviewer picks in the dialog either way.
  const relation = params.relation === 'peer' ? 'peer' : 'subtask';
  return await createReviewActions(projectRoot).promoteDiscussion(taskId, threadId, {
    ...(goal != null ? { goal } : {}),
    ...(prompt != null ? { prompt } : {}),
    ...(code != null ? { code } : {}),
    relation,
  });
}

/**
 * Promote part of a stored builder conversation into a task.
 *
 * Not a review command despite living beside them: it reaches the same
 * mutation port, and splitting one method onto its own service would leave
 * the web layer holding two ports to do one kind of thing.
 */
export async function handleConversationPromote(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const sessionId = requireNonBlankString(params, 'sessionId');
  const from = optionalNumber(params, 'from');
  const to = optionalNumber(params, 'to');
  const goal = optionalString(params, 'goal');
  const prompt = optionalString(params, 'prompt');
  const code = optionalString(params, 'code');
  const parent = optionalString(params, 'parent');
  return await createReviewActions(projectRoot).promoteConversation(sessionId, {
    ...(from != null ? { from } : {}),
    ...(to != null ? { to } : {}),
    ...(goal != null ? { goal } : {}),
    ...(prompt != null ? { prompt } : {}),
    ...(code != null ? { code } : {}),
    ...(parent != null ? { parent } : {}),
  });
}

export async function handleReviewPromoteRaised(
  projectRoot: string,
  params: Record<string, unknown>,
) {
  const taskId = requireString(params, 'taskId');
  const itemId = requireNonBlankString(params, 'itemId');
  const goal = optionalString(params, 'goal');
  const code = optionalString(params, 'code');
  const relation = params.relation === 'subtask' ? 'subtask' : 'peer';
  const actor = optionalActorInput(params);
  const result = await createReviewActions(projectRoot).promoteRaisedItem(taskId, itemId, {
    ...(goal != null ? { goal } : {}),
    ...(code != null ? { code } : {}),
    relation,
    ...(actor !== undefined ? { actor } : {}),
  });
  return result;
}

/**
 * The nav's badge counts, for a client that renders its own nav (Lazy Teams).
 * The SAME computation behind the dashboard's `/api/nav-counts`, over the same
 * review port, so every nav reports one set of numbers.
 */
export async function handleNavCounts(projectRoot: string, params: Record<string, unknown>) {
  const storage = await getOrCreateStorage();
  return computeNavCounts(storage, createReviewActions(projectRoot), optionalNumber(params, 'conversationsSince') ?? 0);
}
