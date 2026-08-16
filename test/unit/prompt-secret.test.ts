/**
 * Unit tests for the masked secret prompt (src/cli/editor.ts).
 *
 * INVARIANT: a secret prompt never echoes what the human types. The approval
 * passphrase used to go through promptLine — an ordinary line reader with echo
 * on — which put the secret on screen, in scrollback, and in any screen share
 * or recording. Everything else about that passphrase is treated as sensitive
 * (no --passphrase flag, gitignored file), so the prompt must be too.
 *
 * INVARIANT: the terminal's raw-mode setting is restored on EVERY exit path.
 * A prompt that returns (or is interrupted) without restoring leaves the
 * human's own shell with echo off — they have to blind-type `stty sane`.
 *
 * A real TTY cannot be created inside `bun test`, so these drive
 * promptSecretFrom() with a fake TTY-shaped stream. That seam exists for this
 * reason; the process-wide promptSecret() is a thin wrapper over it.
 */

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import {
  promptSecretFrom,
  PromptCancelledError,
  type SecretInputStream,
} from '../../src/cli/editor';

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const CTRL_U = String.fromCharCode(0x15);
const DEL = String.fromCharCode(0x7f);

/** A fake stdin that looks enough like a TTY for the prompt to drive it. */
class FakeTTY extends EventEmitter implements SecretInputStream {
  isTTY = true;
  isRaw: boolean;
  /** Every setRawMode() call, in order — the restoration audit trail. */
  rawModeCalls: boolean[] = [];
  paused = false;

  constructor(initiallyRaw = false) {
    super();
    this.isRaw = initiallyRaw;
  }

  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  /** Deliver keystrokes as the terminal would: raw bytes on 'data'. */
  type(text: string): void {
    this.emit('data', Buffer.from(text, 'utf-8'));
  }
}

/** A fake stdout that records everything written to it. */
class FakeOut {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

/** Signal listeners installed by the prompt must not outlive it. */
function signalListenerCount(): number {
  return (
    process.listenerCount('SIGINT') +
    process.listenerCount('SIGTERM') +
    process.listenerCount('SIGHUP')
  );
}

describe('promptSecret: masking', () => {
  test('does not echo the typed characters', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Approval passphrase', input, output);
    await Promise.resolve();
    input.type('hunter2\r');

    expect(await pending).toBe('hunter2');
    // The secret itself must appear NOWHERE in what reached the terminal.
    expect(output.text).not.toContain('hunter2');
    expect(output.text).not.toContain('hunter');
    // Each character produced a fixed-width mask instead.
    expect(output.text).toContain('*'.repeat('hunter2'.length));
    // The prompt message itself is still shown — the human must know what is
    // being asked for.
    expect(output.text).toContain('Approval passphrase: ');
  });

  test('backspace erases a character from the value and the screen', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type(`abc${DEL}d\r`);

    expect(await pending).toBe('abd');
    expect(output.text).toContain('\b \b');
    expect(output.text).not.toContain('abc');
  });

  test('Ctrl-U clears the whole entry', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type(`wrong${CTRL_U}right\r`);

    expect(await pending).toBe('right');
  });

  test('control characters (e.g. arrow-key escapes) never enter the value', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    // An up-arrow: ESC [ A. The ESC (and every other control byte) is
    // dropped; the printable remainder is kept and masked like any other
    // input, exactly as a standard masked prompt behaves.
    input.type(`ab${String.fromCharCode(0x1b)}[Ac\r`);

    expect(await pending).toBe('ab[Ac');
  });

  test('the value survives a keystroke split across chunks', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type('pass');
    input.type('phrase');
    input.type('\n');

    expect(await pending).toBe('passphrase');
  });
});

describe('promptSecret: terminal restoration', () => {
  test('restores raw mode after a completed prompt', async () => {
    const input = new FakeTTY(false);
    const output = new FakeOut();
    const signalsBefore = signalListenerCount();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    expect(input.isRaw).toBe(true); // raw while reading
    input.type('s3cret\r');
    await pending;

    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(signalListenerCount()).toBe(signalsBefore);
  });

  test('restores raw mode after an interrupted (Ctrl-C) prompt', async () => {
    const input = new FakeTTY(false);
    const output = new FakeOut();
    const signalsBefore = signalListenerCount();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type(`partial${CTRL_C}`);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(signalListenerCount()).toBe(signalsBefore);
    // Whatever had been typed before the abort is not on screen either.
    expect(output.text).not.toContain('partial');
  });

  test('Ctrl-D on an empty line cancels', async () => {
    const input = new FakeTTY();
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type(CTRL_D);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(input.isRaw).toBe(false);
  });

  test('restores the PREVIOUS mode, not just "off"', async () => {
    // A caller that was already in raw mode (e.g. a TUI) must get raw mode
    // back, not a terminal silently switched to cooked.
    const input = new FakeTTY(true);
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.type('x\r');
    await pending;

    expect(input.isRaw).toBe(true);
  });

  test('restores raw mode when the stream errors mid-prompt', async () => {
    const input = new FakeTTY(false);
    const output = new FakeOut();

    const pending = promptSecretFrom('Secret', input, output);
    await Promise.resolve();
    input.emit('error', new Error('terminal went away'));

    await expect(pending).rejects.toThrow('terminal went away');
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });
});

describe('promptSecret: non-TTY', () => {
  test('refuses rather than falling back to an echoing reader', async () => {
    // INVARIANT: no silent downgrade. Masking is impossible without a TTY, and
    // an echoing fallback IS the bug this helper exists to fix — so it fails
    // loudly and points at the piped-stdin route instead.
    const input = new FakeTTY();
    input.isTTY = false;
    const output = new FakeOut();

    await expect(promptSecretFrom('Secret', input, output)).rejects.toThrow(
      /not an interactive terminal/,
    );
    expect(input.rawModeCalls).toEqual([]);
    expect(output.text).toBe('');
  });
});
