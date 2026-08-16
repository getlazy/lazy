#!/usr/bin/env bun

import { init, findLazyRoot, findGitRoot } from './cli/init';
import { isTTY, promptYesNo } from './cli/editor';
import {
  commandCreate, createUsage,
  commandEdit, editUsage,
  commandBranch, branchUsage,
  commandClone, cloneUsage,
  commandStart, startUsage,
  commandStats, statsUsage, statsSubcommandUsage,
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
  commandApprove, approveUsage,
  commandProtect, protectUsage,
  commandClose, closeUsage,
  commandReject, rejectUsage,
  commandStop, stopUsage,
  commandSearch, searchUsage,
  commandComment, commentUsage,
  commandAsk, askUsage,
  commandTag, tagUsage, commandUntag, untagUsage,
  commandJournal, journalUsage,
  commandMemory, memoryUsage, memorySubcommandUsage,
  commandLink, linkUsage,
  commandImportConversation, importConversationUsage,
  commandReopen, reopenUsage,
  commandResume, resumeUsage,
  commandWait, waitUsage,
  commandBuilder, builderUsage,
  commandDoctor, doctorUsage,
  commandLoop, loopUsage,
  commandRevert, revertUsage,
  commandSubmit, submitUsage,
  commandSync, syncUsage,
  commandReparent, reparentUsage,
  commandPrioritize, prioritizeUsage,
  commandCompletion, completionUsage,
  commandReview, reviewUsage,
  commandRedo, redoUsage,
  commandUpgrade, upgradeUsage,
  commandSystem, systemUsage, systemSubcommandUsage,
  commandDocument, documentUsage,
  commandRefactor, refactorUsage,
  commandFix, fixUsage,
  commandRework, reworkUsage,
  commandDaemon, daemonUsage, daemonSubcommandUsage,
  commandWatch, watchUsage,
  commandConfig, configUsage,
  commandReport, reportUsage,
} from './cli/commands';
import { handleFuzzyCommand } from './cli/fuzzy-command';
import { COMMAND_ALIASES, ALIAS_NAMES } from './cli/command-aliases';
import { isLoggedToFile } from './utils/logged-error';
import { docsFooter } from './docs/links';


import { VERSION } from './version';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`lazy v${VERSION}

Usage: lazy <command> [options]

Task Management:
  create                 Create a task without starting it
  start                  Create and start a new task (or start existing)
  fix                    Create a debugging/fix task (experimental methodology)
  document               Create a documentation task (design docs, not code)
  refactor               Create a refactoring task (restructure, no behavior change)
  edit <task_id>         Edit a task's goal or prompt
  comment <task_id>      Add a comment/annotation to a task
  journal <task_id>      Append a journal entry (rationale; never sent to agents)
  tag <task_id> <tag>    Add a tag to a task (grouping label)
  untag <task_id> <tag>  Remove a tag from a task
  clone <task_id>        Duplicate task with optional reparenting
  prioritize <task> <lvl> Set queue priority (low/normal/high/urgent)
  list / tasks           List all non-terminal tasks
  active                 List active tasks (with sessions)
  blocked                List blocked tasks (waiting for user)
  show <task_id>         Show task details
  search <query>         Search tasks, prompts, turns, commits, comments, memory
  report                 LLM-summarized markdown digest of recent activity
  memory                 Shared, curated cross-task knowledge (list/show/save/rm/
                         history/compact)

Working on Tasks:
  review <task_id>       TUI review: full-screen artifact browser
  ask <task_id>          Ask a paused task's agent a question (read-only)
  loop [<task_id>...]    Review all blocked tasks sequentially, or drive a
                         curated queue: start, wait, review gate, decide, next
  unblock <task_id>      Unblock task: interactive review or feedback
  resume <task_id>       Resume an interrupted task
  reopen <task_id>       Reopen a rejected task
  branch <task_id>       Create a variant task (fork)
  stop <task_id>         Halt a working task without auto-resume
  wait [<task_id>...]    Wait for task(s) to complete (--follow, --next)
  watch [<task-code>]    Watch a task working (live supervisor + agent timeline)
  reparent <task> <new>  Repoint a task at a new parent and sync it

System:
  system prompts         List built-in system prompt templates
  system build <name>    Prebuild a lazy system image (e.g., lazy-runner)
  system status          Show current system state (offline/online, driver, daemon)
  system offline         Enable offline mode (skip all remote operations)
  system online          Disable offline mode (restore remote operations)
  system export-dockerfile  Write the embedded default Dockerfile to disk

Stats:
  stats tokens           Token accounting from the proxy audit trail (by role/task/model)
  stats audit            Browse the proxy audit trail record by record (denials, reroutes)
  stats timings          Recorded request traces, ranked by self time

Inspect:
  diff <task_id>         Show changes made by task
  status <task_id>       Show worktree and commit state
  shell <task_id>        Open shell in task's worktree
  pair <task_id>         Pair program with Claude in task's worktree
  chat <task_id>         Read-only chat with a finished task's agent session
  accept <task_id>       Merge task's work
  approve <task_id>      Record a human approval for accepting into a protected branch
  protect <branch|task>  Protect a branch or task ('on'/'off'; no args shows state)
  close <task_id>        Close a task (no session required)
  reject <task_id>       Reject a task's work and close its PR
  revert <task_id>       Undo an accepted task (create revert task)
  rework <task_id>       Create follow-up task for accepted work that needs changes
  redo <task_id>         Abandon stale task and restart fresh on current main
  submit <task_id>       Submit a task for human review (opens a PR)

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
  daemon list            List ALL running lazy daemons on this host (marks strays)
  daemon kill-stray      Reap daemons whose project root no longer exists
  daemon logs            Tail daemon log file (primary debugging tool)
  daemon auto-budget     Control/inspect the auto-react daily budget (list/update/pause/resume)
  daemon config          Inspect/override concurrency caps at runtime (get/set/reset)
  server                 Start daemon and show web dashboard URL
  config set/get         Runtime config toggles (e.g., auto_react on/off)

Builder:
  builder                Launch Claude Code with Lazy builder prompt

Setup:
  init                   Initialize lazy in a git repository
  doctor                 Check installation health
  upgrade                Rebuild image/binary and restart containers
  completion             Output shell completion script (--bash or --zsh)

Run 'lazy <command> --help' for more information on a command.${docsFooter()}`);
}

// Command dispatch table: maps command names to their handler and usage functions.
const commandMap: Record<string, {
  run: (args: string[], invokedAs: string) => Promise<void>;
  usage: () => void;
  // Multiplexer commands (system, daemon, ...) map each subcommand name to that
  // subcommand's own usage function. dispatch() consults this so
  // `lazy <cmd> <sub> --help` shows the subcommand's help, not the parent's.
  subcommands?: Record<string, () => void>;
}> = {
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
  'tag':      { run: commandTag, usage: tagUsage },
  'untag':    { run: commandUntag, usage: untagUsage },
  'journal':  { run: commandJournal, usage: journalUsage },
  'memory':   { run: commandMemory, usage: memoryUsage, subcommands: memorySubcommandUsage },
  'start':    { run: commandStart, usage: startUsage },
  'unblock':  { run: commandUnblock, usage: unblockUsage },
  'resume':   { run: commandResume, usage: resumeUsage },
  'reopen':   { run: commandReopen, usage: reopenUsage },
  'branch':   { run: commandBranch, usage: branchUsage },
  'diff':     { run: commandDiff, usage: diffUsage },
  'status':   { run: commandStatus, usage: statusUsage },
  'shell':    { run: commandShell, usage: shellUsage },
  'pair':     { run: commandPair, usage: pairUsage },
  'chat':     { run: commandChat, usage: chatUsage },
  'accept':   { run: commandAccept, usage: acceptUsage },
  'approve':  { run: commandApprove, usage: approveUsage },
  'protect':  { run: commandProtect, usage: protectUsage },
  'close':    { run: commandClose, usage: closeUsage },
  'reject':   { run: commandReject, usage: rejectUsage },
  'stop':     { run: commandStop, usage: stopUsage },
  'revert':   { run: commandRevert, usage: revertUsage },
  'wait':     { run: commandWait, usage: waitUsage },
  'builder':  { run: commandBuilder, usage: builderUsage },
  'doctor':   { run: commandDoctor, usage: doctorUsage },
  'loop':     { run: commandLoop, usage: loopUsage },
  'submit':   { run: commandSubmit, usage: submitUsage },
  'sync':     { run: commandSync, usage: syncUsage },
  'reparent': { run: commandReparent, usage: reparentUsage },
  'prioritize': { run: commandPrioritize, usage: prioritizeUsage },
  'completion': { run: commandCompletion, usage: completionUsage },
  'review':   { run: commandReview, usage: reviewUsage },
  'ask':      { run: commandAsk, usage: askUsage },
  'redo':     { run: commandRedo, usage: redoUsage },
  'upgrade':  { run: commandUpgrade, usage: upgradeUsage },
  'stats':    { run: commandStats, usage: statsUsage, subcommands: statsSubcommandUsage },
  'system':   { run: commandSystem, usage: systemUsage, subcommands: systemSubcommandUsage },
  'document': { run: commandDocument, usage: documentUsage },
  'refactor': { run: commandRefactor, usage: refactorUsage },
  'fix':      { run: commandFix, usage: fixUsage },
  'rework':   { run: commandRework, usage: reworkUsage },
  'daemon':   { run: commandDaemon, usage: daemonUsage, subcommands: daemonSubcommandUsage },
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
    // For multiplexer commands the subcommand always sits at cmdArgs[0] (that's
    // where the command's own switch reads it), so `lazy daemon logs -h` routes
    // to logsUsage while a bare `lazy daemon -h` still prints the parent usage.
    const subUsage = entry.subcommands?.[cmdArgs[0]];
    (subUsage ?? entry.usage)();
  } else {
    // Pass the name the command was invoked as (canonical or alias) so a handler
    // can vary its default behavior per alias — e.g. `lazy view` defaults to the
    // chunked turn grouping while the canonical `lazy show` stays flat.
    await entry.run(cmdArgs, cmd);
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
    // Read-only turns (ask) get a toolset with the write tools withheld. The
    // supervisor writes this flag into ~/.claude.json per turn — see
    // src/supervisor/mcp-setup.ts.
    const readOnly = cmdArgs.includes('--read-only');

    const { startMcpServer } = await import('./mcp/index');
    await startMcpServer({ taskId, worktreePath }, { readOnly });
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

// LAZY_FORCE_PREFLIGHT is a test-only escape hatch: preflight is skipped under
// LAZY_TEST because test temp dirs are always accessible, but the preflight
// suite deliberately makes them inaccessible and must still exercise the check.
const preflightSkipped = process.env.LAZY_TEST === '1' && process.env.LAZY_FORCE_PREFLIGHT !== '1';

if (!isHelpOrVersion && command !== 'completion' && !preflightSkipped) {
  const { runPreflight } = await import('./cli/preflight');
  await runPreflight(resolveLazyRoot());
  const { validateConfigPaths } = await import('./cli/config-path-validation');
  await validateConfigPaths(resolveLazyRoot());
}

// Documentation pointers ("Check documentation at <url>") honour the project's
// [docs] url. Commands that load a full config get the validated value from
// loadConfig(); help, --version and the early daemon auto-start failure below
// never load one, so install a best-effort value here — before anything that can
// print a pointer, and after preflight, which owns the "can't even read this
// directory" diagnosis. Best-effort on purpose: `lazy --help` must not die of a
// broken lazy.toml, and neither must the message explaining that it is broken.
{
  const docsRoot = resolveLazyRoot();
  if (docsRoot) {
    try {
      const { loadRawConfig } = await import('./config/loader');
      const { normalizeDocsUrl, setDocsBaseUrl } = await import('./docs/links');
      const raw = await loadRawConfig(docsRoot);
      setDocsBaseUrl(normalizeDocsUrl((raw?.docs as { url?: unknown } | undefined)?.url));
    } catch {
      // Unreadable lazy.toml, or a [docs] url that fails validation: keep the
      // default docs domain rather than turn a help request into an error.
      // loadConfig() surfaces the same problem loudly on any command that
      // actually needs the config, and `lazy doctor` reports it as a check.
    }
  }
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
      const message = err instanceof Error ? err.message : String(err);
      // INVARIANT: `lazy doctor` never dies of the problem it exists to
      // diagnose. Every reason auto-start can fail is already a doctor check —
      // an unloadable lazy.toml ('lazy.toml parses'), a missing model
      // credential (checkAuth), a runner that isn't there (runner.diagnose) —
      // and exiting here makes all of them unreachable, so the user's one
      // diagnostic surface goes dark exactly when they need it. Report the
      // failure and run degraded instead: doctor's checks work daemon-less
      // (they fall back to a direct FileStorage when there is no daemon).
      //
      // This removes the FIRST abort, not every one. On a broken config doctor
      // now completes, because it skips createRunner when the config did not
      // load. When the daemon is absent for some OTHER reason and `[proxy]` is
      // enabled, doctor still dies further in, at createRunner's proxy
      // fail-loud gate — a separate blocker on the same goal, recorded as a
      // follow-up rather than fixed here.
      if (command === 'doctor') {
        console.error('Warning: the daemon is not running and could not be auto-started.');
        console.error(`  ${message.split('\n').join('\n  ')}`);
        console.error('');
        console.error('Continuing without it — checks that need the daemon are skipped.');
        console.error('');
      } else {
        // Surface daemon startup failures (missing auth credential, web-port
        // conflict, etc.) as a clean, actionable message rather than an uncaught
        // top-level rejection with a stack trace. The daemon is the single
        // enforcement point for auth — clients pass through and let the daemon's
        // gate surface the problem instead of enforcing it themselves.
        const { docsSuffix } = await import('./docs/links');
        console.error(`Error: ${message}`);
        const pointer = docsSuffix('troubleshooting-daemon', '');
        if (pointer) console.error(pointer);
        process.exit(1);
      }
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
