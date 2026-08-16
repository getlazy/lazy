import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TmuxDriver } from '../../src/terminal/tmux';
import { VanillaTerminalDriver } from '../../src/terminal/vanilla';
import { createTerminal } from '../../src/terminal';

describe('VanillaTerminalDriver', () => {
  test('isRich is false', () => {
    const driver = new VanillaTerminalDriver();
    expect(driver.isRich).toBe(false);
  });

  test('watchTask returns error about tmux requirement', async () => {
    const driver = new VanillaTerminalDriver();
    const result = await driver.watchTask('lazy-abc12345');
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('tmux is required');
  });
});

describe('TmuxDriver', () => {
  test('isRich is true', () => {
    const driver = new TmuxDriver();
    expect(driver.isRich).toBe(true);
  });

  test('watchTask returns error when session does not exist', async () => {
    const driver = new TmuxDriver();
    const result = await driver.watchTask('lazy-nonexistent-session');
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('not found');
  });
});

describe('createTerminal factory', () => {
  let originalTmux: string | undefined;

  beforeEach(() => {
    originalTmux = process.env.TMUX;
  });

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
  });

  // INVARIANT: Factory correctly detects $TMUX env var.
  test('returns TmuxDriver when $TMUX is set', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    const terminal = createTerminal();
    expect(terminal.isRich).toBe(true);
    expect(terminal).toBeInstanceOf(TmuxDriver);
  });

  test('returns VanillaTerminalDriver when $TMUX is not set', () => {
    delete process.env.TMUX;
    const terminal = createTerminal();
    expect(terminal.isRich).toBe(false);
    expect(terminal).toBeInstanceOf(VanillaTerminalDriver);
  });
});
