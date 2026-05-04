/**
 * `lazy completion` — output shell completion scripts.
 *
 * Usage:
 *   eval "$(lazy completion --zsh)"   # Add to .zshrc
 *   eval "$(lazy completion --bash)"  # Add to .bashrc
 */

import { resolve } from 'path';
import { parseFlags } from '../helpers';

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

// Commands that take a task ID as their first positional argument
const TASK_ID_COMMANDS = [
  'show', 'start', 'edit', 'comment', 'clone', 'unblock', 'review', 'resume', 'reopen',
  'branch', 'rework', 'diff', 'status', 'shell', 'pair', 'accept', 'reject', 'revert',
  'close', 'redo', 'submit', 'sync', 'wait', 'watch', 'doctor',
];

// All top-level commands (canonical names only, no aliases)
const ALL_COMMANDS = [
  'create', 'start', 'fix', 'document', 'refactor', 'edit', 'comment', 'clone',
  'list', 'active', 'blocked', 'show', 'search',
  'review', 'loop', 'unblock', 'resume', 'reopen', 'branch', 'wait', 'watch',
  'diff', 'status', 'shell', 'pair', 'accept', 'reject', 'revert', 'rework', 'close', 'redo',
  'link', 'import-conversation', 'propose', 'submit', 'sync',
  'daemon', 'logs', 'server', 'config',
  'builder', 'init', 'doctor', 'upgrade', 'completion', 'system',
];

// Flags per command (only commands with flags are listed)
const COMMAND_FLAGS: Record<string, string[]> = {
  'create':              ['--goal', '--prompt', '--model', '--type', '--code', '--parent', '--agent'],
  'start':               ['--model', '--agent', '--follow', '--yes', '--force-local'],
  'fix':                 ['--goal', '--prompt', '--model', '--code', '--parent'],
  'document':            ['--goal', '--prompt', '--model', '--code', '--parent'],
  'refactor':            ['--goal', '--prompt', '--model', '--code', '--parent'],
  'edit':                ['--goal', '--prompt', '--model', '--type', '--code', '--parent'],
  'clone':               ['--parent', '--default-parent', '--code', '--model'],
  'list':                ['--all', '--flat', '--tree', '--ids-only'],
  'active':              ['--flat', '--tree', '--follow', '--ids-only'],
  'blocked':             ['--flat', '--tree'],
  'show':                ['--full', '--lines', '--json'],
  'search':              ['--fuzzy', '--group', '--json', '--tasks', '--prompts', '--turns', '--commits', '--notes', '--conversations'],
  'comment':             ['--message'],
  'close':               ['--yes', '--reason', '--accept-dirty-worktree'],
  'reject':              ['--yes', '--reason', '--accept-dirty-worktree'],
  'diff':                ['--turn', '--full', '--lines'],
  'branch':              ['--goal', '--prompt', '--model', '--code', '--yes'],
  'accept':              ['--yes', '--reason', '--wait', '--approve-file'],
  'resume':              ['--follow', '--model'],
  'reopen':              ['--reason'],
  'revert':              ['--reason', '--yes'],
  'review':              ['--model', '--follow'],
  'rework':              ['--goal', '--prompt', '--model', '--code', '--parent'],
  'redo':                ['--prompt', '--model', '--no-start', '--yes'],
  'pair':                ['--unlock', '--no-summary', '--resume', '--autonomous', '--yes'],
  'unblock':             ['--message', '--model', '--follow', '--approve-file', '--no-approve-files', '--yes'],
  'loop':                ['--model', '--follow'],
  'wait':                ['--follow', '--next'],
  'submit':              ['--yes'],
  'link':                ['--parent', '--code'],
  'import-conversation': ['--list', '--show-imported', '--show', '--all'],
  'builder':             ['--autonomous', '--yes', '--resume'],
  'daemon':              ['--foreground', '--background', '--project'],
  'logs':                ['--lines', '--follow', '--no-follow', '--project'],
  'server':              ['--port'],
  'config':              ['--task', '--reason'],
  'doctor':              ['--no-resume', '--dry-run', '--yes'],
  'init':                ['--toolchain', '--skip-auth-check', '--skip-remote-check', '--skip-github-check', '--skip-completion-check', '--non-interactive'],
  'propose':             ['--goal', '--code', '--prompt', '--task'],
  'upgrade':             ['--force', '--dry-run'],
  'completion':          ['--bash', '--zsh'],
};

function generateBashScript(): string {
  const lazyBin = getLazyBinaryPath();
  const commands = ALL_COMMANDS.join(' ');
  const taskIdCmds = TASK_ID_COMMANDS.join('|');

  // Build the flag cases for each command
  const flagCases: string[] = [];
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    flagCases.push('            ' + cmd + ') flags="' + flags.join(' ') + '" ;;');
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
    '    # Complete task IDs for commands that take them',
    '    case "$cmd" in',
    '        ' + taskIdCmds + ')',
    '            local ids',
    '            ids="$("' + lazyBin + '" active --ids-only 2>/dev/null)"',
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
  const taskIdCmds = TASK_ID_COMMANDS.join('|');

  // Build flag cases using compadd
  const flagCases: string[] = [];
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    flagCases.push('            ' + cmd + ') compadd -- ' + flags.join(' ') + ' ;;');
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
    '    # Task ID completion for commands that accept them',
    '    case $cmd in',
    '        ' + taskIdCmds + ')',
    '            local -a ids',
    '            ids=(${(f)"$("' + lazyBin + '" active --ids-only 2>/dev/null)"})',
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
  - Task IDs for commands that accept them (lazy show <TAB>)
  - Flags for each command (lazy list --<TAB>)`);
}
