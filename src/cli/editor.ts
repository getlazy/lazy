import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as readline from 'readline';
import { findLazyRoot, getDataDir } from './init';

/**
 * Save edited content to a recovery file in <datadir>/recovery/.
 *
 * CRITICAL: This ensures human feedback is never lost. The recovery file
 * persists even if subsequent operations (auth checks, container launches,
 * network calls) fail. The human can always retrieve their input.
 *
 * Returns the recovery file path, or null if lazy root wasn't found.
 */
export function saveRecoveryFile(content: string, tag: string): string | null {
  const root = findLazyRoot();
  if (!root) return null;

  const recoveryDir = join(root, getDataDir(root), 'recovery');
  if (!existsSync(recoveryDir)) {
    mkdirSync(recoveryDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recoveryPath = join(recoveryDir, `${tag}-${timestamp}.md`);
  writeFileSync(recoveryPath, content);
  return recoveryPath;
}

/**
 * Remove a recovery file after feedback has been successfully persisted
 * to durable storage (database).
 */
export function removeRecoveryFile(recoveryPath: string): void {
  try {
    unlinkSync(recoveryPath);
  } catch {
    // Ignore — recovery file may already be gone
  }
}

/**
 * Check if we have an interactive TTY available.
 * Returns true if stdin is a TTY, false otherwise.
 * In test environments, LAZY_FORCE_TTY=1 overrides this to return true.
 */
export function isTTY(): boolean {
  if (process.env.LAZY_FORCE_TTY === '1') return true;
  return process.stdin.isTTY ?? false;
}

/**
 * Throw an error if no TTY is available.
 * Use this to fail early when interactive input is required.
 */
export function requireTTY(message?: string): void {
  if (!isTTY()) {
    throw new Error(message ?? 'This command requires an interactive terminal.');
  }
}

/**
 * Opens the user's preferred editor with the given content.
 * Returns the edited content, or null if the user cancelled.
 *
 * When recoveryTag is provided, the edited content is saved to a recovery
 * file in <datadir>/recovery/ BEFORE the temp file is cleaned up. This
 * ensures human feedback is never lost, even if subsequent operations fail.
 *
 * Returns { content, recoveryPath } when recoveryTag is provided.
 */
export async function openEditor(initialContent?: string): Promise<string | null>;
export async function openEditor(initialContent: string, recoveryTag: string): Promise<{ content: string; recoveryPath: string | null } | null>;
export async function openEditor(initialContent: string = '', recoveryTag?: string): Promise<string | { content: string; recoveryPath: string | null } | null> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmpFile = join(tmpdir(), `work-edit-${randomUUID()}.md`);

  try {
    // Write initial content to temp file
    writeFileSync(tmpFile, initialContent);

    // shell:true is intentional — $EDITOR may contain arguments (e.g. "code --wait").
    // This is not a command injection risk: EDITOR is set by the user in their own
    // shell environment; anyone who controls it already has shell access.
    const result = spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      shell: true,
    });

    if (result.status !== 0) {
      console.error('Editor exited with non-zero status');
      return null;
    }

    // Read back the edited content
    const edited = await Bun.file(tmpFile).text();

    // If a recovery tag was provided, save to recovery file BEFORE cleanup.
    // This is the critical "save first" guarantee for human feedback.
    if (recoveryTag) {
      const recoveryPath = saveRecoveryFile(edited, recoveryTag);
      return { content: edited, recoveryPath };
    }

    return edited;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpFile);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Prompts the user for a single line of input with the given prompt message.
 * Reads until newline (Enter key), not until EOF.
 * In test environments with LAZY_PROMPT_DEFAULTS set, returns the default value without prompting.
 */
export async function promptLine(message: string, defaultValue?: string): Promise<string> {
  // In test mode, use the default value without prompting
  if (process.env.LAZY_PROMPT_DEFAULTS) {
    const prompt = defaultValue ? `${message} [${defaultValue}]: ` : `${message}: `;
    console.log(prompt);
    return defaultValue || '';
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = defaultValue ? `${message} [${defaultValue}]: ` : `${message}: `;

    rl.question(prompt, (answer) => {
      rl.close();
      // Allow the event loop to exit even though stdin was referenced.
      // pause() is needed in addition to unref() because spawnSync with
      // stdio:'inherit' (e.g. opening $EDITOR) can leave stdin in a state
      // where unref() alone is insufficient for the event loop to drain.
      process.stdin.pause();
      process.stdin.unref();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

/**
 * Prompts the user for a yes/no answer (default no).
 * In test environments, LAZY_PROMPT_DEFAULTS controls auto-answering:
 *   "accept" → always yes, "decline" → always no, "1" → return the default.
 */
export async function promptYesNo(message: string, defaultYes: boolean = false): Promise<boolean> {
  const override = process.env.LAZY_PROMPT_DEFAULTS;
  if (override) {
    const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
    console.log(message + suffix);
    if (override === 'accept') return true;
    if (override === 'decline') return false;
    return defaultYes;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';

    rl.question(message + suffix, (answer) => {
      rl.close();
      // Allow the event loop to exit even though stdin was referenced.
      // pause() is needed in addition to unref() because spawnSync with
      // stdio:'inherit' (e.g. opening $EDITOR) can leave stdin in a state
      // where unref() alone is insufficient for the event loop to drain.
      process.stdin.pause();
      process.stdin.unref();
      const trimmed = answer.trim().toLowerCase();

      if (!trimmed) {
        resolve(defaultYes);
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
  });
}

/**
 * Prompts the user to choose from a numbered list of options.
 * Returns the index of the selected option (0-based).
 * In test environments with LAZY_PROMPT_DEFAULTS set, returns 0 (first option) without waiting for input.
 */
export async function promptChoice(message: string, options: string[]): Promise<number> {
  if (process.env.LAZY_PROMPT_DEFAULTS) {
    console.log(message);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${i + 1}) ${options[i]}`);
    }
    return 0;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(message);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${i + 1}) ${options[i]}`);
    }

    rl.question('\nChoice: ', (answer) => {
      rl.close();
      process.stdin.pause();
      process.stdin.unref();
      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 1 || num > options.length) {
        // Default to first option on invalid input
        resolve(0);
      } else {
        resolve(num - 1);
      }
    });
  });
}

/**
 * Read piped stdin if available (non-TTY). Returns null if stdin is a TTY.
 * Use this to support `echo "text" | lazy command` patterns.
 */
export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const text = await readStdin();
  const trimmed = text.trim();
  return trimmed || null;
}

/**
 * Read all of stdin until EOF (Ctrl+D in TTY, pipe close otherwise).
 * Uses readline to avoid conflicts with other readline-based prompts.
 */
export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', () => {
      // Allow the event loop to exit even though stdin was referenced.
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') {
        process.stdin.unref();
      }
      resolve(lines.join('\n'));
    });
  });
}
