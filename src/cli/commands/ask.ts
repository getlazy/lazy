/**
 * `lazy ask <task_id>` — ask a paused task's agent a read-only question.
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
import type { Storage } from '../../storage/interface';
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
async function promptForQuestion(task: Task, jsonOutput: boolean): Promise<{ question: string; recoveryPath: string | null }> {
  const headerLines = [
    `# Task: ${displayId(task)}`,
    ...(task.goal ? [`# Goal: ${task.goal}`] : []),
    '#',
    '# Enter your question for this task\'s agent.',
    '# The agent answers read-only, in plan mode: it will not commit,',
    '# modify the worktree, or unblock the task.',
    '# Lines starting with # will be ignored',
    '',
  ];

  const editResult = await openEditor(headerLines.join('\n') + '\n', `ask-${shortId(task.id)}`);
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

export async function commandAsk(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'message', aliases: ['m'], takesValue: true },
    { name: 'json', takesValue: false },
  ], 'ask');

  const jsonOutput = parsed.flags.get('json') === true;
  const taskId = parsed.positional[0];
  if (!taskId) {
    if (jsonOutput) fail(true, 'Usage: lazy ask <task_id> [-m|--message "..."] [--json]');
    askUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  let recoveryPath: string | null = null;
  try {
    const task = jsonOutput
      ? await resolveTaskForJson(storage, taskId)
      : await resolveTaskOrExit(storage, taskId);

    await preflight(storage, task, jsonOutput);

    // --- Question: --message > piped stdin > interactive prompt (TTY only) ---
    let question: string;
    const messageValue = parsed.flags.get('message') as string | undefined;
    if (messageValue !== undefined) {
      question = messageValue;
    } else {
      const piped = await readStdinIfPiped();
      if (piped !== null) {
        question = piped;
      } else if (isTTY()) {
        // All pre-flight above has already passed, so the human is not about to
        // type into an ask that was doomed before the editor opened.
        const prompted = await promptForQuestion(task, jsonOutput);
        question = prompted.question;
        recoveryPath = prompted.recoveryPath;
      } else {
        fail(
          jsonOutput,
          'No question provided. --message is required when stdin is not a terminal.',
          [`Example: lazy ask ${displayId(task)} --message "why did you rename this?"`],
        );
      }
    }

    question = sanitizeUserText(question).trim();
    if (!question) {
      if (recoveryPath) removeRecoveryFile(recoveryPath);
      fail(jsonOutput, 'Empty question — nothing to ask.');
    }

    if (!jsonOutput) {
      console.error(dim(`Asking ${displayId(task)} (read-only, plan mode) — this may take a minute…`));
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
  console.log(`Usage: lazy ask <task_id> [-m|--message "..."] [--json]

Ask a paused task's agent a question and print its answer.

Read-only: the agent's session is resumed in plan mode, so the ask does NOT
unblock the task, commit, or modify the worktree. The task's status is restored
when the answer comes back. The task must be 'blocked' or 'conflict' and must
have run at least once (there has to be an agent session to resume).

Arguments:
  <task_id>    ID or code of the task to ask (can be shortened)

Options:
  -m, --message "..."   The question. Required when stdin is not a terminal.
  --json                Print {taskId, answer, sessionId, turnNumber, usage,
                        warnings} as JSON instead of the answer alone.
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
  lazy ask abc1 -m "summarize your diff" --json | jq .answer`);
}
