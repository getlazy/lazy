/**
 * Shell detection utility — identifies the user's shell and checks
 * whether lazy completions are configured.
 *
 * Used by `lazy init` (to recommend completion setup) and `lazy doctor`
 * (to validate completions are installed and working).
 */

import { basename, join } from 'path';
import { getHome } from '../utils/home';
import { spawnSync } from '../utils/spawn';
import { pathExists, readFileSafe } from '../utils/fs';

export type ShellName = 'bash' | 'zsh' | 'fish' | 'unknown';

export interface ShellInfo {
  name: ShellName;
  path: string;
  version?: string;
  completionInstalled: boolean;
}

/**
 * Parse a shell name from a binary path.
 * e.g. "/bin/zsh" → "zsh", "/usr/local/bin/bash" → "bash"
 */
function parseShellName(shellPath: string): ShellName {
  const name = basename(shellPath);
  if (name === 'bash') return 'bash';
  if (name === 'zsh') return 'zsh';
  if (name === 'fish') return 'fish';
  return 'unknown';
}

/**
 * Get the shell version without spawning a subprocess.
 * Reads the version from a quick spawnSync call with --version.
 * Returns undefined if version cannot be determined.
 */
function getShellVersion(shellPath: string, shellName: ShellName): string | undefined {
  if (shellName === 'unknown') return undefined;

  try {
    // All three shells support --version
    const result = spawnSync([shellPath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });

    if (result.exitCode !== 0) return undefined;

    const output = result.stdout.toString().trim();
    if (!output) return undefined;

    // Parse version from first line
    // bash: "GNU bash, version 5.2.15(1)-release ..."
    // zsh:  "zsh 5.9 (x86_64-apple-darwin23.0)"
    // fish: "fish, version 3.6.1"
    if (shellName === 'bash') {
      const match = output.match(/version\s+([^\s(]+)/);
      return match?.[1];
    }
    if (shellName === 'zsh') {
      const match = output.match(/zsh\s+([^\s(]+)/);
      return match?.[1];
    }
    if (shellName === 'fish') {
      const match = output.match(/version\s+([^\s]+)/);
      return match?.[1];
    }
  } catch {
    // Shell binary not found or timed out
  }
  return undefined;
}

/**
 * Check if lazy completions are configured for zsh.
 * Looks for 'lazy' completion setup in ~/.zshrc or fpath directories.
 */
async function checkZshCompletions(): Promise<boolean> {
  const home = getHome();
  const zshrc = join(home, '.zshrc');

  // Check if ~/.zshrc sources lazy completions
  const content = await readFileSafe(zshrc);
  if (content) {
    // Match eval "$(lazy completion --zsh)" or similar patterns
    if (content.includes('lazy completion') && content.includes('zsh')) {
      return true;
    }
    // Also check for compdef _lazy lazy (manual completion setup)
    if (content.includes('compdef _lazy lazy') || content.includes('compdef _lazy lazy')) {
      return true;
    }
  }

  return false;
}

/**
 * Check if lazy completions are configured for bash.
 * Looks in ~/.bashrc and bash_completion.d directories.
 */
async function checkBashCompletions(): Promise<boolean> {
  const home = getHome();

  // Check ~/.bashrc
  const bashrc = join(home, '.bashrc');
  const bashrcContent = await readFileSafe(bashrc);
  if (bashrcContent) {
    if (bashrcContent.includes('lazy completion') && bashrcContent.includes('bash')) {
      return true;
    }
    if (bashrcContent.includes('complete -F _lazy_completions lazy')) {
      return true;
    }
  }

  // Check ~/.bash_profile (macOS often uses this instead)
  const bashProfile = join(home, '.bash_profile');
  const bashProfileContent = await readFileSafe(bashProfile);
  if (bashProfileContent) {
    if (bashProfileContent.includes('lazy completion') && bashProfileContent.includes('bash')) {
      return true;
    }
  }

  // Check common bash_completion.d directories
  const completionDirs = [
    '/etc/bash_completion.d',
    '/usr/local/etc/bash_completion.d',
    join(home, '.local/share/bash-completion/completions'),
  ];

  for (const dir of completionDirs) {
    const lazyCompletion = join(dir, 'lazy');
    if (await pathExists(lazyCompletion)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if lazy completions are configured for fish.
 * Looks in ~/.config/fish/completions/ for a lazy.fish file.
 */
async function checkFishCompletions(): Promise<boolean> {
  const home = getHome();

  // Fish completions live in a well-known directory
  const fishCompletionFile = join(home, '.config', 'fish', 'completions', 'lazy.fish');
  if (await pathExists(fishCompletionFile)) {
    return true;
  }

  // Also check fish config for sourcing lazy completions
  const fishConfig = join(home, '.config', 'fish', 'config.fish');
  const content = await readFileSafe(fishConfig);
  if (content && content.includes('lazy completion')) {
    return true;
  }

  return false;
}

/**
 * Check whether lazy completions are installed for the detected shell.
 */
async function checkCompletionInstalled(shellName: ShellName): Promise<boolean> {
  switch (shellName) {
    case 'zsh': return await checkZshCompletions();
    case 'bash': return await checkBashCompletions();
    case 'fish': return await checkFishCompletions();
    default: return false;
  }
}

/**
 * Detect the user's default shell and whether lazy completions are configured.
 *
 * Detection approach:
 * - Reads $SHELL env var for the user's default shell
 * - Parses shell name from the path
 * - Checks if completions are installed for that shell
 */
export async function detectShell(): Promise<ShellInfo> {
  const shellPath = process.env.SHELL || '';

  if (!shellPath) {
    return {
      name: 'unknown',
      path: '',
      completionInstalled: false,
    };
  }

  const name = parseShellName(shellPath);
  const version = getShellVersion(shellPath, name);
  const completionInstalled = await checkCompletionInstalled(name);

  return {
    name,
    path: shellPath,
    version,
    completionInstalled,
  };
}

/**
 * Get the shell config file recommendation for setting up completions.
 * Returns the command the user should run, or null if the shell is unknown.
 */
export function getCompletionSetupCommand(shellName: ShellName): string | null {
  switch (shellName) {
    case 'zsh':
      return 'eval "$(lazy completion --zsh)"  # Add to ~/.zshrc';
    case 'bash':
      return 'eval "$(lazy completion --bash)"  # Add to ~/.bashrc';
    case 'fish':
      // Fish doesn't have --fish flag yet in the completion command
      return null;
    default:
      return null;
  }
}

/**
 * Get the config file path for a given shell.
 */
export function getShellConfigFile(shellName: ShellName): string | null {
  switch (shellName) {
    case 'zsh': return '~/.zshrc';
    case 'bash': return '~/.bashrc';
    case 'fish': return '~/.config/fish/config.fish';
    default: return null;
  }
}
