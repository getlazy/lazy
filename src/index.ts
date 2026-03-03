#!/usr/bin/env bun

import { init, findLazyRoot, findGitRoot } from './cli/init';
import { isTTY, promptYesNo } from './cli/editor';
import {
  commandCreate, createUsage,
  commandEdit, editUsage,
  commandBranch, branchUsage,
  commandClone, cloneUsage,
  commandStart, startUsage,
  commandUnblock, unblockUsage,
  commandList, listUsage,
  commandActive, activeUsage,
  commandBlocked, blockedUsage,
  commandShow, showUsage,
  commandStatus, statusUsage,
  commandDiff, diffUsage,
  commandShell, shellUsage,
  commandPair, pairUsage,
  commandAccept, acceptUsage,
  commandReject, rejectUsage,
  commandClose, closeUsage,
  commandSearch, searchUsage,
  commandComment, commentUsage,
  commandLink, linkUsage,
  commandImportConversation, importConversationUsage,
  commandServer, serverUsage,
  commandReopen, reopenUsage,
  commandResume, resumeUsage,
  commandWait, waitUsage,
  commandBuilder, builderUsage,
  commandDoctor, doctorUsage,
  commandLoop, loopUsage,
  commandRevert, revertUsage,
  commandPropose, proposeUsage,
  commandSync, syncUsage,
  commandCompletion, completionUsage,
  commandReview, reviewUsage,
  commandRedo, redoUsage,
  commandUpgrade, upgradeUsage,
  commandSystem, systemUsage,
  commandDocument, documentUsage,
  commandRefactor, refactorUsage,
  commandFix, fixUsage,
  commandRework, reworkUsage,
} from './cli/commands';
import { handleFuzzyCommand } from './cli/fuzzy-command';
import { createStorage } from './storage';
import { reconcileTasks } from './utils/reconcile';
import { VERSION } from './version';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`lazy v${VERSION}

Usage: lazy <command> [options]

Task Management:
  start                  Create and start a new task (or start existing)
  fix                    Create a debugging/fix task (experimental methodology)
  document               Create a documentation task (design docs, not code)
  refactor               Create a refactoring task (restructure, no behavior change)
  edit <task_id>         Edit a task's goal or prompt
  comment <task_id>      Add a comment/annotation to a task
  clone <task_id>        Duplicate task with optional reparenting
  list / tasks           List all non-terminal tasks
  active                 List active tasks (with sessions)
  blocked                List blocked tasks (waiting for user)
  show <task_id>         Show task details
  search <query>         Search tasks, prompts, turns, commits, comments

Working on Tasks:
  review <task_id>       TUI review: full-screen artifact browser
  loop                   Review all blocked tasks sequentially
  unblock <task_id>      Unblock task: interactive review or feedback
  resume <task_id>       Resume an interrupted task
  reopen <task_id>       Reopen a rejected task
  branch <task_id>       Create a variant task (fork)
  wait [<task_id>...]    Wait for task(s) to complete (--follow, --next)

System:
  system prompts         List built-in system prompt templates

Inspect:
  diff <task_id>         Show changes made by task
  status <task_id>       Show worktree and commit state
  shell <task_id>        Open shell in task's worktree
  pair <task_id>         Pair program with Claude in task's worktree
  accept <task_id>       Merge task's work
  reject <task_id>       Discard task's work
  revert <task_id>       Undo an accepted task (create revert task)
  rework <task_id>       Create follow-up task for accepted work that needs changes
  close <task_id>        Close task without work
  redo <task_id>         Close stale task and restart fresh on current main

Proposals:
  propose                Propose a follow-up task

Link:
  link <url>             Link an external resource (e.g., GitHub PR) as a task

Import:
  import-conversation    Import Claude Code conversation logs

Remote:
  sync                   Sync lazy tasks with your remote repository

Server:
  server                 Start web dashboard server

Builder:
  builder                Launch Claude Code with Lazy builder prompt

Setup:
  init                   Initialize lazy in a git repository
  doctor                 Check installation health
  upgrade                Rebuild image/binary and restart containers
  completion             Output shell completion script (--bash or --zsh)

Run 'lazy <command> --help' for more information on a command.`);
}

// Command dispatch table: maps command names to their handler and usage functions.
const commandMap: Record<string, { run: (args: string[]) => Promise<void>; usage: () => void }> = {
  'link':     { run: commandLink, usage: linkUsage },
  'import-conversation': { run: commandImportConversation, usage: importConversationUsage },
  'init':     {
    run: async (args: string[]) => {
      const skipAuthCheck = args.includes('--skip-auth-check');
      const skipRemoteCheck = args.includes('--skip-remote-check') || args.includes('--skip-github-check');
      const skipCompletionCheck = args.includes('--skip-completion-check');
      const nonInteractive = args.includes('--non-interactive');
      // Extract --toolchain value (--toolchain <name>)
      let toolchain: string | undefined;
      const toolchainIdx = args.indexOf('--toolchain');
      if (toolchainIdx !== -1 && toolchainIdx + 1 < args.length) {
        toolchain = args[toolchainIdx + 1];
      }
      await init(process.cwd(), { skipAuthCheck, skipRemoteCheck, skipCompletionCheck, nonInteractive, toolchain });
    },
    usage: () => {
      console.log('Usage: lazy init [--toolchain <name>] [--skip-auth-check] [--skip-remote-check] [--skip-completion-check]\n');
      console.log('Initialize lazy in the current git repository.\n');
      console.log('Requires an interactive terminal to display warnings and instructions.\n');
      console.log('If a supported remote (GitHub, etc.) is detected, offers to configure it.\n');
      console.log('Auto-detects project toolchain and configures the appropriate Docker image.\n');
      console.log('Options:');
      console.log('  --toolchain <name>        Override auto-detected toolchain');
      console.log('                            Available: base, bun, node, deno, rust, go, cpp,');
      console.log('                            ruby-rails, ruby-rails-rust, dotnet, python,');
      console.log('                            python-ml, java, kotlin, swift');
      console.log('  --skip-auth-check         Skip authentication check during init');
      console.log('  --skip-remote-check       Skip remote driver detection during init');
      console.log('  --skip-github-check       Alias for --skip-remote-check');
      console.log('  --skip-completion-check   Skip shell completion recommendation');
    },
  },
  'create':   { run: commandCreate, usage: createUsage },
  'edit':     { run: commandEdit, usage: editUsage },
  'clone':    { run: commandClone, usage: cloneUsage },
  'list':     { run: commandList, usage: listUsage },
  'ls':       { run: commandList, usage: listUsage },
  'tasks':    { run: commandList, usage: listUsage },
  'active':   { run: commandActive, usage: activeUsage },
  'blocked':  { run: commandBlocked, usage: blockedUsage },
  'show':     { run: commandShow, usage: showUsage },
  'view':     { run: commandShow, usage: showUsage },
  'search':   { run: commandSearch, usage: searchUsage },
  'comment':  { run: commandComment, usage: commentUsage },
  'start':    { run: commandStart, usage: startUsage },
  'unblock':  { run: commandUnblock, usage: unblockUsage },
  'resume':   { run: commandResume, usage: resumeUsage },
  'reopen':   { run: commandReopen, usage: reopenUsage },
  'branch':   { run: commandBranch, usage: branchUsage },
  'server':   { run: commandServer, usage: serverUsage },
  'diff':     { run: commandDiff, usage: diffUsage },
  'status':   { run: commandStatus, usage: statusUsage },
  'shell':    { run: commandShell, usage: shellUsage },
  'pair':     { run: commandPair, usage: pairUsage },
  'accept':   { run: commandAccept, usage: acceptUsage },
  'reject':   { run: commandReject, usage: rejectUsage },
  'revert':   { run: commandRevert, usage: revertUsage },
  'close':    { run: commandClose, usage: closeUsage },
  'wait':     { run: commandWait, usage: waitUsage },
  'builder':  { run: commandBuilder, usage: builderUsage },
  'doctor':   { run: commandDoctor, usage: doctorUsage },
  'loop':     { run: commandLoop, usage: loopUsage },
  'propose':  { run: commandPropose, usage: proposeUsage },
  'sync':     { run: commandSync, usage: syncUsage },
  'completion': { run: commandCompletion, usage: completionUsage },
  'review':   { run: commandReview, usage: reviewUsage },
  'redo':     { run: commandRedo, usage: redoUsage },
  'upgrade':  { run: commandUpgrade, usage: upgradeUsage },
  'system':   { run: commandSystem, usage: systemUsage },
  'document': { run: commandDocument, usage: documentUsage },
  'doc':      { run: commandDocument, usage: documentUsage },
  'refactor': { run: commandRefactor, usage: refactorUsage },
  'fix':      { run: commandFix, usage: fixUsage },
  'rework':   { run: commandRework, usage: reworkUsage },
};

// All valid command names for fuzzy matching (excludes aliases like ls/tasks/view
// to avoid confusing suggestions — we match against canonical names only)
const fuzzyMatchCommands = Object.keys(commandMap).filter(c => c !== 'ls' && c !== 'tasks' && c !== 'doc' && c !== 'view');

/**
 * Run reconciliation before a command if needed.
 * Skip for commands that don't need storage (init, help, server).
 */
async function reconcileIfNeeded(cmd: string): Promise<void> {
  // Commands that don't need reconciliation
  const skipReconciliation = ['init', 'server', 'builder', 'doctor', 'sync', 'completion', 'upgrade', 'system'];

  if (skipReconciliation.includes(cmd)) {
    return;
  }

  // Try to find lazy root and run reconciliation
  const root = findLazyRoot();
  if (!root) {
    // Not in a lazy project — command will fail with its own error
    return;
  }

  try {
    const storage = await createStorage(root);
    try {
      await reconcileTasks(storage, root);
    } finally {
      await storage.close();
    }
  } catch {
    // Silently skip reconciliation on error — command will handle storage errors
  }
}

async function dispatch(cmd: string, cmdArgs: string[]): Promise<void> {
  const entry = commandMap[cmd];
  if (!entry) return;

  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    entry.usage();
  } else {
    // Run reconciliation before command execution
    await reconcileIfNeeded(cmd);
    await entry.run(cmdArgs);
  }
}

// Hidden internal commands: used by host-process runner, not shown in help.
// These mirror the agent-entry.ts commands but run inside the main CLI process.
const hiddenCommands: Record<string, (args: string[]) => Promise<void>> = {
  'supervise': async (cmdArgs: string[]) => {
    const protocolDirIdx = cmdArgs.indexOf('--protocol-dir');
    const worktreeIdx = cmdArgs.indexOf('--worktree');
    const runnerIdx = cmdArgs.indexOf('--runner');

    if (protocolDirIdx === -1 || protocolDirIdx + 1 >= cmdArgs.length) {
      console.error('Missing required flag: --protocol-dir <path>');
      process.exit(1);
    }
    if (worktreeIdx === -1 || worktreeIdx + 1 >= cmdArgs.length) {
      console.error('Missing required flag: --worktree <path>');
      process.exit(1);
    }

    const protocolDir = cmdArgs[protocolDirIdx + 1];
    const worktreePath = cmdArgs[worktreeIdx + 1];
    const oneShot = cmdArgs.includes('--one-shot');
    const runnerType = (runnerIdx !== -1 && runnerIdx + 1 < cmdArgs.length)
      ? cmdArgs[runnerIdx + 1] as import('./config/types').RunnerType
      : undefined;

    const { runSupervisor } = await import('./supervisor/index');
    await runSupervisor({ protocolDir, worktreePath, oneShot, runnerType });
  },

  'mcp': async (cmdArgs: string[]) => {
    const taskIdIdx = cmdArgs.indexOf('--task-id');
    const worktreeIdx = cmdArgs.indexOf('--worktree');

    if (taskIdIdx === -1 || taskIdIdx + 1 >= cmdArgs.length) {
      console.error('Missing required flag: --task-id <uuid>');
      process.exit(1);
    }
    if (worktreeIdx === -1 || worktreeIdx + 1 >= cmdArgs.length) {
      console.error('Missing required flag: --worktree <path>');
      process.exit(1);
    }

    const taskId = cmdArgs[taskIdIdx + 1];
    const worktreePath = cmdArgs[worktreeIdx + 1];

    const { startMcpServer } = await import('./mcp/index');
    await startMcpServer({ taskId, worktreePath });
  },

};

// Legacy commands: show removal message
const legacyCommands: Record<string, string> = {
  'pending': 'Error: `lazy pending` has been removed. All tasks are started immediately. Use: lazy list',
  'task': 'Error: `lazy task` has been removed. Use: lazy start, lazy edit, lazy list, lazy show',
  'session': 'Error: `lazy session` has been removed. Use: lazy start, lazy unblock, lazy accept, lazy reject',
};

// Hidden internal commands: bypass auto-init, reconciliation, and help.
if (command && hiddenCommands[command]) {
  await hiddenCommands[command](args.slice(1));
  process.exit(0);
}

// Auto-init: if running in an uninitialized git repo, offer to initialize.
// Skip for init itself, help, version, and completion.
const skipAutoInit = ['init', 'completion'];
const isHelpOrVersion = !command || command === '--help' || command === '-h' || command === '--version' || command === '-V';

if (!isHelpOrVersion && (!command || !skipAutoInit.includes(command))) {
  const lazyRoot = findLazyRoot();
  if (!lazyRoot) {
    const gitRoot = findGitRoot();
    if (gitRoot && isTTY()) {
      console.log('This git repository has not been initialized for lazy.');
      console.log('lazy init creates a lazy.toml config file and a .lazy/ directory for task tracking.');
      console.log('');
      const shouldInit = await promptYesNo('Would you like to initialize lazy now?', true);
      if (shouldInit) {
        await init(gitRoot);
        // After init, continue to run the original command
      } else {
        process.exit(0);
      }
    }
  }
}

if (!command || command === '--help' || command === '-h') {
  // Help
  usage();
} else if (command === '--version' || command === '-V') {
  console.log(VERSION);
} else if (legacyCommands[command]) {
  // Legacy commands
  console.error(legacyCommands[command]);
  process.exit(1);
} else if (commandMap[command]) {
  // Known command — dispatch it
  await dispatch(command, args.slice(1));
  process.exit(0);
} else {
  // Unknown command — try fuzzy matching
  const result = await handleFuzzyCommand(command, args, fuzzyMatchCommands);

  if (result.action === 'execute') {
    await dispatch(result.command, args.slice(1));
    process.exit(0);
  } else if (result.action === 'none') {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
  } else {
    // 'skip' — fuzzy match already printed a message
    process.exit(1);
  }
}
