/**
 * `lazy ask <id>` — ask a read-only question about a task or a stored conversation.
 *
 * Two things can be asked, chosen from what the id resolves to — the same
 * polymorphic dispatch `lazy show <id>` already does (task first, then
 * conversation), so a reviewer who knows one command knows the other:
 *
 *   - **A task** (task id or code): resumes the paused agent's live session.
 *     Everything below this paragraph describes that path.
 *   - **A stored conversation** (session id or unique prefix): a throwaway
 *     read-only agent reads the stored transcript and answers from it. No live
 *     session, no worktree, nothing written — see src/conversation/ask.ts.
 *
 * Thin CLI surface over the daemon's `askTask` RPC (`launchAskTask` in
 * src/daemon/task-lifecycle.ts): a plan-mode resume of the agent's live
 * session that answers a question without unblocking the task, committing, or
 * touching the worktree. The task's pre-ask status is restored when the turn
 * completes, so an ask never mutates task state.
 *
 * The RPC is long — the agent may chew on a question for minutes. That is safe
 * without any special handling here: every `/rpc/` call goes out with the
 * heartbeat header (src/daemon/client.ts) and the daemon frames long replies in
 * a heartbeat envelope (src/daemon/server.ts), so the listener's idle timer
 * never reaps an in-flight ask.
 */

import { requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit } from '../helpers';
import { isTTY, openEditor, readStdinIfPiped, removeRecoveryFile } from '../editor';
import { theme, dim } from '../theme';
import { writeStdoutLine } from '../../utils/stdio';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { resolveStoredConversation } from '../../conversation/ask';
import type { Storage } from '../../storage/interface';
import type { StoredConversation } from '../../storage/types';
import type { Task } from '../../types';

/**
 * Emit an error in the shape the caller asked for, then exit non-zero.
 *
 * Errors are short, so `console.log` (synchronous on Bun) is safe here — unlike
 * the answer itself, which can be tens of KB and goes through `writeStdout`.
 */
function fail(jsonOutput: boolean, message: string, extraLines: string[] = []): never {
  if (jsonOutput) {
    // Machine consumers parse stdout; the non-zero exit code carries "failed".
    console.log(JSON.stringify({ error: [message, ...extraLines].join(' ') }));
  } else {
    console.error(message);
    for (const line of extraLines) console.error(line);
  }
  process.exit(1);
}

/**
 * Strip the `RPC askTask failed: 409 ` wrapper the daemon client adds so the
 * human sees the daemon's actionable sentence, not our transport framing.
 */
function unwrapRpcMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(/^RPC \w+ failed: \d{3}\s+([\s\S]+)$/);
  return match ? match[1].trim() : raw;
}

/**
 * Pre-flight the ask against storage.
 *
 * INVARIANT (CLAUDE.md — never lose human feedback): everything that can fail
 * before the agent runs happens BEFORE the human types their question. These
 * mirror the checks `launchAskTask` performs authoritatively (it is still the
 * gate that matters — the daemon may flip a task to `working` between this
 * check and the RPC), with the same wording as the `lazy_ask` MCP tool.
 */
async function preflight(storage: Storage, task: Task, jsonOutput: boolean): Promise<void> {
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    fail(jsonOutput, `Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
  }
  if (sess.ended_at) {
    fail(jsonOutput, `Task ${displayId(task)} session has ended. Create a variant with: lazy branch ${displayId(task)}`);
  }
  if (!sess.agent_session_id) {
    fail(jsonOutput, `Task ${displayId(task)} has no agent session to resume — cannot ask until the agent has run at least once.`);
  }
  if (task.status !== 'blocked' && task.status !== 'conflict') {
    fail(
      jsonOutput,
      `Task ${displayId(task)} is '${task.status}', not 'blocked' or 'conflict'. ` +
      'Ask only runs against a blocked or conflict task — wait until the agent is paused for review.',
    );
  }
}

/**
 * Open $EDITOR for the question and return it with its recovery-file path.
 *
 * $EDITOR rather than a single-line prompt because a review question is often
 * pasted — a stack trace, a diff hunk, a quoted line of the agent's own output —
 * and a readline prompt cannot take embedded LF/CR and offers no way to correct
 * a typo three words back.
 *
 * INVARIANT (CLAUDE.md — never lose human feedback): `openEditor` writes the
 * typed text to a recovery file BEFORE its temp file is cleaned up, so the
 * question survives any later failure. The caller removes that file only once
 * the ask has actually been answered.
 */
async function promptForQuestion(
  headerLines: string[],
  slug: string,
  jsonOutput: boolean,
): Promise<{ question: string; recoveryPath: string | null }> {
  const editResult = await openEditor(headerLines.join('\n') + '\n', slug);
  if (editResult === null) fail(jsonOutput, 'Editor exited with non-zero status — question not sent.');

  // Only comment lines are stripped. Blank lines and leading indentation are
  // preserved deliberately: a pasted snippet or stack trace inside the question
  // loses its meaning if the structure is flattened.
  const question = editResult.content
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
    .trim();

  return { question, recoveryPath: editResult.recoveryPath };
}

/** Resolve a task without the interactive/human-formatted path of resolveTaskOrExit. */
async function resolveTaskForJson(storage: Storage, input: string): Promise<Task> {
  const result = await storage.resolveTask(input);
  if (result.task) return result.task;
  if (result.ambiguousMatches?.length) {
    const matches = result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ');
    fail(true, `Multiple tasks match '${input}'. Use the ID to disambiguate: ${matches}`);
  }
  fail(true, `No task found matching '${input}'`);
}

/**
 * Get the question: --message > piped stdin > $EDITOR (TTY only).
 *
 * Shared by both ask targets so the input contract — including the recovery
 * file that makes a typed question survive a later failure — cannot drift
 * between them.
 */
async function obtainQuestion(opts: {
  messageValue: string | undefined;
  jsonOutput: boolean;
  headerLines: string[];
  slug: string;
  example: string;
}): Promise<{ question: string; recoveryPath: string | null }> {
  if (opts.messageValue !== undefined) {
    return { question: opts.messageValue, recoveryPath: null };
  }
  const piped = await readStdinIfPiped();
  if (piped !== null) return { question: piped, recoveryPath: null };
  if (isTTY()) {
    // All pre-flight has already passed, so the human is not about to type
    // into an ask that was doomed before the editor opened.
    return await promptForQuestion(opts.headerLines, opts.slug, opts.jsonOutput);
  }
  fail(
    opts.jsonOutput,
    'No question provided. --message is required when stdin is not a terminal.',
    [`Example: ${opts.example}`],
  );
}

/**
 * The stored-conversation branch of `lazy ask`.
 *
 * Deliberately NOT a daemon RPC: there is no session to hold, no task status to
 * guard and nothing to persist, so this runs the one-shot agent right here the
 * way `lazy report` runs its map-reduce. The daemon is still the source of the
 * transcript — `storage` is the daemon-backed handle.
 */
async function askConversationTarget(
  conv: StoredConversation,
  messageValue: string | undefined,
  jsonOutput: boolean,
): Promise<void> {
  const shortSession = conv.sessionId.substring(0, 8);
  const { question, recoveryPath } = await obtainQuestion({
    messageValue,
    jsonOutput,
    slug: `ask-conversation-${shortSession}`,
    example: `lazy ask ${shortSession} --message "what did we decide about retries?"`,
    headerLines: [
      `# Conversation: ${conv.sessionId}`,
      `# Summary: ${conv.summary}`,
      ...(conv.startedAt ? [`# Started: ${conv.startedAt}`] : []),
      '#',
      '# Enter your question about this stored conversation.',
      '# A throwaway read-only agent reads the transcript and answers.',
      '# Nothing is written back — the conversation is immutable history.',
      '# Lines starting with # will be ignored',
      '',
    ],
  });

  const cleaned = sanitizeUserText(question).trim();
  if (!cleaned) {
    if (recoveryPath) removeRecoveryFile(recoveryPath);
    fail(jsonOutput, 'Empty question — nothing to ask.');
  }

  const { askConversation } = await import('../../conversation/ask');
  const { loadConfig } = await import('../../config/loader');
  const { requireLazyRoot } = await import('../helpers');
  const config = await loadConfig(requireLazyRoot());

  let result;
  try {
    result = await askConversation(conv, cleaned, {
      model: config.models.default,
      // Progress on stderr, so it never contaminates a piped answer, and the
      // human is never left watching silence through a multi-pass read.
      onProgress: jsonOutput ? undefined : (message) => console.error(dim(message)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (recoveryPath) fail(jsonOutput, message, [`Your question was saved to: ${recoveryPath}`]);
    fail(jsonOutput, message);
  }

  // Answered — the question is consumed, so the recovery file can go.
  if (recoveryPath) removeRecoveryFile(recoveryPath);

  if (jsonOutput) {
    await writeStdoutLine(JSON.stringify({
      type: 'conversation',
      conversationId: shortSession,
      sessionId: result.sessionId,
      answer: result.answer,
      chunks: result.chunks,
      relevantChunks: result.relevantChunks,
      usage: result.usage,
      warnings: result.warnings,
    }));
    return;
  }

  for (const warning of result.warnings) {
    console.error(theme.warning(`Warning: ${warning}`));
  }
  await writeStdoutLine(result.answer.trim());
}

export async function commandAsk(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'message', aliases: ['m'], takesValue: true },
    { name: 'json', takesValue: false },
  ], 'ask');

  const jsonOutput = parsed.flags.get('json') === true;
  const messageValue = parsed.flags.get('message') as string | undefined;
  const taskId = parsed.positional[0];
  if (!taskId) {
    if (jsonOutput) fail(true, 'Usage: lazy ask <id> [-m|--message "..."] [--json]');
    askUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  let recoveryPath: string | null = null;
  try {
    // --- Target: task first, then stored conversation ---
    // Same resolution order as `lazy show <id>`, so one id-shaped argument
    // means the same thing across both commands. A task id that resolves
    // ambiguously stays a TASK question (the human gets the disambiguation
    // list); only a string that matches no task at all is tried as a
    // conversation.
    const taskMatch = await storage.resolveTask(taskId);
    if (!taskMatch.task && !taskMatch.ambiguousMatches?.length) {
      const conv = await resolveStoredConversation(storage, taskId);
      if (conv && 'ambiguous' in conv) {
        fail(
          jsonOutput,
          `Multiple conversations match '${taskId}'. Use a longer prefix to disambiguate:`,
          conv.ambiguous.map(c => `  ${c.sessionId.substring(0, 8)}  ${c.summary.split('\n')[0].substring(0, 60)}`),
        );
      }
      if (conv) {
        await askConversationTarget(conv.conversation, messageValue, jsonOutput);
        return;
      }
      fail(jsonOutput, `No task or conversation found matching '${taskId}'`);
    }

    const task = jsonOutput
      ? await resolveTaskForJson(storage, taskId)
      : await resolveTaskOrExit(storage, taskId);

    await preflight(storage, task, jsonOutput);

    // --- Question: --message > piped stdin > interactive prompt (TTY only) ---
    const prompted = await obtainQuestion({
      messageValue,
      jsonOutput,
      slug: `ask-${shortId(task.id)}`,
      example: `lazy ask ${displayId(task)} --message "why did you rename this?"`,
      headerLines: [
        `# Task: ${displayId(task)}`,
        ...(task.goal ? [`# Goal: ${task.goal}`] : []),
        '#',
        '# Enter your question for this task\'s agent.',
        '# The agent answers read-only, reflectively: it will not commit,',
        '# modify the worktree, or unblock the task.',
        '# Lines starting with # will be ignored',
        '',
      ],
    });
    recoveryPath = prompted.recoveryPath;

    const question = sanitizeUserText(prompted.question).trim();
    if (!question) {
      if (recoveryPath) removeRecoveryFile(recoveryPath);
      fail(jsonOutput, 'Empty question — nothing to ask.');
    }

    if (!jsonOutput) {
      console.error(dim(`Asking ${displayId(task)} (read-only, reflective) — this may take a minute…`));
    }

    const { queryAskTask } = await import('../../daemon/rpc-fallback');
    let result;
    try {
      result = await queryAskTask({ taskId: task.id, message: question });
    } catch (err) {
      const message = unwrapRpcMessage(err);
      if (recoveryPath) {
        fail(jsonOutput, message, [`Your question was saved to: ${recoveryPath}`]);
      }
      fail(jsonOutput, message);
    }

    // Answered — the question is consumed, so the recovery file can go.
    if (recoveryPath) removeRecoveryFile(recoveryPath);

    // An answer can be tens of KB, and the CLI exits via process.exit() right
    // after this returns. On a pipe that combination silently drops the tail
    // (see src/utils/stdio.ts), so the answer must be written through the
    // draining writer rather than console.log.
    if (jsonOutput) {
      await writeStdoutLine(JSON.stringify({
        // Additive: `type` discriminates the two answer shapes for a consumer
        // that passes an id through without knowing which it resolved to.
        // Every pre-existing field is unchanged.
        type: 'task',
        taskId: displayId(task),
        fullTaskId: task.id,
        answer: result.answer,
        sessionId: result.sessionId,
        turnNumber: result.turnNumber,
        usage: result.usage ?? null,
        warnings: result.warnings ?? [],
      }));
      return;
    }

    for (const warning of result.warnings ?? []) {
      console.error(theme.warning(`Warning: ${warning}`));
    }
    await writeStdoutLine(result.answer.trim());
  } finally {
    await storage.close();
  }
}

export function askUsage(): void {
  console.log(`Usage: lazy ask <id> [-m|--message "..."] [--json]

Ask a question and print the answer. Read-only either way — an ask never writes.

<id> resolves the same way as 'lazy show': a TASK first, then a stored
CONVERSATION.

Asking a TASK (task id or code):
  Resumes the paused agent's own session, reflectively. Does NOT unblock the
  task, commit, or modify the worktree; the task's status is restored when the
  answer comes back. The task must be 'blocked' or 'conflict' and must have run
  at least once (there has to be an agent session to resume).

Asking a CONVERSATION (session id or unique prefix, from 'lazy builder list'):
  A throwaway read-only agent reads the stored transcript and answers from it —
  "what did we decide about X in that session?". Nothing is written back; the
  conversation is immutable history. Works long after Claude Code's own
  retention has aged the session out of /resume, because lazy kept it. A
  transcript too large for one pass is read as consecutive excerpts and the
  answer composed from them; anything elided or unreadable is reported as a
  warning rather than silently dropped.

Arguments:
  <id>         Task ID or code, or conversation session ID (can be shortened)

Options:
  -m, --message "..."   The question. Required when stdin is not a terminal.
  --json                Print the answer as JSON instead of text.
                        Task:         {type, taskId, fullTaskId, answer,
                                       sessionId, turnNumber, usage, warnings}
                        Conversation: {type, conversationId, sessionId, answer,
                                       chunks, relevantChunks, usage, warnings}
                        Errors are printed as {"error": "..."} with exit 1.

Input priority: --message flag > piped stdin > $EDITOR (TTY)

With no --message and nothing piped, $EDITOR opens for the question, so a
pasted stack trace or diff hunk keeps its line breaks. Lines starting with #
are ignored. The typed question is saved to .lazy/recovery/ before it is sent
and is only discarded once the agent has answered.

The answer is printed on stdout and progress on stderr, so the answer can be
redirected or piped on its own. An ask runs a real agent turn and can take a
minute or more.

Examples:
  lazy ask abc12345 -m "why did you drop the retry?"
  lazy ask abc1                                        # Opens $EDITOR for the question
  echo "what did you change in auth.ts?" | lazy ask abc1
  lazy ask abc1 -m "summarize your diff" --json | jq .answer
  lazy ask 4f8c2a1b -m "what did we decide about retention?"   # A stored conversation
  lazy builder list                                    # Find conversation session IDs`);
}
