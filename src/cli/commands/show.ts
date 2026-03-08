import { requireStorage, shortId, displayId, formatDate, formatDuration, formatTokenCount, totalTokens, totalInputTokens, parseFlags, parseLineRange, sliceLines } from '../helpers';
import { queryTaskShow, type ShowResult } from '../../daemon/rpc-fallback';
import { protocolDir as getProtocolDir, readStatus } from '../../protocol';
import { theme } from '../theme';
import { readPendingProposals, type Proposal } from './propose';
import { isBuiltinPromptCode, readBuiltinPrompt, listBuiltinPrompts } from './prompts';
import { isBuiltinToolchainCode, readBuiltinToolchain, listBuiltinToolchains } from './toolchains-list';
import { showConversationTranscript } from './import-conversation';
import { isTTY, promptChoice } from '../editor';
import { checkOrphanedChild, type OrphanCheckResult } from '../orphan';
import type { Task, Session, Turn, Commit, Comment } from '../../types';
import type { Storage } from '../../storage/interface';
import { showFileViewer } from '../tui/file-viewer';
import { existsSync, readFileSync } from 'fs';

/**
 * Pre-loaded data for building task show output.
 * Passed to buildTaskShowLines to avoid duplicating data loading.
 */
export interface TaskShowData {
  task: Task;
  session: Session | null;
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  children: Task[];
  childSessions: Map<string, Session | null>;
  proposals: Proposal[];
  parent: Task | null;
  retryStatus: { retryCount: number; errors: { count: number; message: string; firstSeen: string; lastSeen: string }[] } | null;
  orphanStatus: OrphanCheckResult | null;
}

/**
 * Load all data needed for task show output.
 */
export async function loadTaskShowData(storage: Storage, task: Task, root?: string): Promise<TaskShowData> {
  const sess = await storage.getSessionByTaskId(task.id);
  const children = await storage.getChildTasks(task.id);

  let retryStatus: TaskShowData['retryStatus'] = null;
  if (task.status === 'working' && sess) {
    const protoDir = getProtocolDir(task.id);
    const status = readStatus(protoDir);
    if (status?.phase === 'retrying') {
      retryStatus = {
        retryCount: status.retryCount ?? 0,
        errors: status.errors ?? [],
      };
    }
  }

  const turns = sess ? await storage.getSessionTurns(sess.id) : [];
  const commits = sess ? await storage.getSessionCommits(sess.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const proposals = readPendingProposals(storage, task.id);

  const parent = task.parent_task_id ? await storage.getTask(task.parent_task_id) : null;

  const childSessions = new Map<string, Session | null>();
  for (const child of children) {
    childSessions.set(child.id, await storage.getSessionByTaskId(child.id));
  }

  // Check orphan status for child tasks
  let orphanStatus: OrphanCheckResult | null = null;
  if (task.parent_task_id && root) {
    orphanStatus = await checkOrphanedChild(task, storage, root);
  }

  return { task, session: sess, turns, commits, comments, children, childSessions, proposals, parent, retryStatus, orphanStatus };
}

/**
 * Build the text output lines for a task.
 * Used by both the show command (for display) and the search command (for line number computation).
 */
export function buildTaskShowLines(data: TaskShowData, showFull: boolean): string[] {
  const { task, session: sess, turns, commits, comments, children, childSessions, proposals, parent, retryStatus, orphanStatus } = data;
  const outputLines: string[] = [];

  // Task info
  outputLines.push(`Task ${theme.taskId(displayId(task))}`);
  outputLines.push(`  ${theme.label('ID:')}      ${task.id}`);
  if (task.code) {
    outputLines.push(`  ${theme.label('Code:')}    ${task.code}`);
  }
  outputLines.push(`  ${theme.label('Goal:')}    ${task.goal}`);
  outputLines.push(`  ${theme.label('Status:')}  ${theme.status(task.status)}`);
  outputLines.push(`  ${theme.label('Model:')}   ${theme.model(task.model ?? '-')}`);
  outputLines.push(`  ${theme.label('Agent:')}   ${task.agent_id}`);
  outputLines.push(`  ${theme.label('Type:')}    ${task.type ?? 'task'}`);

  outputLines.push(`  ${theme.label('Created:')} ${theme.timestamp(formatDate(task.created_at))}`);
  if (task.completed_at) {
    outputLines.push(`  ${theme.label('Done:')}    ${theme.timestamp(formatDate(task.completed_at))}`);
  }
  if (task.close_reason) {
    outputLines.push(`  ${theme.label('Close Reason:')} ${task.close_reason}`);
  }
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    outputLines.push(`  ${theme.label('Metadata:')}`);
    for (const [key, value] of Object.entries(task.metadata)) {
      outputLines.push(`    ${key}: ${value}`);
    }
  }

  // Parent info
  if (task.parent_task_id) {
    outputLines.push(`\n${theme.label('Parent Task:')}`);
    outputLines.push(`  ${theme.taskId(parent ? displayId(parent) : shortId(task.parent_task_id))} - ${parent?.goal ?? '(unknown)'}`);
    if (task.branched_from_sha) {
      outputLines.push(`  ${theme.label('Branched from:')} ${theme.commitSha(task.branched_from_sha.substring(0, 8))}`);
    }
    // Orphan warning: parent task was accepted and its branch is gone
    if (orphanStatus?.isOrphaned && orphanStatus.retargetBranch) {
      outputLines.push(`\n  ${theme.warning('Warning: Parent task was accepted and its branch deleted.')}`);
      outputLines.push(`  ${theme.warning(`This task needs rebasing onto ${orphanStatus.retargetBranch} before it can continue.`)}`);
      outputLines.push(`  Run ${theme.command('lazy unblock ' + displayId(task))} or ${theme.command('lazy start ' + displayId(task))} to retarget automatically.`);
    }
  }

  // Session info (unified view)
  if (sess) {
    const status = sess.outcome ?? (sess.ended_at ? 'ended' : task.status);
    outputLines.push(`\n${theme.label('Session')} (${sess.agent_id})`);
    outputLines.push(`  ${theme.label('Status:')}           ${theme.status(status)}${sess.ended_at ? ' (' + theme.timestamp(formatDate(sess.ended_at)) + ')' : ''}`);
    outputLines.push(`  ${theme.label('Branch:')}           ${sess.git_branch}`);
    outputLines.push(`  ${theme.label('Started:')}          ${theme.timestamp(formatDate(sess.started_at))}`);
    if (sess.last_interaction_at) {
      outputLines.push(`  ${theme.label('Last Interaction:')} ${theme.timestamp(formatDate(sess.last_interaction_at))}`);
    }
    outputLines.push(`  ${theme.label('Total Duration:')}   ${theme.duration(formatDuration(sess.total_duration_ms))}`);
    if (sess.total_usage) {
      const total = totalTokens(sess.total_usage);
      const inputTotal = totalInputTokens(sess.total_usage);
      outputLines.push(`  ${theme.label('Token Usage:')}      ${formatTokenCount(total)} (${formatTokenCount(inputTotal)} in, ${formatTokenCount(sess.total_usage.outputTokens)} out)`);
      if (sess.total_usage.cacheCreationTokens > 0 || sess.total_usage.cacheReadTokens > 0) {
        outputLines.push(`  ${theme.label('Cache Tokens:')}     ${formatTokenCount(sess.total_usage.cacheCreationTokens)} write, ${formatTokenCount(sess.total_usage.cacheReadTokens)} read`);
      }
    }
    outputLines.push(`  ${theme.label('Start SHA:')}        ${theme.commitSha(sess.git_start_sha.substring(0, 8))}`);

    // Interrupt diagnostics (if task was interrupted)
    if (sess.interrupt_at) {
      outputLines.push(`\n  ${theme.label('Last Interrupt:')}`);
      outputLines.push(`    ${theme.label('Reason:')} ${sess.interrupt_reason ?? 'unknown'}`);
      if (sess.interrupt_exit_code !== null) {
        outputLines.push(`    ${theme.label('Exit Code:')} ${sess.interrupt_exit_code}`);
      }
      outputLines.push(`    ${theme.label('Time:')} ${theme.timestamp(formatDate(sess.interrupt_at))}`);
      outputLines.push(`    ${theme.label('Consecutive:')} ${sess.consecutive_interruptions}`);
      if (sess.auto_resumed) {
        outputLines.push(`    ${theme.label('Auto-resumed:')} yes`);
      }
      if (showFull && sess.interrupt_logs) {
        outputLines.push(`    ${theme.label('Logs (last 50 lines):')}`);
        for (const line of sess.interrupt_logs.split('\n').slice(0, 50)) {
          outputLines.push(`      ${line}`);
        }
      }
    }

    // Retry state (if currently retrying)
    if (retryStatus) {
      outputLines.push(`\n  Retry State:`);
      outputLines.push(`    Retry Count:    ${retryStatus.retryCount}`);
      if (retryStatus.errors.length > 0) {
        outputLines.push(`    Error Log (deduplicated, last 10):`);
        for (const err of retryStatus.errors) {
          outputLines.push(`      - [${err.count}x] ${err.message}`);
          outputLines.push(`        First: ${err.firstSeen}, Last: ${err.lastSeen}`);
        }
      }
    }

    // Turns
    if (turns.length > 0) {
      outputLines.push(`\n  ${theme.label('Turns:')} ${theme.count(String(turns.length))}`);
      for (const turn of turns) {
        const isErrorTurn = turn.role === 'agent' && turn.content.startsWith('[Agent crashed]');
        const usageSuffix = turn.usage
          ? ` | ${formatTokenCount(totalInputTokens(turn.usage))} in, ${formatTokenCount(turn.usage.outputTokens)} out`
          : '';
        const modelSuffix = turn.model && turn.model !== task.model ? ` | ${turn.model}` : '';
        const roleDisplay = isErrorTurn ? theme.error('crash') : theme.turnRole(turn.role);
        if (showFull) {
          outputLines.push(`\n    --- Turn #${turn.sequence} [${roleDisplay}]${usageSuffix}${modelSuffix} ---`);
          if (isErrorTurn) {
            for (const line of turn.content.split('\n')) {
              outputLines.push(`    ${theme.error(line)}`);
            }
          } else {
            // For human turns with a full prompt, show the prompt (what agent saw)
            if (turn.role === 'human' && turn.prompt) {
              outputLines.push(`\n    ${theme.label('--- Full prompt sent to agent ---')}\n`);
              outputLines.push(turn.prompt);
            } else {
              outputLines.push(turn.content);
            }
          }
        } else {
          const preview = turn.content.substring(0, 80).replace(/\n/g, ' ');
          if (isErrorTurn) {
            outputLines.push(`    #${turn.sequence} [${roleDisplay}]${usageSuffix}${modelSuffix} ${theme.error(preview)}${turn.content.length > 80 ? '...' : ''}`);
          } else {
            outputLines.push(`    #${turn.sequence} [${theme.turnRole(turn.role)}]${usageSuffix}${modelSuffix} ${preview}${turn.content.length > 80 ? '...' : ''}`);
          }
        }
      }
    }

    // Commits
    if (commits.length > 0) {
      outputLines.push(`\n  ${theme.label('Commits:')} ${theme.count(String(commits.length))}`);
      for (const c of commits) {
        outputLines.push(`    ${theme.commitSha(c.sha.substring(0, 8))} [${theme.status(c.status)}] ${c.message}`);
      }
    }
  } else {
    outputLines.push(`\n${theme.label('Session:')} (not started)`);
    outputLines.push(`  Start with: ${theme.command('lazy start ' + displayId(task))}`);
  }

  // Children (variants)
  if (children.length > 0) {
    outputLines.push(`\n${theme.label('Child Tasks (variants):')} ${theme.count(String(children.length))}`);
    for (const child of children) {
      const childSess = childSessions.get(child.id) ?? null;
      const childStatus = childSess
        ? (childSess.outcome ?? (childSess.ended_at ? 'ended' : child.status))
        : child.status;
      outputLines.push(`  ${theme.taskId(displayId(child))} [${theme.status(childStatus)}] ${child.goal}`);
    }
  }

  // Comments
  if (comments.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Comments (${comments.length})`)} ${theme.separator('---')}`);

    for (const comment of comments) {
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(comment.created_at))}]`);
        const lines = comment.content.split('\n');
        for (const line of lines) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = comment.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(comment.created_at))}] ${preview}${comment.content.length > 80 ? '...' : ''}`);
      }
    }
  }

  // Proposals
  if (proposals.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Proposals (${proposals.length} pending)`)} ${theme.separator('---')}`);
    for (const p of proposals) {
      const codeSuffix = p.code ? ` [${p.code}]` : '';
      if (showFull) {
        outputLines.push(`\n  ${theme.label('Goal:')} ${p.goal}${codeSuffix}`);
        if (p.prompt) {
          outputLines.push(`  ${theme.label('Prompt:')} ${p.prompt}`);
        }
        outputLines.push(`  ${theme.label('Created:')} ${theme.timestamp(formatDate(p.created_at))}`);
      } else {
        const goalPreview = p.goal.length > 60 ? p.goal.substring(0, 57) + '...' : p.goal;
        outputLines.push(`  ${goalPreview}${codeSuffix}`);
      }
    }
  }

  // Prompt
  if (task.prompt) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label('Prompt')} ${theme.separator('---')}`);
    outputLines.push(task.prompt);
  } else {
    outputLines.push('\n  (no prompt yet)');
  }

  return outputLines;
}

export async function commandShow(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'full', takesValue: false },
    { name: 'lines', takesValue: true },
    { name: 'json', takesValue: false },
  ], 'show');

  const taskId = parsed.positional[0];
  if (!taskId) {
    showUsage();
    process.exit(1);
  }

  // Parse line range if specified
  let lineRange = null;
  const linesValue = parsed.flags.get('lines') as string | undefined;
  if (linesValue !== undefined) {
    lineRange = parseLineRange(linesValue);
    if (!lineRange) {
      console.error(`Invalid line range: ${linesValue}. Format: N..M, N.., or ..M`);
      process.exit(1);
    }
  }

  const jsonOutput = parsed.flags.get('json') === true;

  // Handle built-in prompt codes (lazy-prompt-* prefix)
  if (isBuiltinPromptCode(taskId)) {
    const content = readBuiltinPrompt(taskId);
    if (!content) {
      // Show available prompts to help the user
      const available = listBuiltinPrompts().map(p => p.code);
      console.error(`No built-in system prompt found for '${taskId}'.`);
      console.error(`\nAvailable prompts: ${available.join(', ')}`);
      console.error(`\nRun ${theme.command('lazy system prompts')} to see all built-in system prompts.`);
      process.exit(1);
    }

    if (jsonOutput) {
      const prompts = listBuiltinPrompts();
      const meta = prompts.find(p => p.code === taskId);
      console.log(JSON.stringify({
        type: 'prompt',
        code: taskId,
        filename: meta?.filename ?? null,
        content,
      }));
      return;
    }

    // Find the prompt metadata for display
    const prompts = listBuiltinPrompts();
    const meta = prompts.find(p => p.code === taskId);

    const outputLines: string[] = [];
    outputLines.push(`${theme.label('Prompt')} ${theme.taskId(taskId)}`);
    if (meta) {
      outputLines.push(`  ${theme.label('File:')} ${meta.filename}`);
    }
    outputLines.push(`  ${theme.label('Size:')} ${content.length} chars, ${content.split('\n').length} lines`);
    outputLines.push(`\n${theme.separator('─'.repeat(60))}\n`);
    outputLines.push(content);

    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  // Handle built-in toolchain codes (lazy-toolchain-* prefix)
  if (isBuiltinToolchainCode(taskId)) {
    const toolchain = readBuiltinToolchain(taskId);
    if (!toolchain) {
      const available = listBuiltinToolchains().map(t => t.code);
      console.error(`No built-in toolchain found for '${taskId}'.`);
      console.error(`\nAvailable toolchains: ${available.join(', ')}`);
      console.error(`\nRun ${theme.command('lazy system toolchains')} to see all built-in toolchains.`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify({
        type: 'toolchain',
        code: taskId,
        name: toolchain.name,
        description: toolchain.description,
        content: toolchain.content,
      }));
      return;
    }

    const outputLines: string[] = [];
    outputLines.push(`${theme.label('Toolchain')} ${theme.taskId(toolchain.name)}`);
    outputLines.push(`  ${theme.label('Description:')} ${toolchain.description}`);
    outputLines.push(`  ${theme.label('Size:')} ${toolchain.content.length} chars, ${toolchain.content.split('\n').length} lines`);
    outputLines.push(`\n${theme.separator('─── Dockerfile ───────────────────────────────────────────')}\n`);
    outputLines.push(toolchain.content);

    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  const showFull = parsed.flags.get('full') === true;

  // Try to resolve as a task (daemon → direct fallback)
  const showResult = await queryTaskShow(taskId);

  if (showResult && !showResult.ambiguous) {
    const data = showResult.data;

    if (jsonOutput) {
      const jsonData = buildShowJson(data);
      console.log(JSON.stringify(jsonData));
      return;
    }

    const outputLines = buildTaskShowLines(data, showFull);
    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  if (showResult?.ambiguous) {
    // Build formatted options for each task
    const options: string[] = [];
    for (const t of showResult.matches) {
      const paddedStatus = t.status.padEnd(12);
      options.push(`${shortId(t.id)}  ${paddedStatus}  ${t.goal}`);
    }

    // In TTY mode, offer interactive choice
    if (isTTY()) {
      const choice = await promptChoice(`Multiple tasks match code '${taskId}'. Choose one:`, options);
      const selectedMatch = showResult.matches[choice];

      // Re-query with the full ID to get the task data
      const resolved = await queryTaskShow(selectedMatch.id);
      if (resolved && !resolved.ambiguous) {
        if (jsonOutput) {
          const jsonData = buildShowJson(resolved.data);
          console.log(JSON.stringify(jsonData));
          return;
        }

        const outputLines = buildTaskShowLines(resolved.data, showFull);
        let output = outputLines.join('\n');
        if (lineRange) {
          output = sliceLines(output, lineRange);
        }
        console.log(output);
        return;
      }
    }

    // In non-TTY mode, print error and exit
    console.error(`Multiple tasks match code '${taskId}'. Use the ID to disambiguate:`);
    for (const option of options) {
      console.error(`  ${option}`);
    }
    process.exit(1);
  }

  // Not a task — try conversation session ID, then file path
  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    const convMatch = conversations.find(
      c => c.sessionId === taskId || c.sessionId.startsWith(taskId)
    );

    if (convMatch) {
      if (jsonOutput) {
        const conv = await storage.loadConversation(convMatch.sessionId);
        if (conv) {
          console.log(JSON.stringify({
            type: 'conversation',
            session_id: conv.sessionId,
            summary: conv.summary,
            git_branch: conv.gitBranch,
            started_at: conv.startedAt,
            ended_at: conv.endedAt,
            stats: conv.stats,
            total_usage: conv.totalUsage,
            messages: conv.messages.map(m => ({
              role: m.role,
              text: m.text,
              timestamp: m.timestamp,
              model: m.model,
              usage: m.usage,
            })),
          }));
        }
        return;
      }
      await showConversationTranscript(storage, taskId, lineRange);
      return;
    }
  } finally {
    await storage.close();
  }

  // Try as a file path
  if (existsSync(taskId)) {
    // JSON output for files
    if (jsonOutput) {
      const content = readFileSync(taskId, 'utf-8');
      console.log(JSON.stringify({
        type: 'file',
        path: taskId,
        content,
        size: content.length,
        lines: content.split('\n').length,
      }));
      return;
    }

    // Line range output for files
    if (lineRange) {
      const content = readFileSync(taskId, 'utf-8');
      const output = sliceLines(content, lineRange);
      console.log(output);
      return;
    }

    // Launch full-screen TUI viewer
    await showFileViewer(taskId);
    return;
  }

  console.error(`No task, conversation, or file found matching '${taskId}'`);
  process.exit(1);
}

/** Build the JSON output structure from TaskShowData. Used by both direct and daemon paths. */
function buildShowJson(data: TaskShowData): Record<string, unknown> {
  const { task, session: sess, turns, commits, comments, children, proposals, retryStatus } = data;

  const jsonData: Record<string, unknown> = {
    id: task.id,
    code: task.code,
    goal: task.goal,
    status: task.status,
    type: task.type ?? 'task',
    model: task.model,
    agent_id: task.agent_id,
    prompt: task.prompt || null,
    created_at: task.created_at,
    completed_at: task.completed_at,
    close_reason: task.close_reason,
    parent_task_id: task.parent_task_id,
    branched_from_sha: task.branched_from_sha,
    metadata: task.metadata,
    session: sess ? {
      id: sess.id,
      agent_id: sess.agent_id,
      status: sess.outcome ?? (sess.ended_at ? 'ended' : task.status),
      git_branch: sess.git_branch,
      git_start_sha: sess.git_start_sha,
      started_at: sess.started_at,
      ended_at: sess.ended_at,
      last_interaction_at: sess.last_interaction_at,
      total_duration_ms: sess.total_duration_ms,
      total_usage: sess.total_usage,
      consecutive_interruptions: sess.consecutive_interruptions,
      auto_resumed: sess.auto_resumed,
    } : null,
    turns: turns.map(t => ({
      sequence: t.sequence,
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
      usage: t.usage,
      model: t.model ?? null,
    })),
    commits: commits.map(c => ({
      sha: c.sha,
      message: c.message,
      status: c.status,
      timestamp: c.timestamp,
    })),
    comments: comments.map(c => ({
      content: c.content,
      created_at: c.created_at,
    })),
    children: children.map(c => ({
      id: c.id,
      code: c.code,
      goal: c.goal,
      status: c.status,
    })),
    proposals: proposals.map(p => ({
      goal: p.goal,
      code: p.code || null,
      prompt: p.prompt || null,
      status: p.status,
      created_at: p.created_at,
    })),
  };

  if (retryStatus) {
    jsonData.retry_status = retryStatus;
  }

  return jsonData;
}

export function showUsage(): void {
  console.log(`Usage: lazy show <id> [--full] [--lines N..M] [--json]

Show detailed information about a task, conversation, or file.

If given a task ID or task code, shows the task with its session, turns,
commits, comments, and any child tasks (variants).

If given a conversation session ID (or prefix), shows the full interleaved
conversation transcript.

If given a file path, renders the file in a scrollable TUI viewer.
Markdown files (.md) are rendered with formatting.

Also supports viewing built-in system prompts (lazy-prompt-*) and
toolchain Dockerfiles (lazy-toolchain-*).

Arguments:
  <id>         Task ID, task code, conversation session ID, file path,
               built-in prompt code, or toolchain code

Options:
  --full       Show complete turn and comment content instead of truncated preview
  --lines N..M Return only lines N through M of the output (1-indexed, inclusive)
               Formats: N..M (range), N.. (from N to end), ..M (start to M)
  --json       Output as structured JSON instead of human-readable text

Examples:
  lazy show abc12345                          # Show task by ID
  lazy show abc1                              # Prefix matching works
  lazy show abc1 --full                       # Show full turn and comment content
  lazy show abc1 --lines 10..20               # Show only lines 10-20 of output
  lazy show abc1 --lines 50..                 # Show from line 50 to end
  lazy show abc1 --json                       # Output task as JSON
  lazy show dddddddd                          # Show conversation by session ID prefix
  lazy show dddddddd --lines 1..100           # Show first 100 lines of conversation
  lazy show lazy-prompt-system-instructions   # View a built-in system prompt
  lazy show lazy-toolchain-rust               # View a toolchain Dockerfile
  lazy show README.md                         # View a file in scrollable TUI
  lazy show src/index.ts                      # View a TypeScript file
  lazy show CLAUDE.md --lines 1..50           # Show first 50 lines of file`)
}
