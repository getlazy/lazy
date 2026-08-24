import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import * as readline from 'readline';
import { StringDecoder } from 'string_decoder';
import { findLazyRoot, getDataDir } from './init';

/**
 * Build-time flag, defined only in a compiled `lazy` / `lazy-agent` binary.
 *
 * `scripts/build.ts` passes `--define LAZY_RELEASE_BUILD=true --minify-syntax`,
 * so every `typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_*`
 * branch below folds to a constant and is ELIMINATED from the released binary:
 * the prompt test seams (LAZY_FORCE_TTY, LAZY_PROMPT_DEFAULTS,
 * LAZY_PROMPT_SECRET) are not merely disabled there, they are absent. Running
 * from source the identifier is undefined and the seams work as always.
 *
 * A build-time constant, not a runtime check, precisely because a runtime check
 * is something an agent can satisfy too. `lazy approve`'s protected passphrase
 * prompt is driven through these seams by e2e tests and must stay that way in
 * the tree — so the guard that matters for users has to live in the build.
 *
 * TWO SHAPES THAT LOOK EQUIVALENT ARE NOT. The `typeof` test must appear
 * INLINE at each use site. Hoisting it into a module-level
 * `const RELEASE_BUILD = ...` does NOT work: bun rewrites module-scope `const`
 * to `var` when bundling, stops inlining it, and every seam branch survives in
 * the binary (verified on bun 1.4.0). Nor can the flag be imported from a
 * shared module — bun folds a define within the module that reads it and does
 * not propagate the constant across module boundaries. If you refactor these
 * five branches, re-check the built binary with
 * `test/unit/build-release-flags.test.ts`, which also fails if the build stops
 * passing either flag.
 */
declare const LAZY_RELEASE_BUILD: boolean;

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
  if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_FORCE_TTY === '1') return true;
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
  if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_PROMPT_DEFAULTS) {
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

/** Control characters the masked prompt reacts to. */
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_U = '\u0015';
const DEL = '\u007f';

/** What each typed character is echoed as. */
const MASK_CHAR = '*';

/** Signals that must restore the terminal before the process goes away. */
const RESTORE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Thrown by promptSecret() when the human aborts the prompt (Ctrl-C, or
 * Ctrl-D on an empty line). Callers should treat it as "the human said no",
 * not as a failure to report — the terminal has already been restored.
 */
export class PromptCancelledError extends Error {
  constructor(message = 'Prompt cancelled.') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

/** The subset of process.stdin promptSecret needs — lets tests drive it. */
export interface SecretInputStream extends NodeJS.EventEmitter {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  unref?(): unknown;
}

/** The subset of process.stdout promptSecret needs. */
export interface SecretOutputStream {
  write(chunk: string): unknown;
}

/**
 * Prompts for a secret WITHOUT echoing it. Typed characters are replaced by a
 * fixed mask character, so the value never reaches the screen, the terminal
 * scrollback, a screen recording, or a shared screen.
 *
 * Use this — never promptLine — for anything the user would not want printed:
 * approval passphrases, tokens, credentials.
 *
 * Handles Enter (submit), Backspace/Delete (erase one), Ctrl-U (erase line),
 * Ctrl-C and Ctrl-D-on-empty (abort, throws PromptCancelledError). The
 * terminal's original raw-mode setting is restored on every exit path,
 * including errors and SIGINT/SIGTERM/SIGHUP — a prompt that dies without
 * restoring leaves the human's shell with echo permanently off.
 *
 * Requires a REAL TTY: masking is impossible otherwise, so rather than
 * silently falling back to an echoing reader (which is the bug this exists to
 * fix) it throws and points at the piped-stdin route. In test environments
 * with LAZY_PROMPT_DEFAULTS set it echoes the prompt and returns '', matching
 * promptLine so e2e tests can drive interactive paths without a TTY.
 */
export async function promptSecret(message: string): Promise<string> {
  if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_PROMPT_DEFAULTS) {
    console.log(`${message}: `);
    // Test-only companion to LAZY_PROMPT_DEFAULTS (same family — never read
    // in production paths): the value a masked prompt "types". Without it the
    // driven prompt returns '', which exercises the empty-token refusal; e2e
    // suites that need the happy path set it to the enrolled passphrase.
    return process.env.LAZY_PROMPT_SECRET ?? '';
  }
  return promptSecretFrom(message, process.stdin, process.stdout);
}

/**
 * promptSecret's implementation, with the streams injected. Exported for unit
 * tests: a real TTY cannot be created inside `bun test`, so the no-echo and
 * mode-restoration invariants are only testable through this seam.
 */
export async function promptSecretFrom(
  message: string,
  input: SecretInputStream,
  output: SecretOutputStream,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(
      // Deliberately does NOT suggest piping. Whether a piped value is an
      // acceptable substitute is the CALLER's decision, not this helper's:
      // `lazy system agent set-key` accepts one (and reads it itself, before
      // ever reaching here), while the approval passphrase refuses one by
      // design. A blanket "pipe it instead" here advertised a route that no
      // longer exists for the passphrase.
      'Cannot read a secret without echoing it: stdin is not an interactive terminal.\n' +
        'Run this command from a terminal.',
    );
  }

  const wasRaw = input.isRaw ?? false;
  const decoder = new StringDecoder('utf8');
  let entered = '';
  let finished = false;

  return new Promise<string>((resolve, reject) => {
    // Declared up front so cleanup() can detach every listener it attached,
    // whichever exit path runs first.
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          succeed(entered);
          return;
        }
        if (ch === CTRL_C) {
          // Ctrl-C: in raw mode this arrives as data, not as SIGINT.
          output.write('\n');
          fail(new PromptCancelledError());
          return;
        }
        if (ch === CTRL_D) {
          // Ctrl-D: end-of-transmission. Only meaningful on an empty line.
          if (entered.length === 0) {
            output.write('\n');
            fail(new PromptCancelledError());
            return;
          }
          continue;
        }
        if (ch === DEL || ch === '\b') {
          if (entered.length > 0) {
            entered = entered.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch === CTRL_U) {
          // Ctrl-U: kill line.
          output.write('\b \b'.repeat(entered.length));
          entered = '';
          continue;
        }
        // Drop remaining control bytes; keep everything printable.
        //
        // Note what this does NOT do: an escape sequence is only partly
        // control bytes, so its printable tail survives. An up-arrow (ESC [ A)
        // loses the ESC and contributes "[A" to the secret. That matches a
        // standard masked prompt (`read -s` behaves the same way) and is
        // pinned by a unit test — swallowing whole CSI sequences would need a
        // small state machine, which is a deliberate open question rather than
        // an oversight. Do not "fix" this line alone: dropping the tail
        // without parsing the sequence would silently eat ordinary bracket
        // characters from real passphrases.
        if (ch < ' ') continue;
        entered += ch;
        output.write(MASK_CHAR);
      }
    };

    const onError = (err: Error) => fail(err);

    const onSignal = (signal: NodeJS.Signals) => {
      // Restore the terminal FIRST — a signal that kills us mid-prompt would
      // otherwise leave the human's shell with echo off.
      cleanup();
      output.write('\n');
      reject(new PromptCancelledError(`Interrupted by ${signal}.`));
      // If nothing else in the process handles this signal, re-raise it so it
      // keeps its default disposition. cleanup() already removed our own
      // handler, so this count is other people's.
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      for (const signal of RESTORE_SIGNALS) process.removeListener(signal, onSignal);
      try {
        input.setRawMode!(wasRaw);
      } catch {
        // Best effort: the stream may already be closed (e.g. the terminal
        // went away). Nothing left to restore in that case.
      }
      // Match promptLine: release stdin so the event loop can drain.
      input.pause?.();
      input.unref?.();
    };

    /** Every exit path goes through these two, so cleanup() can never be skipped. */
    function succeed(value: string): void {
      cleanup();
      resolve(value);
    }
    function fail(err: Error): void {
      cleanup();
      reject(err);
    }

    try {
      input.setRawMode!(true);
      input.resume?.();
      input.on('data', onData);
      input.on('error', onError);
      for (const signal of RESTORE_SIGNALS) process.on(signal, onSignal);
      output.write(`${message}: `);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Prompts the user for a yes/no answer (default no).
 * In test environments, LAZY_PROMPT_DEFAULTS controls auto-answering:
 *   "accept" → always yes, "decline" → always no, "1" → return the default.
 */
export async function promptYesNo(message: string, defaultYes: boolean = false): Promise<boolean> {
  const override =
    typeof LAZY_RELEASE_BUILD === 'undefined' ? process.env.LAZY_PROMPT_DEFAULTS : undefined;
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
  if (typeof LAZY_RELEASE_BUILD === 'undefined' && process.env.LAZY_PROMPT_DEFAULTS) {
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
