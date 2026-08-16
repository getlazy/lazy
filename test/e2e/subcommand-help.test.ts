import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';

/**
 * REGRESSION: the dispatcher in src/index.ts intercepts -h/--help before the
 * command runs, so multiplexer subcommands (`lazy system export-dockerfile -h`,
 * `lazy daemon logs -h`) used to print the PARENT command's usage and their own
 * usage functions were unreachable. Each multiplexer now declares a
 * <name>SubcommandUsage map that dispatch() consults.
 *
 * INVARIANT: `lazy <multiplexer> <sub> -h` prints the SUBCOMMAND's usage;
 * bare `lazy <multiplexer> -h` still prints the parent's.
 */
describe('subcommand --help routing', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('lazy system', () => {
    test('bare -h prints the parent usage', async () => {
      for (const flag of ['-h', '--help']) {
        const result = await ctx.lazy(['system', flag]);
        expectSuccess(result);
        expectOutput(result, 'Usage: lazy system <subcommand>');
      }
    });

    test('export-dockerfile -h prints the subcommand usage', async () => {
      for (const flag of ['-h', '--help']) {
        const result = await ctx.lazy(['system', 'export-dockerfile', flag]);
        expectSuccess(result);
        expectOutput(result, 'Usage: lazy system export-dockerfile');
        expectOutputExcludes(result, 'Usage: lazy system <subcommand>');
      }
    });

    test('build/status/offline/online -h print their own usage', async () => {
      const cases: Array<[string, string]> = [
        ['build', 'Usage: lazy system build'],
        ['status', 'Usage: lazy system status'],
        ['offline', 'Usage: lazy system offline'],
        ['online', 'Usage: lazy system online'],
      ];
      for (const [sub, expected] of cases) {
        const result = await ctx.lazy(['system', sub, '-h']);
        expectSuccess(result);
        expectOutput(result, expected);
        expectOutputExcludes(result, 'Usage: lazy system <subcommand>');
      }
    });

    test('a subcommand with no dedicated usage falls back to the parent', async () => {
      const result = await ctx.lazy(['system', 'prompts', '-h']);
      expectSuccess(result);
      expectOutput(result, 'Usage: lazy system <subcommand>');
    });
  });

  describe('lazy daemon', () => {
    test('bare -h prints the parent usage', async () => {
      for (const flag of ['-h', '--help']) {
        const result = await ctx.lazy(['daemon', flag]);
        expectSuccess(result);
        expectOutput(result, 'Usage: lazy daemon <subcommand>');
      }
    });

    test('logs -h prints the subcommand usage', async () => {
      for (const flag of ['-h', '--help']) {
        const result = await ctx.lazy(['daemon', 'logs', flag]);
        expectSuccess(result);
        expectOutput(result, 'Usage: lazy daemon logs');
        expectOutputExcludes(result, 'Usage: lazy daemon <subcommand>');
      }
    });

    test('auto-budget/config -h print their own usage', async () => {
      const cases: Array<[string, string]> = [
        ['auto-budget', 'Usage: lazy daemon auto-budget'],
        ['config', 'Usage: lazy daemon config'],
      ];
      for (const [sub, expected] of cases) {
        const result = await ctx.lazy(['daemon', sub, '-h']);
        expectSuccess(result);
        expectOutput(result, expected);
        expectOutputExcludes(result, 'Usage: lazy daemon <subcommand>');
      }
    });

    test('a subcommand with no dedicated usage falls back to the parent', async () => {
      const result = await ctx.lazy(['daemon', 'start', '-h']);
      expectSuccess(result);
      expectOutput(result, 'Usage: lazy daemon <subcommand>');
    });
  });

  describe('lazy stats', () => {
    test('bare -h prints the parent usage', async () => {
      for (const flag of ['-h', '--help']) {
        const result = await ctx.lazy(['stats', flag]);
        expectSuccess(result);
        expectOutput(result, 'Usage: lazy stats <subcommand>');
      }
    });

    test('tokens/timings -h print their own usage', async () => {
      const cases: Array<[string, string]> = [
        ['tokens', 'Usage: lazy stats tokens'],
        ['timings', 'Usage: lazy stats timings'],
      ];
      for (const [sub, expected] of cases) {
        const result = await ctx.lazy(['stats', sub, '-h']);
        expectSuccess(result);
        expectOutput(result, expected);
        expectOutputExcludes(result, 'Usage: lazy stats <subcommand>');
      }
    });
  });
});
