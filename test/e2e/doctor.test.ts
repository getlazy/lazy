import { describe, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
import { createStorage, type Storage } from '../../src/storage';

describe('lazy doctor', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('runs and reports git check', async () => {
    const result = await ctx.lazy(['doctor']);
    // Git should always be available in tests
    expectOutput(result, 'Git installed');
  });

  test('reports repository has commits', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Repository has commits');
  });

  test('reports data directory valid in initialized project', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Data directory valid');
  });

  // `lazy doctor` is the single surface that spells out the memory-context size
  // advisory: launches only print a generic "run lazy doctor" line, so the
  // diagnosis and the remedy have to be here.
  describe('injected memory context check', () => {
    test('reports no records in a fresh project', async () => {
      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Injected memory context (no records)');
    });

    test('reports size, threshold and compact state when under the threshold', async () => {
      expectSuccess(await ctx.lazy(['memory', 'save', 'deploy-window', '-t', 'project',
        '-d', 'Deploys are Tue/Thu 10am', '-b', 'Body']));

      const result = await ctx.lazy(['doctor']);
      // Size / budget are reported even when healthy, so the human can see the
      // headroom rather than only ever hearing about it once it is gone.
      expectOutput(result, 'Injected memory context');
      expectOutput(result, 'of 4.0KB');
      expectOutput(result, '1 record(s), no compact');
      // Healthy means no advisory noise at all.
      expectOutputExcludes(result, 'advisory threshold');
    });

    test('names the compact and its staleness once one exists', async () => {
      // Enough records that mechanical compaction actually shrinks the injected
      // context — a compact that would grow it is rejected, so a one-record
      // store cannot produce one. Seeded in-process; 60 CLI calls would be slow.
      const storage: Storage = await createStorage(ctx.root, { backend: 'external' });
      try {
        for (let i = 0; i < 60; i++) {
          await storage.saveMemory({
            name: `store-record-number-${i}`,
            description: `A typical one-line description for record ${i} of the shared memory store.`,
            type: 'project',
            body: `Body for record ${i}.`,
          }, 'human');
        }
      } finally {
        await storage.close();
      }
      expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

      const result = await ctx.lazy(['doctor']);
      // Generator and watermark, so "is my newest memory in there?" is answerable.
      expectOutput(result, '(mechanical, covering 60 record(s))');
      expectOutput(result, '0 written since, 0 removed since');
    });

    // INVARIANT: the threshold is advisory. Over it, doctor warns with the full
    // diagnosis but the check still passes — memory past the threshold is still
    // knowledge, so it is never a health failure and never truncated.
    test('over the threshold it warns with the diagnosis but does not fail', async () => {
      for (let i = 0; i < 12; i++) {
        expectSuccess(await ctx.lazy(['memory', 'save', `record-${i}`, '-t', 'project',
          '-d', `Fact number ${i} — ${'D'.repeat(150)}`, '-b', 'Body']));
      }
      const configPath = join(ctx.root, 'lazy.toml');
      writeFileSync(configPath, `${await Bun.file(configPath).text()}\n[memory]\nwarn_bytes = 256\n`);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'over the 256B advisory threshold');
      expectOutput(result, 'Nothing is blocked or truncated');
      expectOutput(result, '12 live record(s)');
      expectOutput(result, 'No compact');
      expectOutput(result, 'lazy memory compact');
    });
  });

  test('reports no stale locks in fresh project', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No stale locks');
  });

  test('reports no stale storage lock in fresh project', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No stale storage lock');
  });

  test('reports auth status', async () => {
    const result = await ctx.lazy(['doctor']);
    // Auth may or may not be configured in test env; just check the check ran
    const hasAuth = result.stdout.includes('Model credential present');
    if (!hasAuth) {
      throw new Error(`Expected auth check in output\nstdout: ${result.stdout}`);
    }
  });

  // INVARIANT: the credential check must never present the CLI process's own
  // environment as if it were the daemon's. This suite is daemonless, so the
  // answer necessarily comes from the shell — and it must say so.
  test('names the shell as the source when the daemon cannot be asked', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'shell env:');
    expectOutput(result, "not the daemon's");
  });

  test('shows help with --help flag', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Usage: lazy doctor');
    expectOutput(result, 'Check the health');
  });

  test('shows summary line', async () => {
    const result = await ctx.lazy(['doctor']);
    // Should have either "All good!" or "issue(s) found"
    const hasSummary = result.stdout.includes('All good!') || result.stdout.includes('issue');
    if (!hasSummary) {
      throw new Error(`Expected summary line in output\nstdout: ${result.stdout}`);
    }
  });

  test('shows remote driver status for default (local) config', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Remote driver: local');
  });

  test('shows github driver health checks', async () => {
    // Configure the github driver
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `[remote]\ndriver = "github"\n`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Remote driver: github');
    // Should report at least one health check (gh CLI installed/not, auth, etc.)
    // The specific checks depend on the test environment
    const hasHealthCheck = result.stdout.includes('gh CLI') ||
                           result.stdout.includes('GitHub authentication') ||
                           result.stdout.includes('Git remote origin');
    if (!hasHealthCheck) {
      throw new Error(`Expected driver health check in output\nstdout: ${result.stdout}`);
    }
  });

  test('help text mentions remote driver checks', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Remote driver health');
  });

  test('warns about unknown config keys', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `[models]\ndefualt = "opus"\n`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, "Unknown config option 'models.defualt'");
  });

  test('warns about unknown config sections', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `[bogus_section]\nfoo = "bar"\n`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, "Unknown config section '[bogus_section]'");
  });

  test('rejects legacy [remote_github] section', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `[remote_github]\nauto_push = true\n`);

    const result = await ctx.lazy(['doctor']);
    expectFailure(result);
    // `lazy doctor` deliberately does NOT crash on an unparseable lazy.toml —
    // diagnosing bad config is its job, so it renders the loader's error as a
    // failed "lazy.toml parses" check on stdout (see runDoctor in
    // src/cli/commands/doctor.ts) and exits non-zero. The message is stdout
    // detail, not stderr.
    expectOutput(result, '[remote_github] section is no longer supported');
  });

  test('warns about deprecated remote keys', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, `[remote]\ndriver = "github"\ntoken_env = "GITHUB_TOKEN"\n`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, "'remote.token_env' is obsolete");
    expectOutput(result, 'gh auth login');
  });

  test('clean config shows no unknown or deprecated warnings', async () => {
    // Default config from lazy init should be clean
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'No unknown config options');
    expectOutput(result, 'No deprecated config options');
  });

  test('shows shell detection status', async () => {
    const result = await ctx.lazy(['doctor']);
    // Shell detection should always run and produce a result
    expectOutput(result, 'Shell detected');
  });

  test('shows completions installed status', async () => {
    const result = await ctx.lazy(['doctor']);
    // Completions check should always produce a result
    expectOutput(result, 'Completions installed');
  });

  test('help text mentions shell and completion checks', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, 'Shell detected and completions installed');
  });

  test('data directory valid with external storage pointing to existing tasks dir', async () => {
    // Create a temp external storage dir with a tasks/ subdirectory
    const extDir = mkdtempSync(join(tmpdir(), 'lazy-ext-'));
    mkdirSync(join(extDir, 'tasks'));

    try {
      // Remove any stale tasks dir so old check would have failed
      rmSync(join(ctx.root, '.lazy', 'tasks'), { recursive: true, force: true });

      // Configure external storage pointing to our temp dir
      const configPath = join(ctx.root, 'lazy.toml');
      writeFileSync(configPath, `[storage]\nbackend = "external"\nexternal_path = "${extDir}"\n`);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Data directory valid');
      expectOutputExcludes(result, 'tasks/ directory missing');
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });

  test('data directory invalid when external storage tasks dir missing', async () => {
    // Create a temp external storage dir WITHOUT tasks/
    const extDir = mkdtempSync(join(tmpdir(), 'lazy-ext-'));

    try {
      // Configure external storage pointing to empty dir
      const configPath = join(ctx.root, 'lazy.toml');
      writeFileSync(configPath, `[storage]\nbackend = "external"\nexternal_path = "${extDir}"\n`);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'tasks/ directory missing');
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });
});
