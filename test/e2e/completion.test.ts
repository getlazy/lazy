import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy completion', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('--zsh outputs valid zsh completion script', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, 'compdef _lazy lazy');
    expectOutput(result, '_lazy()');
    expectOutput(result, 'compadd');
  });

  test('--bash outputs valid bash completion script', async () => {
    const result = await ctx.lazy(['completion', '--bash']);
    expectSuccess(result);
    expectOutput(result, 'complete -F _lazy_completions lazy');
    expectOutput(result, '_lazy_completions()');
    expectOutput(result, 'COMPREPLY');
  });

  test('fails without --bash or --zsh', async () => {
    const result = await ctx.lazy(['completion']);
    expectFailure(result);
    expectError(result, 'Specify a shell');
  });

  test('fails with both --bash and --zsh', async () => {
    const result = await ctx.lazy(['completion', '--bash', '--zsh']);
    expectFailure(result);
    expectError(result, 'Specify only one shell');
  });

  test('--help shows usage', async () => {
    const result = await ctx.lazy(['completion', '--help']);
    expectSuccess(result);
    expectOutput(result, 'lazy completion --bash | --zsh');
    expectOutput(result, 'eval');
  });

  test('zsh script includes all expected commands', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    // Check a representative set of commands are in the completion list
    expectOutput(result, 'start');
    expectOutput(result, 'show');
    expectOutput(result, 'accept');
    expectOutput(result, 'reject');
    expectOutput(result, 'diff');
    expectOutput(result, 'list');
    expectOutput(result, 'completion');
  });

  test('bash script includes task ID completion via active --ids-only', async () => {
    const result = await ctx.lazy(['completion', '--bash']);
    expectSuccess(result);
    expectOutput(result, 'active --ids-only');
  });

  test('zsh script includes task ID completion via active --ids-only', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, 'active --ids-only');
  });

  test('zsh script includes flag completion for commands', async () => {
    const result = await ctx.lazy(['completion', '--zsh']);
    expectSuccess(result);
    expectOutput(result, '--goal');
    expectOutput(result, '--model');
    expectOutput(result, '--follow');
  });

  // REGRESSION: the COMMAND_FLAGS table drifted from the real parseFlags tables
  // — `start` was missing --effort/--runner and `create` was missing
  // --priority/--effort/--runner, so flags that have shipped for months never
  // tab-completed. These two commands are the ones a user types most.
  for (const shell of ['--bash', '--zsh'] as const) {
    test(`${shell} script completes every start and create flag`, async () => {
      const result = await ctx.lazy(['completion', shell]);
      expectSuccess(result);

      const lines = result.stdout.split('\n');
      // The flag table is emitted one line per command, as a case arm:
      //   bash: `start) flags="--model --agent ..." ;;`
      //   zsh:  `start) compadd -- --model --agent ... ;;`
      // Anchor on the case label so the top-level command list (which also
      // contains the word "start") can't match.
      const lineFor = (cmd: string) =>
        lines.find((l) => new RegExp(`^\\s*${cmd}\\)`).test(l) && l.includes('--'));

      const startLine = lineFor('start');
      expect(startLine, 'no flag line found for `start`').toBeDefined();
      for (const flag of ['--model', '--agent', '--effort', '--runner', '--follow', '--yes', '--force-local']) {
        expect(startLine!, `start completion missing ${flag}`).toContain(flag);
      }

      const createLine = lineFor('create');
      expect(createLine, 'no flag line found for `create`').toBeDefined();
      for (const flag of ['--goal', '--prompt', '--model', '--type', '--priority', '--code', '--parent', '--agent', '--effort', '--runner', '--tag']) {
        expect(createLine!, `create completion missing ${flag}`).toContain(flag);
      }
    });
  }

  // INVARIANT: completion must cover every canonical top-level command in the
  // dispatcher (src/index.ts commandMap). These were missing/added during the
  // completion audit — regressions would silently drop their command-name
  // completion.
  for (const shell of ['--bash', '--zsh'] as const) {
    test(`${shell} script completes previously-missing commands`, async () => {
      const result = await ctx.lazy(['completion', shell]);
      expectSuccess(result);
      expectOutput(result, 'chat');
      expectOutput(result, 'stop');
      expectOutput(result, 'reparent');
      expectOutput(result, 'report');
    });

    test(`${shell} script completes subcommands for system/daemon/config`, async () => {
      const result = await ctx.lazy(['completion', shell]);
      expectSuccess(result);
      // system subcommands
      expectOutput(result, 'prompts');
      expectOutput(result, 'export-dockerfile');
      // daemon subcommands
      expectOutput(result, 'restart');
      // config subcommands
      expectOutput(result, 'set get');
    });

    test(`${shell} script completes terminal-task commands via list --all --ids-only`, async () => {
      const result = await ctx.lazy(['completion', shell]);
      expectSuccess(result);
      expectOutput(result, 'list --all --ids-only');
    });
  }

  // INVARIANT: command aliases (ls/tasks/view/doc) must tab-complete and behave
  // like their canonical command. The alias mapping is sourced from
  // src/cli/command-aliases.ts so the dispatcher and completion never drift.
  for (const shell of ['--bash', '--zsh'] as const) {
    test(`${shell} script completes aliases and gives them canonical behavior`, async () => {
      const result = await ctx.lazy(['completion', shell]);
      expectSuccess(result);
      // Alias appears in command-name completion.
      expectOutput(result, 'ls');
      expectOutput(result, 'view');
      // `ls` inherits `list`'s flags; `view` inherits `show`'s flags.
      expectOutput(result, '--ids-only');
      // `view` (alias of `show`, a task-ref command) gets task-ID completion:
      // it must appear in the active-task bucket case alongside `show`.
      const bucketLine = result.stdout
        .split('\n')
        .find((l) => l.includes('show|start') || l.includes('show|'));
      if (!bucketLine || !/\bview\b/.test(bucketLine)) {
        throw new Error(`Alias 'view' missing from task-ID completion bucket: ${bucketLine}`);
      }
    });
  }

  // `logs` is not a top-level command — it is `daemon logs`. The audit removed
  // the stale top-level `logs` completion entry.
  test('bash script does not offer a stale top-level logs command', async () => {
    const result = await ctx.lazy(['completion', '--bash']);
    expectSuccess(result);
    // The command list is space-joined; a top-level `logs` token would appear
    // surrounded by spaces in the compgen -W word list on the commands line.
    const commandsLine = result.stdout
      .split('\n')
      .find((l) => l.includes('compgen -W') && l.includes('create'));
    if (commandsLine && /\blogs\b/.test(commandsLine)) {
      throw new Error(`Stale top-level 'logs' command still in completion: ${commandsLine}`);
    }
  });
});

describe('lazy active --ids-only', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('outputs nothing when no active tasks exist', async () => {
    // Create a task but don't start it — it has no session
    await createTask(ctx, 'Unstarted task');

    const result = await ctx.lazy(['active', '--ids-only']);
    expectSuccess(result);
    if (result.stdout.trim().length > 0) {
      throw new Error(`Expected empty output, got: ${result.stdout}`);
    }
  });
});

describe('lazy list --ids-only', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('outputs nothing when no tasks exist', async () => {
    const result = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result);
    // Should be empty or just whitespace
    if (result.stdout.trim().length > 0) {
      throw new Error(`Expected empty output, got: ${result.stdout}`);
    }
  });

  test('outputs task IDs one per line', async () => {
    const id1 = await createTask(ctx, 'First task');
    const id2 = await createTask(ctx, 'Second task');

    const result = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result);

    const lines = result.stdout.trim().split('\n');
    if (lines.length !== 2) {
      throw new Error(`Expected 2 lines, got ${lines.length}: ${result.stdout}`);
    }
    expectOutput(result, id1);
    expectOutput(result, id2);
  });

  test('--all --ids-only includes terminal tasks', async () => {
    const id = await createTask(ctx, 'Task to close');
    await ctx.lazy(['close', id, '--reason', 'testing']);

    // Without --all, should not appear (task is now terminal)
    const result1 = await ctx.lazy(['list', '--ids-only']);
    expectSuccess(result1);

    // With --all, should appear
    const result2 = await ctx.lazy(['list', '--all', '--ids-only']);
    expectSuccess(result2);
    expectOutput(result2, id);
  });
});
