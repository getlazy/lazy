import { describe, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';

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
    const hasAuth = result.stdout.includes('API auth configured');
    if (!hasAuth) {
      throw new Error(`Expected auth check in output\nstdout: ${result.stdout}`);
    }
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
    expectError(result, '[remote_github] section is no longer supported');
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
      // Remove the in-repo tasks dir so old check would have failed
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
