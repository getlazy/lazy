#!/usr/bin/env bun

import { init } from './cli/init';
import { findLazyRoot, findGitRoot } from './project-paths';
import { isTTY, promptYesNo } from './cli/editor';
import { readTeamsLogin, MultipleTeamsLoginsError, type TeamsLogin } from './teams/login';
import {
  commandCreate, createUsage,
  commandEdit, editUsage,
  commandBranch, branchUsage,
  commandClone, cloneUsage,
  commandStart, startUsage,
  commandStats, statsUsage, statsSubcommandUsage,
  commandEnv, envUsage, envSubcommandUsage,
  commandCustomize, customizeUsage, customizeSubcommandUsage,
  commandUnblock, unblockUsage,
  commandList, listUsage,
  commandActive, activeUsage,
  commandBlocked, blockedUsage,
  commandShow, showUsage,
  commandStatus, statusUsage,
  commandDiff, diffUsage,
  commandRegions, regionsUsage,
  commandShell, shellUsage,
  commandDashboard, dashboardUsage,
  commandPlayground, playgroundUsage,
  commandUrl, urlUsage,
  commandForward, forwardUsage,
  commandPair, pairUsage,
  commandChat, chatUsage,
  commandAccept, acceptUsage,
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
  commandScratch, scratchUsage, scratchSubcommandUsage,
  commandArtifact, artifactUsage, artifactSubcommandUsage,
  commandMessages, messagesUsage, messagesSubcommandUsage,
  commandRaised, raisedUsage, raisedSubcommandUsage,
  commandConversations, conversationsUsage, conversationsSubcommandUsage,
  commandLink, linkUsage,
  commandDescribe, describeUsage,
  commandImportConversation, importConversationUsage,
  commandReopen, reopenUsage,
  commandResume, resumeUsage,
  commandWait, waitUsage,
  commandBuilder, builderUsage,
  commandDoctor, doctorUsage,
  commandAuth, authUsage,
  commandLogin, loginUsage,
  commandLogout, logoutUsage,
  commandLoop, loopUsage,
  commandRevert, revertUsage,
  commandSubmit, submitUsage,
  commandSync, syncUsage,
  commandReparent, reparentUsage,
  commandCompletion, completionUsage,
  commandReview, reviewUsage,
  commandBrowse, browseUsage,
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
import { COMMAND_ALIASES, ALIAS_NAMES, DEPRECATED_ALIAS_NOTES } from './cli/command-aliases';
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
  list / tasks           List all non-terminal tasks
  active                 List active tasks (with sessions)
  blocked                List blocked tasks (waiting for user)
  show <task_id>         Show task details
  search <query>         Search tasks, prompts, turns, commits, comments, memory
  report                 LLM-summarized markdown digest of recent activity
  memory                 Shared, curated cross-task knowledge (list/show/save/rm/
                         history/compact)
  messages               Inbox of proactive system-to-human reports (list/read/
                           dismiss); see also raised for agent-raised items
  raised                 Everything agents raised for you, across tasks — list,
                         respond, dismiss, promote, change what gates accept
  conversations          Browse captured builder conversations (list/search/show)
  artifact               Files attached to a task and published back by it
                         (list/add/get/rm)
  scratch                Builder scratch artifacts captured into the store
                         (list/show/sync/rm/path)

Working on Tasks:
  review <task_id>       Run an agent review of the task's work
  browse <task_id>       TUI browser: task artifacts (response, plan, diff)
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
  stats tools <task>     Per-tool breakdown for one task — which tool filled its context
  stats audit            Browse the proxy audit trail record by record (denials, reroutes)
  stats timings          Recorded request traces, ranked by self time
  stats limits           Latest usage-limit reading per credential (5h / 7d windows)

Task Environment:
  env set <task_id>      Give one task an env var (API token) — host-only, never persisted
  env list <task_id>     List a task's env var NAMES (never values)
  env unset <task_id>    Remove named env vars from a task
  env clear <task_id>    Remove every env var from a task

Customize:
  customize proxy-plugin <name>  Scaffold a model-API proxy request plugin in .lazy/plugins/

Inspect:
  diff <task_id>         Show changes made by task
  regions <task_id>      Show the review regions the task's walkthrough declared
  status <task_id>       Show worktree and commit state
  shell <task_id>        Open shell in task's container (--host for the worktree on this machine)
  url <task_id> [svc]    Show where the task's [serve] ports are reachable
  forward <task_id> <p>  Forward a port inside the task's container, on demand
  pair <task_id>         Pair program with Claude in task's worktree
  chat <task_id>         Read-only chat with a finished task's agent session
  accept <task_id>       Merge task's work
  protect <branch|task>  Protect a branch or task ('on'/'off'; no args shows state)
  close <task_id>        Close a task (no session required)
  reject <task_id>       Reject a task's work and close its PR
  revert <task_id>       Undo an accepted task (create revert task)
  rework <task_id>       Create follow-up task for accepted work that needs changes
  redo <task_id>         Abandon stale task and restart it on a fresh branch
  submit <task_id>       Submit a task for human review (opens a PR)

Link:
  link <ref>             Link a pull request or git branch as a task
  describe <task_id>     Rewrite a linked task's description from its branch/PR

Import:
  import-conversation    Import Claude Code conversation logs

Remote:
  sync                   Sync lazy tasks with your remote repository

Daemon:
  dashboard              Sign in to the web dashboard and open it in a browser
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
  playground <sub>       Throwaway project (up/down/status) with a real daemon and seeded tasks
  config set/get         Runtime config toggles (e.g., auto_react on/off)

Builder:
  builder                Launch Claude Code with Lazy builder prompt

Setup:
  init                   Initialize lazy in a git repository
  doctor                 Check installation health
  auth                   Store model-provider credentials in OS secure storage
  login                  Log this machine in to Lazy Teams and bind this clone
  logout                 Unbind this clone and delete the stored login
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
  'describe': { run: commandDescribe, usage: describeUsage },
  'import-conversation': { run: commandImportConversation, usage: importConversationUsage },
  'init':     {
    run: async (args: string[]) => {
      const skipAuthCheck = args.includes('--skip-auth-check');
      const skipRemoteCheck = args.includes('--skip-remote-check') || args.includes('--skip-github-check');
      const skipCompletionCheck = args.includes('--skip-completion-check');
      const nonInteractive = args.includes('--non-interactive');
      const externalPathIdx = args.indexOf('--external-path');
      let externalPath: string | undefined;
      if (externalPathIdx !== -1) {
        externalPath = args[externalPathIdx + 1];
        if (!externalPath || externalPath.startsWith('--')) {
          console.error('Error: --external-path requires a directory path.');
          process.exit(1);
        }
      }
      await init(process.cwd(), { skipAuthCheck, skipRemoteCheck, skipCompletionCheck, nonInteractive, externalPath });
    },
    usage: () => {
      console.log('Usage: lazy init [--external-path PATH] [--skip-auth-check] [--skip-remote-check] [--skip-completion-check]\n');
      console.log('Initialize lazy in the current git repository.\n');
      console.log('Requires an interactive terminal to display warnings and instructions.\n');
      console.log('If a supported remote (GitHub, etc.) is detected, offers to configure it.\n');
      console.log('Options:');
      console.log('  --external-path PATH      Put the external store here instead of ~/.lazy/<project-name>.');
      console.log('                            Answers the storage prompt, so it also works without a TTY,');
      console.log('                            and rewrites storage.external_path in an existing lazy.toml.');
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
  'scratch':  { run: commandScratch, usage: scratchUsage, subcommands: scratchSubcommandUsage },
  'artifact': { run: commandArtifact, usage: artifactUsage, subcommands: artifactSubcommandUsage },
  'messages': { run: commandMessages, usage: messagesUsage, subcommands: messagesSubcommandUsage },
  'raised':   { run: commandRaised, usage: raisedUsage, subcommands: raisedSubcommandUsage },
  'conversations': { run: commandConversations, usage: conversationsUsage, subcommands: conversationsSubcommandUsage },
  'start':    { run: commandStart, usage: startUsage },
  'unblock':  { run: commandUnblock, usage: unblockUsage },
  'resume':   { run: commandResume, usage: resumeUsage },
  'reopen':   { run: commandReopen, usage: reopenUsage },
  'branch':   { run: commandBranch, usage: branchUsage },
  'diff':     { run: commandDiff, usage: diffUsage },
  'regions':  { run: commandRegions, usage: regionsUsage },
  'status':   { run: commandStatus, usage: statusUsage },
  'shell':    { run: commandShell, usage: shellUsage },
  'dashboard': { run: commandDashboard, usage: dashboardUsage },
  // No `subcommands` map: `up`/`down`/`status` share one usage text, so -h on
  // any of them should print it. A map entry exists only where a subcommand
  // ships its own `<name>Usage()`.
  'playground': { run: commandPlayground, usage: playgroundUsage },
  'url':      { run: commandUrl, usage: urlUsage },
  'forward':  { run: commandForward, usage: forwardUsage },
  'pair':     { run: commandPair, usage: pairUsage },
  'chat':     { run: commandChat, usage: chatUsage },
  'accept':   { run: commandAccept, usage: acceptUsage },
  'protect':  { run: commandProtect, usage: protectUsage },
  'close':    { run: commandClose, usage: closeUsage },
  'reject':   { run: commandReject, usage: rejectUsage },
  'stop':     { run: commandStop, usage: stopUsage },
  'revert':   { run: commandRevert, usage: revertUsage },
  'wait':     { run: commandWait, usage: waitUsage },
  'builder':  { run: commandBuilder, usage: builderUsage },
  'doctor':   { run: commandDoctor, usage: doctorUsage },
  'auth':     { run: commandAuth, usage: authUsage },
  'login':    { run: commandLogin, usage: loginUsage },
  'logout':   { run: commandLogout, usage: logoutUsage },
  'loop':     { run: commandLoop, usage: loopUsage },
  'submit':   { run: commandSubmit, usage: submitUsage },
  'sync':     { run: commandSync, usage: syncUsage },
  'reparent': { run: commandReparent, usage: reparentUsage },
  'completion': { run: commandCompletion, usage: completionUsage },
  'review':   { run: commandReview, usage: reviewUsage },
  'browse':   { run: commandBrowse, usage: browseUsage },
  'ask':      { run: commandAsk, usage: askUsage },
  'redo':     { run: commandRedo, usage: redoUsage },
  'upgrade':  { run: commandUpgrade, usage: upgradeUsage },
  'stats':    { run: commandStats, usage: statsUsage, subcommands: statsSubcommandUsage },
  'env':      { run: commandEnv, usage: envUsage, subcommands: envSubcommandUsage },
  'customize': { run: commandCustomize, usage: customizeUsage, subcommands: customizeSubcommandUsage },
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

  // An old spelling still works; the human just hears about it once, on stderr.
  const deprecation = DEPRECATED_ALIAS_NOTES[cmd];
  if (deprecation) console.error(deprecation);

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
    // Ask turns get --read-only; review turns get --review (reads + lazy_raise).
    // The supervisor writes the flag into ~/.claude.json per turn — see
    // src/supervisor/mcp-setup.ts.
    const readOnly = cmdArgs.includes('--read-only');
    const review = cmdArgs.includes('--review');

    // Fail closed if ~/.claude.json named a different task than the turn this
    // server was spawned in — see src/mcp/turn-identity.ts.
    const { assertMcpServesExpectedTurn } = await import('./mcp/turn-identity');
    try {
      assertMcpServesExpectedTurn({ taskId, worktreePath });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Same net the containerized entry installs — this process is the agent's
    // only channel to lazy state, and Claude Code never respawns it.
    // See src/mcp/process-guards.ts.
    const { installMcpKeepAlive, reportMcpStartupFailure } = await import('./mcp/process-guards');
    installMcpKeepAlive();

    try {
      const { startMcpServer } = await import('./mcp/index');
      await startMcpServer({ taskId, worktreePath, boundToTeams: await mcpServesBoundClone() }, { readOnly, review });
    } catch (err) {
      reportMcpStartupFailure(err);
    }
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
// `playground` (and its old spelling `demo`) is here for the same reason as `init`: it provisions a lazy project of
// its OWN, somewhere else entirely, and has no use for whichever project the
// caller happens to be standing in. Offering to init that one would be
// answering a question nobody asked.
// login/logout bind or unbind a clone; neither needs, nor may create, a local project.
const skipAutoInit = ['init', 'completion', 'playground', 'demo', 'login', 'logout'];
const isHelpOrVersion = !command || command === '--help' || command === '-h' || command === '--version' || command === '-V';

// Filesystem preflight: fail fast with a clear error when the terminal lacks
// permission to read/write the directories lazy needs (macOS TCC, Unix perms,
// read-only mounts). Must run before findLazyRoot() is trusted — findLazyRoot
// uses existsSync which returns false on EACCES, so a permission problem
// would otherwise surface as "not in a lazy project" instead of the real
// cause. Skipped for help/version/completion and in test mode.
let cachedLazyRoot: string | null = null;
let cachedLazyRootComputed = false;
function lazyRootOrNull(): string | null {
  if (!cachedLazyRootComputed) {
    cachedLazyRoot = findLazyRoot();
    cachedLazyRootComputed = true;
  }
  return cachedLazyRoot;
}

/**
 * Whether this clone is bound to a Teams project — the one thing the daemon
 * auto-start preflight below needs to know before deciding whether to touch
 * the LOCAL machine at all, and the one place that decides for the WHOLE
 * dispatcher (see the announcement right below this preflight): every
 * remote-routed command reaches the daemon through wildly different code —
 * `requireStorage()`'s full `Storage` interface, or `src/daemon/rpc-fallback.ts`'s
 * typed wrappers straight over `tryRpc`, depending on the command — and a
 * banner planted in only one of those paths reaches only the commands that
 * happen to take it. Printed ONCE, here, it reaches all of them the same way
 * `ensureDaemon` being skipped does.
 *
 * `readTeamsLogin` THROWS a {@link MultipleTeamsLoginsError}, rather than
 * returning null, when the credential store holds more than one login — a
 * broken state whose only recovery is `lazy logout` (`clearTeamsLogin`
 * enumerates the index directly rather than going through `readTeamsLogin`,
 * precisely so that recovery command still works). This preflight must not
 * reintroduce that trap one level up: letting the exception propagate here
 * would crash EVERY command, including the one that fixes it. So THAT
 * specific error is answered `'ambiguous'` — not because the clone is
 * cleanly bound (there is no one login to print a banner for), but because
 * starting a local daemon for it is exactly as wrong as it would be for an
 * ordinary bound clone, and the actual command (a normal one hits the same
 * loud refusal from `resolveStorage`; `login`/`logout` recover it) is what
 * should decide what happens next, not this preflight.
 *
 * Any OTHER error (a corrupted credential index, which breaks every
 * credential it holds and answers nothing about Teams binding specifically)
 * is answered `null` — proceed as an ordinary local project — rather than
 * swallowed into the same "bound" bucket: `lazy doctor`'s own diagnosis of
 * that exact corruption must still run, which skipping its daemon auto-start
 * on a guess would get in the way of.
 */
/**
 * The Teams install and project a hand-run `lazy mcp` serves, when its clone
 * is bound — read from the same root `resolveStorage()` resolves, so the tools
 * and their storage agree on where the project is. An AMBIGUOUS binding
 * answers undefined: every storage call refuses it loudly (naming `lazy
 * logout` as the recovery), so there is no single install to name here.
 */
async function mcpServesBoundClone(): Promise<{ url: string; project: string } | undefined> {
  const { findLazyRoot } = await import('./project-paths');
  const root = findLazyRoot();
  if (!root) return undefined;
  const login = await resolveCloneBinding(root);
  if (!login || login === 'ambiguous') return undefined;
  return { url: login.binding.teams_url, project: login.binding.project };
}

async function resolveCloneBinding(root: string): Promise<TeamsLogin | 'ambiguous' | null> {
  try {
    return await readTeamsLogin(root);
  } catch (err) {
    return err instanceof MultipleTeamsLoginsError ? 'ambiguous' : null;
  }
}

// LAZY_FORCE_PREFLIGHT is a test-only escape hatch: preflight is skipped under
// LAZY_TEST because test temp dirs are always accessible, but the preflight
// suite deliberately makes them inaccessible and must still exercise the check.
const preflightSkipped = process.env.LAZY_TEST === '1' && process.env.LAZY_FORCE_PREFLIGHT !== '1';

// `lazy init --external-path` is the one command that REPLACES
// storage.external_path, so validating the value already in lazy.toml would
// reject the config for the exact staleness this invocation is there to fix —
// a provisioning run against a repo whose committed config points at its
// authors' home directory dies before it can rewrite it. The new value is
// still validated: init creates and opens the store at it.
const rewritesStoragePath = command === 'init' && args.includes('--external-path');

// `lazy system source-id` is a pure function of a SOURCE TREE: it hashes files
// and prints, touching no lazy state, needing no project and writing nothing.
// Preflight probes whichever `.lazy` happens to be above the cwd, so without
// this the command fails on a checkout it has no business caring about — a
// read-only mount, somebody else's project, a worktree whose store is not
// writable from here. Lazy Teams asks this question with its cwd inside the
// checkout on every fleet tick, so the failure is not hypothetical.
//
// `lazy system store-check <path>` joins it for the same reason and with the
// same caller: it reads a store directory named on the command line — usually
// one belonging to ANOTHER install, possibly still running — and writes
// nothing. Probing the surrounding project's `.lazy` would refuse the fleet's
// adoption preflight on exactly the machines it has to run on.
const isProjectFreeSystemQuery =
  command === 'system' && (args[1] === 'source-id' || args[1] === 'store-check');

// `lazy playground` (alias `demo`) is exempt for the same reason, and the failure is not
// hypothetical either: the command exists to be run by an agent inside its own
// container, where the lazy checkout is mounted READ-ONLY on purpose. It writes
// nothing to the surrounding project — it builds a throwaway project of its own
// under a separate root — so probing that project's `.lazy` for writability
// refuses the one invocation the command was designed for. Its own root is
// checked where it is actually used, by `lazy playground` itself.
const isPlaygroundCommand = command === 'playground' || command === 'demo';

if (!isHelpOrVersion && command !== 'completion' && !isProjectFreeSystemQuery && !isPlaygroundCommand && !preflightSkipped) {
  const { runPreflight } = await import('./cli/preflight');
  await runPreflight(lazyRootOrNull());
  // login/logout, and every command in a bound clone, never touch the local
  // store: after a handover to Lazy Teams the operator moves that store away
  // BEFORE binding, so validating `storage.external_path` would refuse the
  // very commands the handover runbook tells them to run next.
  const skipsLocalStore =
    command === 'login' ||
    command === 'logout' ||
    await (async () => {
      const root = lazyRootOrNull();
      if (!root) return false;
      const binding = await resolveCloneBinding(root);
      return binding !== null && binding !== 'ambiguous';
    })();
  if (!rewritesStoragePath && !skipsLocalStore) {
    const { validateConfigPaths } = await import('./cli/config-path-validation');
    await validateConfigPaths(lazyRootOrNull());
  }
}

// Documentation pointers ("Check documentation at <url>") honour the project's
// [docs] url. Commands that load a full config get the validated value from
// loadConfig(); help, --version and the early daemon auto-start failure below
// never load one, so install a best-effort value here — before anything that can
// print a pointer, and after preflight, which owns the "can't even read this
// directory" diagnosis. Best-effort on purpose: `lazy --help` must not die of a
// broken lazy.toml, and neither must the message explaining that it is broken.
{
  const docsRoot = lazyRootOrNull();
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
  const lazyRoot = lazyRootOrNull();
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
//
// And for the project-free `system` queries (`source-id`, `store-check`), for
// the same reason preflight skips them: reading a source tree or a named store
// directory needs no daemon, and starting one would run the credential gate —
// so asking "which lazy is this?" on a machine with no Anthropic credential
// would fail with a message about the model API. Lazy Teams asks exactly those
// questions, from a checkout, on every fleet tick and before every adoption.
if (!isHelpOrVersion && !isProjectFreeSystemQuery) {
  const { ensureDaemon } = await import('./daemon/auto-start');
  // Reuse the cached lazy root if we found one earlier; otherwise re-probe —
  // auto-init may have just created .lazy/ and the cached null is now stale.
  const root = cachedLazyRoot ?? findLazyRoot();
  // A bound clone has no local daemon to start (design doc §4.4) — its
  // project lives on Teams. Without this, EVERY command in a bound clone hit
  // this unconditionally: `ensureDaemon` finds nothing running and tries to
  // start one, which either fails loudly on a laptop with no local Anthropic
  // credential (turns run on Teams, not here) or silently leaves a real local
  // daemon running for a project that is supposed to have none.
  const binding = root ? await resolveCloneBinding(root) : null;
  // Every remote-routed command names the install and project as its first
  // line (design doc §4.7) — printed HERE, once, rather than in
  // `requireStorage()`, because that only reaches commands going through the
  // full `Storage` interface. Several read commands (`list`, `blocked`,
  // `active`, …) call `src/daemon/rpc-fallback.ts`'s typed wrappers straight
  // over `tryRpc` instead and never touched that banner at all. `'ambiguous'`
  // prints nothing — there is no one login to name, and the command is about
  // to get the daemon's own loud refusal instead.
  if (binding && binding !== 'ambiguous') {
    console.error(`${binding.binding.teams_url} — ${binding.binding.project}`);
  }
  if (root && !binding) {
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
      // load. When the daemon is absent for some OTHER reason, doctor
      // still dies further in, at createRunner's proxy
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

/**
 * End the process after a command returned normally, honouring the exit code it
 * asked for.
 *
 * `process.exit(0)` here used to discard `process.exitCode` outright, so a
 * command that failed without throwing exited 0 — a silent false success for
 * every `&&` chain and CI step. A command that wants to fail LOUDLY but still
 * run its own teardown (closing storage, releasing the store lock) has no other
 * way to say so: `process.exit(1)` from inside a `finally`-guarded callback
 * skips exactly the cleanup that must happen. Throwing is still the right choice
 * for an abort; this is for "finished, but the outcome was a failure".
 */
function exitAfterDispatch(): never {
  process.exit(process.exitCode ?? 0);
}

try {
  if (!command || command === '--help' || command === '-h') {
    // Help
    usage();
  } else if (command === '--version' || command === '-V') {
    const { formatVersionWithEmbeddedProvenance } = await import('./utils/build-provenance');
    console.log(await formatVersionWithEmbeddedProvenance(VERSION));
  } else if (legacyCommands[command]) {
    // Legacy commands
    console.error(legacyCommands[command]);
    process.exit(1);
  } else if (commandMap[command]) {
    // Known command — dispatch it
    await dispatch(command, args.slice(1));
    exitAfterDispatch();
  } else {
    // Unknown command — try fuzzy matching
    const result = await handleFuzzyCommand(command, args, fuzzyMatchCommands);

    if (result.action === 'execute') {
      await dispatch(result.command, args.slice(1));
      exitAfterDispatch();
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
