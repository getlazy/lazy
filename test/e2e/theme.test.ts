import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';

/**
 * Tests for the centralized terminal coloring system (src/cli/theme.ts).
 *
 * These tests verify:
 * - Colors are disabled when NO_COLOR is set
 * - theme.pad() produces correct visible widths
 * - Semantic formatters return colored strings when enabled
 * - Semantic formatters return plain strings when disabled
 */

// Import theme directly for unit-style tests
import { theme, bold, dim, red, green, yellow, blue, magenta, cyan, stripAnsi, resetColorCache } from '../../src/cli/theme';

describe('theme', () => {
  describe('stripAnsi', () => {
    test('strips ANSI codes from string', () => {
      const colored = '\x1b[36mhello\x1b[0m';
      expect(stripAnsi(colored)).toBe('hello');
    });

    test('returns plain string unchanged', () => {
      expect(stripAnsi('hello')).toBe('hello');
    });

    test('strips multiple ANSI codes', () => {
      const colored = '\x1b[1m\x1b[31merror\x1b[0m';
      expect(stripAnsi(colored)).toBe('error');
    });
  });

  describe('theme.pad', () => {
    test('pads plain string to width', () => {
      const result = theme.pad('abc', 8);
      expect(result).toBe('abc     ');
      expect(result.length).toBe(8);
    });

    test('pads colored string to correct visible width', () => {
      // Simulate a colored string (even if colors are disabled in test env)
      const colored = '\x1b[36mabc\x1b[0m';
      const result = theme.pad(colored, 8);
      // The visible text is "abc" (3 chars), so 5 spaces should be added
      expect(stripAnsi(result)).toBe('abc     ');
      expect(stripAnsi(result).length).toBe(8);
    });

    test('does not pad if string already meets width', () => {
      const result = theme.pad('abcdefgh', 8);
      expect(result).toBe('abcdefgh');
    });

    test('does not pad if string exceeds width', () => {
      const result = theme.pad('abcdefghij', 8);
      expect(result).toBe('abcdefghij');
    });
  });

  describe('NO_COLOR support', () => {
    // Save and restore env
    const originalNoColor = process.env.NO_COLOR;
    const originalTerm = process.env.TERM;

    afterEach(() => {
      // Restore
      if (originalNoColor !== undefined) {
        process.env.NO_COLOR = originalNoColor;
      } else {
        delete process.env.NO_COLOR;
      }
      if (originalTerm !== undefined) {
        process.env.TERM = originalTerm;
      } else {
        delete process.env.TERM;
      }
      resetColorCache();
    });

    test('color functions return plain text when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      resetColorCache();

      expect(bold('text')).toBe('text');
      expect(red('text')).toBe('text');
      expect(green('text')).toBe('text');
      expect(yellow('text')).toBe('text');
      expect(blue('text')).toBe('text');
      expect(magenta('text')).toBe('text');
      expect(cyan('text')).toBe('text');
      expect(dim('text')).toBe('text');
    });

    test('semantic formatters return plain text when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      resetColorCache();

      expect(theme.taskId('abc12345')).toBe('abc12345');
      expect(theme.status('working')).toBe('working');
      expect(theme.model('claude-opus-4-6')).toBe('claude-opus-4-6');
      expect(theme.commitSha('82994b6')).toBe('82994b6');
      expect(theme.command('lazy start')).toBe('lazy start');
      expect(theme.header('ID')).toBe('ID');
      expect(theme.separator('───')).toBe('───');
      expect(theme.error('fail')).toBe('fail');
      expect(theme.warning('warn')).toBe('warn');
      expect(theme.success('ok')).toBe('ok');
      expect(theme.timestamp('2025-01-01')).toBe('2025-01-01');
      expect(theme.duration('5m 3s')).toBe('5m 3s');
      expect(theme.label('Goal:')).toBe('Goal:');
      expect(theme.value('test')).toBe('test');
      expect(theme.turnRole('human')).toBe('human');
      expect(theme.turnRole('agent')).toBe('agent');
      expect(theme.count('42')).toBe('42');
    });

    test('color functions return plain text when TERM=dumb', () => {
      delete process.env.NO_COLOR;
      process.env.TERM = 'dumb';
      resetColorCache();

      expect(red('text')).toBe('text');
      expect(theme.taskId('abc')).toBe('abc');
    });
  });

  describe('semantic formatters', () => {
    test('theme.value returns text unchanged', () => {
      expect(theme.value('hello')).toBe('hello');
    });

    test('theme.status maps statuses correctly', () => {
      // All statuses should return the status text (possibly colored)
      const statuses = ['working', 'blocked', 'complete', 'completed', 'accepted',
        'interrupted', 'abandoned', 'rejected', 'closed', 'ended'];
      for (const s of statuses) {
        expect(stripAnsi(theme.status(s))).toBe(s);
      }
    });

    test('theme.status returns unknown status unchanged', () => {
      expect(stripAnsi(theme.status('unknown'))).toBe('unknown');
    });

    test('theme.turnRole handles human and agent', () => {
      expect(stripAnsi(theme.turnRole('human'))).toBe('human');
      expect(stripAnsi(theme.turnRole('agent'))).toBe('agent');
      expect(stripAnsi(theme.turnRole('other'))).toBe('other');
    });
  });
});

describe('theme e2e - NO_COLOR in CLI', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('list output has no ANSI codes when NO_COLOR is set', async () => {
    // Create a task
    const createResult = await ctx.lazy(['create', '--goal', 'Test coloring']);
    expectSuccess(createResult);

    // List with NO_COLOR
    const result = await ctx.lazy(['list', '--all'], { env: { NO_COLOR: '1' } });
    expectSuccess(result);

    // Verify no ANSI escape codes in output
    // eslint-disable-next-line no-control-regex
    const hasAnsi = /\x1b\[/.test(result.stdout);
    expect(hasAnsi).toBe(false);
  });

  test('show output has no ANSI codes when NO_COLOR is set', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Test show coloring']);
    expectSuccess(createResult);

    // Extract task ID
    const match = createResult.stdout.match(/([a-f0-9]{8})/);
    expect(match).not.toBeNull();
    const taskId = match![1];

    const result = await ctx.lazy(['show', taskId], { env: { NO_COLOR: '1' } });
    expectSuccess(result);

    // eslint-disable-next-line no-control-regex
    const hasAnsi = /\x1b\[/.test(result.stdout);
    expect(hasAnsi).toBe(false);
  });
});
