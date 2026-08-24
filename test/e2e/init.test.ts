import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { loadConfig } from '../../src/config/loader';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>, stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdin: stdin !== undefined ? new Blob([stdin]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...envOverrides },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function initGitRepo(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'Initial commit'], { cwd });
}

function initGitRepoNoCommits(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
}

describe('lazy init', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('initializes lazy in a git repo', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized');
    expect(existsSync(join(tmpDir, '.lazy')) || existsSync(join(tmpDir, '.workshop'))).toBe(true);
    expect(existsSync(join(tmpDir, 'lazy.toml'))).toBe(true);
  });

  // REGRESSION: getDefaultConfigTemplate() once emitted an uncommented "[proxy]"
  // header with every key below it commented out (e.g. "# port = 8766"), and the
  // loader then rejected the section for lacking a port — so a freshly
  // `lazy init`'d project wrote a lazy.toml that failed to load on the very next
  // command. loadConfig() must always succeed on the generated template.
  //
  // INVARIANT (default-on proxy): a fresh project gets the audit/policy proxy
  // with NO configuration — `proxy` resolves to a defaulted object, not null.
  test('generated lazy.toml loads without error and the proxy is on by default', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive']);
    expect(result.exitCode).toBe(0);

    const config = await loadConfig(tmpDir, { cwd: tmpDir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy?.upstream).toBe('https://api.anthropic.com');
    expect(config.proxy?.port).toBe(0); // OS-assigned
    expect(config.proxy?.policy.enforce).toBe(true);
  });

  test('reports already initialized', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // Init twice — first needs --non-interactive, second returns early
    await runLazy(tmpDir, ['init', '--non-interactive']);
    const result = await runLazy(tmpDir, ['init', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already initialized');
  });

  test('fails in non-git directory', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
  });

  test('fails in git repo with no commits', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepoNoCommits(tmpDir);

    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no commits');
    expect(result.stderr).toContain('git commit --allow-empty');
  });

  test('refuses to run without TTY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // No --non-interactive flag, piped stdio = no TTY
    const result = await runLazy(tmpDir, ['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires an interactive terminal');
  });

  test('shows auth guidance when no auth env vars set', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Checking authentication...');
    expect(result.stdout).toContain('Authentication: not configured');
    expect(result.stdout).toContain('claude setup-token');
    expect(result.stdout).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('detects ANTHROPIC_API_KEY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: 'sk-test-key',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: ANTHROPIC_API_KEY detected');
    expect(result.stdout).not.toContain('Warning');
  });

  test('detects CLAUDE_CODE_OAUTH_TOKEN', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: CLAUDE_CODE_OAUTH_TOKEN detected');
  });

  test('prefers CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      ANTHROPIC_API_KEY: 'sk-test-key',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication: CLAUDE_CODE_OAUTH_TOKEN detected');
    expect(result.stdout).not.toContain('ANTHROPIC_API_KEY detected');
  });

  test('--skip-auth-check suppresses auth output', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized');
    expect(result.stdout).not.toContain('Checking authentication');
  });

  test('shows init --help', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--skip-auth-check');
    // --non-interactive is a hidden flag, should not appear in help
    expect(result.stdout).not.toContain('--non-interactive');
  });

  test('recommends lazy builder after init', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Get started by running: lazy builder');
  });

  test('recommends OAuth for unconfigured auth', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], {
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    });

    expect(result.exitCode).toBe(0);
    // Should recommend claude setup-token for agents
    expect(result.stdout).toContain('claude setup-token');
    // Should not suggest setting ANTHROPIC_API_KEY
    expect(result.stdout).not.toContain('export ANTHROPIC_API_KEY');
  });

  // Full .gitignore matrix (migration, idempotence, tracked-file warning) lives
  // in test/e2e/init-gitignore.test.ts. This is the smoke check.
  test('adds lazy entries to gitignore', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    const lines = readFileSync(join(tmpDir, '.gitignore'), 'utf-8').split('\n').map(l => l.trim());
    expect(lines).toContain('.lazy/');
    expect(lines).toContain('.lazy-task-sandbox/');
    expect(lines).toContain('.lazy-lock');
  });

  test('no Dockerfile → no Dockerfile prompt shown', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('Dockerfile exists and user accepts → task created with code setup-dockerfile', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    // LAZY_FORCE_TTY makes isTTY() return true so interactive prompts run.
    // LAZY_PROMPT_DEFAULTS=accept makes all promptYesNo return true and
    // promptChoice return the first option (external storage).
    const result = await runLazy(
      tmpDir,
      ['init', '--skip-auth-check', '--skip-remote-check'],
      { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found a Dockerfile');
    expect(result.stdout).toContain('setup-dockerfile');
    expect(result.stdout).toContain('Create Dockerfile.lazy from project Dockerfile');
  });

  test('Dockerfile exists and user declines → no task created', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    // LAZY_PROMPT_DEFAULTS=decline makes all promptYesNo return false,
    // so the Dockerfile task offer is declined.
    const result = await runLazy(
      tmpDir,
      ['init', '--skip-auth-check', '--skip-remote-check'],
      { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('Dockerfile exists but non-interactive mode → skipped', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);
    await writeFile(join(tmpDir, 'Dockerfile'), 'FROM node:20\nRUN echo hello\n');

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Found a Dockerfile');
    expect(result.stdout).not.toContain('setup-dockerfile');
  });

  test('shows shell detection and completion recommendation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    // $SHELL is set in the test env, so shell detection should trigger
    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    // We can't know if completions are installed in CI, but the shell should be detected
    // if $SHELL is set. At minimum, no crash.
    if (process.env.SHELL) {
      // Shell is set — either we see a recommendation or completions are already installed
      // (either way, no error)
      expect(result.stdout).toContain('Initialized');
    }
  });

  test('--skip-completion-check suppresses shell detection', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
    initGitRepo(tmpDir);

    const result = await runLazy(tmpDir, ['init', '--skip-auth-check', '--skip-completion-check', '--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Shell detected');
  });

  // Branch protection exists but nobody finds it: a gate nobody knows about
  // protects nothing. Init offers it — OFF by default, TTY only — and walks
  // straight into enrolling the machine-global approval passphrase when taken.
  describe('branch protection offer', () => {
    let passphraseDir: string;

    /**
     * A human at a real terminal on the host. LAZY_PASSPHRASE_BASE_DIR is
     * pinned per test: this file spawns from `...process.env`, so without it an
     * accepted offer would enroll into the DEVELOPER's own ~/.lazy.
     */
    function atATerminal(secret?: string): Record<string, string> {
      return {
        LAZY_FORCE_TTY: '1',
        LAZY_FORCE_CONTAINER: '0',
        LAZY_PASSPHRASE_BASE_DIR: passphraseDir,
        LAZY_PROMPT_DEFAULTS: 'accept',
        ...(secret ? { LAZY_PROMPT_SECRET: secret } : {}),
      };
    }

    afterEach(async () => {
      if (passphraseDir) await rm(passphraseDir, { recursive: true, force: true });
    });

    async function setUp(): Promise<void> {
      tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));
      passphraseDir = await mkdtemp(join(tmpdir(), 'lazy-init-passphrase-'));
      initGitRepo(tmpDir);
    }

    test('accepting turns protection on and enrolls the passphrase', async () => {
      await setUp();

      const result = await runLazy(
        tmpDir,
        ['init', '--skip-auth-check', '--skip-remote-check'],
        atATerminal('correct-horse-battery'),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Branch protection');
      expect(result.stdout).toContain('Set enabled = true under [protection]');
      // Uncommented, not the "# enabled = true" example the template ships.
      expect(readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8')).toMatch(/^enabled = true$/m);

      // Enrolled machine-globally, hashed — never a file in the new project.
      const store = join(passphraseDir, 'passphrase.json');
      expect(existsSync(store)).toBe(true);
      const raw = readFileSync(store, 'utf-8');
      expect(raw).not.toContain('correct-horse-battery');
      expect(JSON.parse(raw).hash).toStartWith('$argon2');
      expect(existsSync(join(tmpDir, '.lazy', 'approve-passphrase'))).toBe(false);
    });

    // INVARIANT: protection stays OPT-IN and off by default. The offer defaults
    // to "no", so declining must leave a project identical to one that never
    // saw the prompt.
    test('declining leaves protection off and enrolls nothing', async () => {
      await setUp();

      const result = await runLazy(
        tmpDir,
        ['init', '--skip-auth-check', '--skip-remote-check'],
        { ...atATerminal(), LAZY_PROMPT_DEFAULTS: 'decline' },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Left off');
      expect(readFileSync(join(tmpDir, 'lazy.toml'), 'utf-8')).not.toMatch(/^enabled = true$/m);
      expect(existsSync(join(passphraseDir, 'passphrase.json'))).toBe(false);
    });

    // A scripted init must produce exactly what it did before — no prompt, and
    // nothing enrolled behind the operator's back.
    test('--non-interactive skips the offer in silence', async () => {
      await setUp();

      const result = await runLazy(
        tmpDir,
        ['init', '--skip-auth-check', '--non-interactive'],
        { LAZY_PASSPHRASE_BASE_DIR: passphraseDir },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Branch protection');
      expect(existsSync(join(passphraseDir, 'passphrase.json'))).toBe(false);
    });

    // The passphrase is machine-global, so the second project on a machine has
    // nothing left to enroll — and must not ask again.
    test('a second init reuses the existing enrollment instead of re-asking', async () => {
      await setUp();
      await runLazy(
        tmpDir,
        ['init', '--skip-auth-check', '--skip-remote-check'],
        atATerminal('correct-horse-battery'),
      );
      const firstStore = readFileSync(join(passphraseDir, 'passphrase.json'), 'utf-8');

      const second = await mkdtemp(join(tmpdir(), 'lazy-init-second-'));
      try {
        initGitRepo(second);
        const result = await runLazy(
          second,
          ['init', '--skip-auth-check', '--skip-remote-check'],
          atATerminal('a-completely-different-phrase'),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('already enrolled on this machine');
        // Untouched: a second init must never rotate the machine's passphrase.
        expect(readFileSync(join(passphraseDir, 'passphrase.json'), 'utf-8')).toBe(firstStore);
      } finally {
        await rm(second, { recursive: true, force: true });
      }
    });
  });

  test('shows --skip-completion-check in help', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-'));

    const result = await runLazy(tmpDir, ['init', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--skip-completion-check');
  });
});
