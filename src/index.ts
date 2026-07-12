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
  commandChat, chatUsage,
  commandAccept, acceptUsage,
  commandClose, closeUsage,
  commandReject, rejectUsage,
  commandStop, stopUsage,
  commandSearch, searchUsage,
  commandComment, commentUsage,
  commandJournal, journalUsage,
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
  commandSubmit, submitUsage,
  commandSync, syncUsage,
  commandReparent, reparentUsage,
  commandCompletion, completionUsage,
  commandReview, reviewUsage,
  commandRedo, redoUsage,
  commandUpgrade, upgradeUsage,
  commandSystem, systemUsage,
  commandDocument, documentUsage,
  commandRefactor, refactorUsage,
  commandFix, fixUsage,
  commandRework, reworkUsage,
  commandDaemon, daemonUsage,
  commandWatch, watchUsage,
  commandConfig, configUsage,
  commandReport, reportUsage,
} from './cli/commands';
import { handleFuzzyCommand } from './cli/fuzzy-command';
import { COMMAND_ALIASES, ALIAS_NAMES } from './cli/command-aliases';
import { isLoggedToFile } from './utils/logged-error';


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
  report                 LLM-summarized markdown digest of recent activity

Working on Tasks:
  review <task_id>       TUI review: full-screen artifact browser
  loop                   Review all blocked tasks sequentially
  unblock <task_id>      Unblock task: interactive review or feedback
  resume <task_id>       Resume an interrupted task
  reopen <task_id>       Reopen a rejected task
  branch <task_id>       Create a variant task (fork)
  wait [<task_id>...]    Wait for task(s) to complete (--follow, --next)
  watch [<task-code>]    Watch an agent working (read-only tmux view)

System:
  system prompts         List built-in system prompt templates
  system build <name>    Prebuild a lazy system image (e.g., lazy-runner)
  system status          Show current system state (offline/online, driver, daemon)
  system offline         Enable offline mode (skip all remote operations)
  system online          Disable offline mode (restore remote operations)

Inspect:
  diff <task_id>         Show changes made by task
  status <task_id>       Show worktree and commit state
  shell <task_id>        Open shell in task's worktree
  pair <task_id>         Pair program with Claude in task's worktree
  chat <task_id>         Read-only chat with a finished task's agent session
  accept <task_id>       Merge task's work
  close <task_id>        Close a task (no session required)
  reject <task_id>       Reject a task's work and close its PR
  revert <task_id>       Undo an accepted task (create revert task)
  rework <task_id>       Create follow-up task for accepted work that needs changes
  redo <task_id>         Abandon stale task and restart fresh on current main

Proposals:
  propose                Propose a follow-up task

Link:
  link <url>             Link an external resource (e.g., GitHub PR) as a task

Import:
  import-conversation    Import Claude Code conversation logs

Remote:
  sync                   Sync lazy tasks with your remote repository

Daemon:
  daemon start           Start the lazy daemon (includes web dashboard)
  daemon stop            Stop the daemon gracefully
  daemon restart         Restart the daemon
  daemon status          Show daemon status and web URL
  daemon logs            Tail daemon log file (primary debugging tool)
  daemon auto-budget     Control/inspect the auto-react daily budget (list/update/pause/resume)
  server                 Start daemon and show web dashboard URL
  config set/get         Runtime config toggles (e.g., auto_react on/off)

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
      await init(process.cwd(), { skipAuthCheck, skipRemoteCheck, skipCompletionCheck, nonInteractive });
    },
    usage: () => {
      console.log('Usage: lazy init [--skip-auth-check] [--skip-remote-check] [--skip-completion-check]\n');
      console.log('Initialize lazy in the current git repository.\n');
      console.log('Requires an interactive terminal to display warnings and instructions.\n');
      console.log('If a supported remote (GitHub, etc.) is detected, offers to configure it.\n');
      console.log('Options:');
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
  'active':   { run: commandActive, usage: activeUsage },
  'blocked':  { run: commandBlocked, usage: blockedUsage },
  'show':     { run: commandShow, usage: showUsage },
  'search':   { run: commandSearch, usage: searchUsage },
  'comment':  { run: commandComment, usage: commentUsage },
  'journal':  { run: commandJournal, usage: journalUsage },
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
  'chat':     { run: commandChat, usage: chatUsage },
  'accept':   { run: commandAccept, usage: acceptUsage },
  'close':    { run: commandClose, usage: closeUsage },
  'reject':   { run: commandReject, usage: rejectUsage },
  'stop':     { run: commandStop, usage: stopUsage },
  'revert':   { run: commandRevert, usage: revertUsage },
  'wait':     { run: commandWait, usage: waitUsage },
  'builder':  { run: commandBuilder, usage: builderUsage },
  'doctor':   { run: commandDoctor, usage: doctorUsage },
  'loop':     { run: commandLoop, usage: loopUsage },
  'propose':  { run: commandPropose, usage: proposeUsage },
  'submit':   { run: commandSubmit, usage: submitUsage },
  'sync':     { run: commandSync, usage: syncUsage },
  'reparent': { run: commandReparent, usage: reparentUsage },
  'completion': { run: commandCompletion, usage: completionUsage },
  'review':   { run: commandReview, usage: reviewUsage },
  'redo':     { run: commandRedo, usage: redoUsage },
  'upgrade':  { run: commandUpgrade, usage: upgradeUsage },
  'system':   { run: commandSystem, usage: systemUsage },
  'document': { run: commandDocument, usage: documentUsage },
  'refactor': { run: commandRefactor, usage: refactorUsage },
  'fix':      { run: commandFix, usage: fixUsage },
  'rework':   { run: commandRework, usage: reworkUsage },
  'daemon':   { run: commandDaemon, usage: daemonUsage },
  'watch':    { run: commandWatch, usage: watchUsage },
  'config':   { run: commandConfig, usage: configUsage },
  'report':   { run: commandReport, usage: reportUsage },
};

// Register alias entries, each pointing at its canonical command's handler.
// Sourced from COMMAND_ALIASES so the dispatcher and shell completion never
// drift — adding an alias there wires it up in both places.
for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
  const entry = commandMap[canonical];
  if (!entry) {
    throw new Error(`command-aliases references unknown canonical command: ${canonical}`);
  }
  for (const alias of aliases) {
    commandMap[alias] = entry;
  }
}

// All valid command names for fuzzy matching (excludes aliases like ls/tasks/view
// to avoid confusing suggestions — we match against canonical names only)
const fuzzyMatchCommands = Object.keys(commandMap).filter(c => !ALIAS_NAMES.includes(c));


async function dispatch(cmd: string, cmdArgs: string[]): Promise<void> {
  const entry = commandMap[cmd];
  if (!entry) return;

  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    entry.usage();
  } else {
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
  'session': 'Error: `lazy session` has been removed. Use: lazy start, lazy unblock, lazy accept, lazy close, lazy reject',
  'abandon': 'Error: `lazy abandon` has been removed. Use `lazy close` (no session required) or `lazy reject` (closes PR with reject review).',
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

// Filesystem preflight: fail fast with a clear error when the terminal lacks
// permission to read/write the directories lazy needs (macOS TCC, Unix perms,
// read-only mounts). Must run before findLazyRoot() is trusted — findLazyRoot
// uses existsSync which returns false on EACCES, so a permission problem
// would otherwise surface as "not in a lazy project" instead of the real
// cause. Skipped for help/version/completion and in test mode.
let cachedLazyRoot: string | null = null;
let cachedLazyRootComputed = false;
function resolveLazyRoot(): string | null {
  if (!cachedLazyRootComputed) {
    cachedLazyRoot = findLazyRoot();
    cachedLazyRootComputed = true;
  }
  return cachedLazyRoot;
}

if (!isHelpOrVersion && command !== 'completion' && process.env.LAZY_TEST !== '1') {
  const { runPreflight } = await import('./cli/preflight');
  await runPreflight(resolveLazyRoot());
  const { validateConfigPaths } = await import('./cli/config-path-validation');
  await validateConfigPaths(resolveLazyRoot());
}

if (!isHelpOrVersion && (!command || !skipAutoInit.includes(command))) {
  const lazyRoot = resolveLazyRoot();
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

// Auto-start daemon if not running. In v0.11+, daemon is required —
// ensureDaemon() throws if it can't start. Skips for daemon, init, completion, help.
if (!isHelpOrVersion) {
  const { ensureDaemon } = await import('./daemon/auto-start');
  // Reuse the cached lazy root if we found one earlier; otherwise re-probe —
  // auto-init may have just created .lazy/ and the cached null is now stale.
  const root = cachedLazyRoot ?? findLazyRoot();
  if (root) {
    try {
      await ensureDaemon(command, root);
    } catch (err) {
      // Surface daemon startup failures (missing auth credential, web-port
      // conflict, etc.) as a clean, actionable message rather than an uncaught
      // top-level rejection with a stack trace. The daemon is the single
      // enforcement point for auth — clients pass through and let the daemon's
      // gate surface the problem instead of enforcing it themselves.
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

// Test mode: no external daemon runs (tryRemoteStorage/tryRpc return null under
// LAZY_TEST), so the CLI process executes the daemon RPC handlers in-process via
// the rpc-fallback path. Those handlers use the daemon-storage singleton, which
// must be pointed at the project root once — exactly as the daemon server does
// at startup (src/daemon/server.ts). Without this, commands that reach a handler
// without first calling requireStorage() throw "Daemon storage not initialized".
if (process.env.LAZY_TEST === '1') {
  const root = cachedLazyRoot ?? findLazyRoot();
  if (root) {
    const { initDaemonStorage } = await import('./daemon/rpc-handlers');
    initDaemonStorage(root);
  }
}

try {
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
} catch (err) {
  // Catch config loading errors and other unhandled errors gracefully.
  //
  // In the detached daemon child (LAZY_DAEMON_BACKGROUND=1), stdout/stderr
  // are redirected to daemon.log via O_APPEND. A bare console.error here
  // would land an *untimestamped* duplicate of the same message the child
  // already wrote through the logger — that was the third copy users saw
  // in daemon.log after a bind failure. Two guards:
  //   1. Errors that have already been written to the log file at the
  //      throw site mark themselves with `loggedToFile` so we skip the
  //      duplicate write here.
  //   2. For un-logged errors in background mode, route through the
  //      logger so the message gets a timestamp and `[ERROR]` prefix
  //      instead of being dumped raw onto stderr → daemon.log.
  const message = err instanceof Error ? err.message : String(err);
  if (!isLoggedToFile(err)) {
    if (process.env.LAZY_DAEMON_BACKGROUND === '1') {
      const { logger } = await import('./utils/logger');
      logger.error(`Unhandled error: ${message}`);
    } else {
      console.error(`Error: ${message}`);
    }
  }
  process.exit(1);
}
