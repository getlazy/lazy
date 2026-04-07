import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TmuxDriver } from '../../src/terminal/tmux';
import { VanillaTerminalDriver } from '../../src/terminal/vanilla';
import { createTerminal, tmuxSessionName } from '../../src/terminal';

describe('VanillaTerminalDriver', () => {
  test('isRich is false', () => {
    const driver = new VanillaTerminalDriver();
    expect(driver.isRich).toBe(false);
  });

  // INVARIANT: VanillaTerminalDriver must be truly no-op.
  // Zero overhead when not in tmux.
  test('setActivity is a no-op', () => {
    const driver = new VanillaTerminalDriver();
    // Should not throw
    driver.setActivity('lazy builder');
    driver.setActivity('lazy pair fix-auth');
  });

  test('restoreTitle is a no-op', () => {
    const driver = new VanillaTerminalDriver();
    // Should not throw
    driver.restoreTitle();
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

  // Note: TmuxDriver methods shell out to tmux, so we can't fully test them
  // without tmux installed. We verify the class shape and that methods don't
  // crash when tmux is not available (they swallow errors by design).

  test('setActivity swallows errors when tmux is not available', () => {
    const driver = new TmuxDriver();
    // Should not throw even if tmux binary is not found
    driver.setActivity('lazy builder');
  });

  test('restoreTitle is a no-op when no activity was set', () => {
    const driver = new TmuxDriver();
    // Should not throw — no saved state to restore
    driver.restoreTitle();
  });

  test('restoreTitle swallows errors after setActivity', () => {
    const driver = new TmuxDriver();
    driver.setActivity('test');
    // Should not throw even if tmux commands fail
    driver.restoreTitle();
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

describe('tmuxSessionName', () => {
  test('generates predictable session name', () => {
    expect(tmuxSessionName('abc12345')).toBe('lazy-abc12345');
    expect(tmuxSessionName('fix-auth')).toBe('lazy-fix-auth');
  });
});
