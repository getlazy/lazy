/**
 * `lazy completion` — output shell completion scripts.
 *
 * Usage:
 *   eval "$(lazy completion --zsh)"   # Add to .zshrc
 *   eval "$(lazy completion --bash)"  # Add to .bashrc
 */

import { resolve } from 'path';
import { parseFlags } from '../helpers';
import { COMMAND_ALIASES } from '../command-aliases';

// Expand a canonical-keyed command list so aliases of any included command are
// also completed (e.g. `show` brings in `view`). Aliases inherit the canonical
// command's behavior — same flags, same task-ID bucket, same subcommands.
function withAliases(commands: string[]): string[] {
  const expanded = [...commands];
  for (const cmd of commands) {
    for (const alias of COMMAND_ALIASES[cmd] ?? []) {
      expanded.push(alias);
    }
  }
  return expanded;
}

// Expand a canonical-keyed map so each alias inherits its canonical command's
// value (flags, subcommands, etc.).
function expandAliasKeys<T>(map: Record<string, T>): Record<string, T> {
  const expanded: Record<string, T> = { ...map };
  for (const [cmd, value] of Object.entries(map)) {
    for (const alias of COMMAND_ALIASES[cmd] ?? []) {
      expanded[alias] = value;
    }
  }
  return expanded;
}

/**
 * Get the absolute path to the lazy binary for embedding in completion scripts.
 * For compiled binaries, process.argv[0] IS the binary.
 * For dev mode (bun run src/index.ts), argv[0] is the bun runtime —
 * fall back to "lazy" and hope it's in PATH.
 */
function getLazyBinaryPath(): string {
  const argv0 = resolve(process.argv[0]);
  // Detect dev mode: argv[0] ends with /bun or /node
  if (argv0.endsWith('/bun') || argv0.endsWith('/node')) {
    return 'lazy';
  }
  return argv0;
}

// Commands whose first positional is a task reference and that operate on
// currently-active (working/blocked) tasks. Completed from `active --ids-only`.
const ACTIVE_TASK_ID_COMMANDS = withAliases([
  'active',
  'show', 'start', 'edit', 'comment', 'tag', 'untag', 'journal', 'clone', 'unblock', 'review', 'ask', 'resume',
  'branch', 'diff', 'status', 'shell', 'pair', 'accept', 'reject',
  'close', 'submit', 'sync', 'wait', 'watch', 'doctor', 'stop', 'reparent', 'approve',
]);

// Commands whose first positional is a task reference but that operate on
// terminal/finished tasks (accepted, rejected, closed, abandoned). `active`
// would return nothing useful for these, so they complete from
// `list --all --ids-only`, which includes terminal tasks.
const ALL_TASK_ID_COMMANDS = withAliases([
  'chat', 'reopen', 'revert', 'redo', 'rework', 'protect',
]);

// Commands that dispatch to a fixed set of subcommands as their first
// positional argument (e.g. `lazy system prompts`). Completed from this map.
const SUBCOMMANDS: Record<string, string[]> = expandAliasKeys({
  'system': ['prompts', 'build', 'status', 'offline', 'online', 'export-dockerfile'],
  'daemon': ['start', 'stop', 'restart', 'status', 'dashboard-url', 'list', 'kill-stray', 'logs', 'auto-budget', 'config'],
  'config': ['set', 'get'],
  'memory': ['list', 'show', 'save', 'rm', 'history', 'compact'],
  'stats': ['tokens', 'audit', 'timings'],
});

// All top-level commands. The literal is the canonical set (mirrors the
// dispatcher in src/index.ts); withAliases() appends aliases like ls/tasks/
// view/doc so they tab-complete too.
const ALL_COMMANDS = withAliases([
  'create', 'start', 'fix', 'document', 'refactor', 'edit', 'comment', 'tag', 'untag', 'journal', 'memory', 'clone',
  'list', 'active', 'blocked', 'show', 'search', 'report',
  'review', 'ask', 'loop', 'unblock', 'resume', 'reopen', 'branch', 'wait', 'watch',
  'diff', 'status', 'shell', 'pair', 'chat', 'accept', 'reject', 'revert', 'rework',
  'close', 'redo', 'stop', 'reparent', 'prioritize', 'approve', 'protect',
  'link', 'import-conversation', 'submit', 'sync', 'stats',
  'daemon', 'config',
  'builder', 'init', 'doctor', 'upgrade', 'completion', 'system',
]);

// Flags per command (only commands with flags are listed). Aliases inherit
// their canonical command's flags via expandAliasKeys.
const COMMAND_FLAGS: Record<string, string[]> = expandAliasKeys({
  'create':              ['--goal', '--prompt', '--model', '--type', '--priority', '--code', '--parent', '--agent', '--effort', '--runner', '--tag'],
  'start':               ['--model', '--agent', '--effort', '--runner', '--follow', '--yes', '--force-local'],
  'fix':                 ['--goal', '--prompt', '--model', '--code', '--parent'],
  'document':            ['--goal', '--prompt', '--model', '--code', '--parent'],
  'refactor':            ['--goal', '--prompt', '--model', '--code', '--parent'],
  'edit':                ['--goal', '--prompt', '--model', '--type', '--code', '--parent', '--runner'],
  'clone':               ['--parent', '--default-parent', '--code', '--model'],
  'list':                ['--all', '--flat', '--tree', '--ids-only', '--tag'],
  'active':              ['--flat', '--tree', '--follow', '--ids-only'],
  'blocked':             ['--flat', '--tree', '--tag'],
  'show':                ['--full', '--chunks', '--flat', '--lines', '--json'],
  'search':              ['--fuzzy', '--group', '--json', '--tasks', '--prompts', '--turns', '--commits', '--notes', '--followups', '--conversations', '--memories'],
  'comment':             ['--message'],
  'journal':             ['--message', '--add'],
  'memory':              ['--all', '--description', '--type', '--body', '--yes', '--mechanical', '--llm', '--model', '--show', '--clear'],
  'close':               ['--yes', '--reason', '--accept-dirty-worktree'],
  'reject':              ['--yes', '--reason', '--accept-dirty-worktree'],
  'diff':                ['--turn', '--full', '--lines'],
  'branch':              ['--goal', '--prompt', '--model', '--code', '--yes'],
  'accept':              ['--yes', '--reason', '--wait', '--approve-file'],
  'resume':              ['--follow', '--model', '--effort'],
  'reopen':              ['--reason'],
  'revert':              ['--reason', '--yes'],
  'review':              ['--interactive'],
  'ask':                 ['--message', '--json'],
  'rework':              ['--goal', '--prompt', '--model', '--code', '--parent'],
  'redo':                ['--prompt', '--model', '--no-start', '--yes'],
  'pair':                ['--unlock', '--no-summary', '--resume', '--autonomous', '--yes'],
  'unblock':             ['--message', '--model', '--effort', '--follow', '--approve-file', '--no-approve-files', '--yes'],
  'loop':                ['--model', '--follow', '--pipeline', '--backlog', '--parent', '--tag'],
  'wait':                ['--follow', '--next', '--json'],
  'submit':              ['--yes'],
  'link':                ['--parent', '--code'],
  'import-conversation': ['--list', '--show-imported', '--show', '--all', '--yes'],
  'builder':             ['--autonomous', '--yes', '--resume', '--import', '--effort', '--model'],
  'daemon':              ['--foreground', '--background', '--project', '--yes', '--prune-dirs', '--reason', '--lines', '--follow', '--no-follow'],
  'config':              ['--task', '--reason'],
  'doctor':              ['--no-resume', '--dry-run', '--yes', '--reimport-conversations', '--purge-housekeeping-conversations', '--import-memory', '--probe-agent'],
  'init':                ['--toolchain', '--skip-auth-check', '--skip-remote-check', '--skip-github-check', '--skip-completion-check', '--non-interactive'],
  'upgrade':             ['--force', '--dry-run', '--wait', '--images'],
  'completion':          ['--bash', '--zsh'],
  'chat':                ['--effort'],
  'stop':                ['--reason', '--yes'],
  'reparent':            ['--parent', '--yes'],
  'report':              ['--start', '--end', '--pdf', '--out'],
  'protect':             ['--branch', '--task'],
  // Flags for `lazy stats <sub>`. The completion script matches flags on the
  // TOP-LEVEL word, so subcommand flags hang off the parent ('stats'), the
  // same way 'daemon' carries its subcommands' flags.
  'stats':               ['--since', '--last', '--limit', '--top', '--role', '--task', '--model',
                          '--denied', '--reroutes', '--errors', '--scan', '--json', '--tree'],
  // Same for `lazy system <sub>`: build's --no-cache plus export-dockerfile's flags.
  'system':              ['--no-cache', '--force', '--output', '--stdout'],
});

function generateBashScript(): string {
  const lazyBin = getLazyBinaryPath();
  const commands = ALL_COMMANDS.join(' ');
  const activeTaskCmds = ACTIVE_TASK_ID_COMMANDS.join('|');
  const allTaskCmds = ALL_TASK_ID_COMMANDS.join('|');

  // Build the flag cases for each command
  const flagCases: string[] = [];
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    flagCases.push('            ' + cmd + ') flags="' + flags.join(' ') + '" ;;');
  }

  // Build subcommand cases (e.g. `lazy system <TAB>` -> prompts build ...)
  const subCases: string[] = [];
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    subCases.push('        ' + cmd + ') COMPREPLY=($(compgen -W "' + subs.join(' ') + '" -- "$cur")); return ;;');
  }

  // Build the bash completion script using plain string concatenation
  // to avoid any template literal escaping issues
  const lines = [
    '_lazy_completions() {',
    '    local cur prev words cword',
    '    _get_comp_words_by_ref -n : cur prev words cword',
    '',
    '    # Complete commands at position 1',
    '    if [ "$cword" -eq 1 ]; then',
    '        COMPREPLY=($(compgen -W "' + commands + '" -- "$cur"))',
    '        return',
    '    fi',
    '',
    '    local cmd="${words[1]}"',
    '',
    '    # Complete flags if current word starts with -',
    '    if [[ "$cur" == -* ]]; then',
    '        local flags=""',
    '        case "$cmd" in',
    ...flagCases,
    '        esac',
    '        COMPREPLY=($(compgen -W "$flags" -- "$cur"))',
    '        return',
    '    fi',
    '',
    '    # Complete subcommands at position 2 for commands that have them',
    '    if [ "$cword" -eq 2 ]; then',
    '        case "$cmd" in',
    ...subCases,
    '        esac',
    '    fi',
    '',
    '    # Complete task IDs for commands that take them.',
    '    # Active commands operate on working/blocked tasks; terminal commands',
    '    # operate on finished tasks and need the full task list.',
    '    case "$cmd" in',
    '        ' + activeTaskCmds + ')',
    '            local ids',
    '            ids="$("' + lazyBin + '" active --ids-only 2>/dev/null)"',
    '            COMPREPLY=($(compgen -W "$ids" -- "$cur"))',
    '            return',
    '            ;;',
    '        ' + allTaskCmds + ')',
    '            local ids',
    '            ids="$("' + lazyBin + '" list --all --ids-only 2>/dev/null)"',
    '            COMPREPLY=($(compgen -W "$ids" -- "$cur"))',
    '            return',
    '            ;;',
    '    esac',
    '}',
    '',
    'complete -F _lazy_completions lazy',
  ];

  return lines.join('\n');
}

function generateZshScript(): string {
  const lazyBin = getLazyBinaryPath();
  const activeTaskCmds = ACTIVE_TASK_ID_COMMANDS.join('|');
  const allTaskCmds = ALL_TASK_ID_COMMANDS.join('|');

  // Build flag cases using compadd
  const flagCases: string[] = [];
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    flagCases.push('            ' + cmd + ') compadd -- ' + flags.join(' ') + ' ;;');
  }

  // Build subcommand cases (e.g. `lazy system <TAB>` -> prompts build ...)
  const subCases: string[] = [];
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    subCases.push('            ' + cmd + ') compadd -- ' + subs.join(' ') + '; return ;;');
  }

  // Build the zsh completion script using plain string concatenation
  // to avoid template literal conflicts with zsh $variables.
  //
  // Avoids _arguments entirely — uses direct CURRENT/words inspection
  // and compadd. This is simpler and more debuggable than the _arguments
  // state machine, which has subtle issues with $line population and
  // nested _arguments calls.
  const lines = [
    '#compdef lazy',
    '',
    '_lazy() {',
    '    local curcontext="$curcontext"',
    '',
    '    # Position 2 = subcommand (words[1] is "lazy")',
    '    if (( CURRENT == 2 )); then',
    '        _values "lazy command" ' + ALL_COMMANDS.map(cmd => '"' + cmd + '"').join(' '),
    '        return',
    '    fi',
    '',
    '    local cmd=${words[2]}',
    '',
    '    # Flag completion: current word starts with -',
    '    case "${words[CURRENT]}" in',
    '        -*)',
    '            case $cmd in',
    ...flagCases,
    '            esac',
    '            return',
    '            ;;',
    '    esac',
    '',
    '    # Subcommand completion at position 3 (words[2] is the command)',
    '    if (( CURRENT == 3 )); then',
    '        case $cmd in',
    ...subCases,
    '        esac',
    '    fi',
    '',
    '    # Task ID completion for commands that accept them.',
    '    # Active commands operate on working/blocked tasks; terminal commands',
    '    # operate on finished tasks and need the full task list.',
    '    case $cmd in',
    '        ' + activeTaskCmds + ')',
    '            local -a ids',
    '            ids=(${(f)"$("' + lazyBin + '" active --ids-only 2>/dev/null)"})',
    '            compadd -a ids',
    '            ;;',
    '        ' + allTaskCmds + ')',
    '            local -a ids',
    '            ids=(${(f)"$("' + lazyBin + '" list --all --ids-only 2>/dev/null)"})',
    '            compadd -a ids',
    '            ;;',
    '    esac',
    '}',
    '',
    'compdef _lazy lazy',
  ];

  return lines.join('\n');
}

export async function commandCompletion(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'bash', takesValue: false },
    { name: 'zsh', takesValue: false },
  ], 'completion');

  const wantBash = parsed.flags.get('bash') === true;
  const wantZsh = parsed.flags.get('zsh') === true;

  if (!wantBash && !wantZsh) {
    console.error('Specify a shell: lazy completion --bash  or  lazy completion --zsh');
    process.exit(1);
  }

  if (wantBash && wantZsh) {
    console.error('Specify only one shell: --bash or --zsh');
    process.exit(1);
  }

  if (wantBash) {
    console.log(generateBashScript());
  } else {
    console.log(generateZshScript());
  }
}

export function completionUsage(): void {
  console.log(`Usage: lazy completion --bash | --zsh

Output shell completion script to stdout.

Options:
  --bash    Output bash completion script
  --zsh     Output zsh completion script

Setup:
  # Bash: add to ~/.bashrc
  eval "$(lazy completion --bash)"

  # Zsh: add to ~/.zshrc
  eval "$(lazy completion --zsh)"

Completions include:
  - Command names (lazy <TAB>)
  - Subcommands (lazy system/daemon/config/memory/stats <TAB>)
  - Task IDs for commands that accept them (lazy show <TAB>)
  - Flags for each command (lazy list --<TAB>)`);
}
