import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
import { storageDirFor, setTaskStatus, setTaskMetadata } from '../helpers/storage';
import { createStorage, type Storage } from '../../src/storage';
import { spawn } from '../../src/utils/spawn';
import { readProcessIdentity } from '../../src/utils/process-identity';
import { enrollPassphrase } from '../helpers/passphrase';

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

  // REGRESSION (fix-stranded-merging): a task whose accept died mid-merge used to
  // be invisible — `lazy doctor` said nothing and every exit refused. Doctor now
  // names the task and the remedy.
  test('reports a task stranded in merging and names the remedy', async () => {
    const create = await ctx.lazy(['create', '--goal', 'Wedged task']);
    expectSuccess(create);
    const taskId = create.stdout.match(/([0-9a-f]{8})/)![1];
    setTaskStatus(ctx.root, taskId, 'merging');
    setTaskMetadata(ctx.root, taskId, 'accept_in_flight_from', 'blocked');

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, "task(s) in 'merging'");
    expectOutput(result, 'lazy unblock');
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

  // A wedged storage lock fails EVERY lazy command, so doctor is the only place
  // left to diagnose and clear it from. Per the doctor-single-warning-surface
  // convention, the remedy lives here and nowhere else.
  describe('stale storage lock', () => {
    let holderDir: string;
    const holders: { kill: () => void }[] = [];

    beforeEach(() => {
      // The prefix deliberately avoids "lazy": the holder process runs from
      // inside this directory, and a path containing "lazy" would read as a
      // plausible lazy process to the command-line backstop.
      holderDir = mkdtempSync(join(tmpdir(), 'strg-lock-doctor-'));
    });

    afterEach(() => {
      for (const h of holders) h.kill();
      holders.length = 0;
      rmSync(holderDir, { recursive: true, force: true });
    });

    /** A real, live process that definitively never took the lock. */
    function startForeignHolder(): number {
      const binPath = join(holderDir, 'unrelated-system-daemon');
      copyFileSync('/bin/sleep', binPath);
      chmodSync(binPath, 0o755);
      const proc = spawn([binPath, '120'], { stdout: 'ignore', stderr: 'ignore' });
      holders.push({ kill: () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } } });
      return proc.pid;
    }

    function writeStorageLock(pid: number): string {
      // The lock lives in the EXTERNAL store, not <root>/.lazy — checking the
      // repo-local path is exactly the bug that let doctor miss a real wedge.
      const lockPath = join(storageDirFor(ctx.root), '.storage-lock');
      writeFileSync(lockPath, JSON.stringify({ pid, acquired_at: new Date().toISOString() }, null, 2) + '\n');
      return lockPath;
    }

    test('detects a lock whose pid was recycled to an unrelated live process', async () => {
      const lockPath = writeStorageLock(startForeignHolder());

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'is stale');
      expectOutput(result, lockPath);
      expectOutput(result, `rm ${lockPath}`);
    });

    test('detects a lock whose pid no longer exists', async () => {
      const lockPath = writeStorageLock(2_000_000);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'is stale');
      expectOutput(result, lockPath);
    });

    test('--yes clears the stale lock', async () => {
      const lockPath = writeStorageLock(startForeignHolder());

      const result = await ctx.lazy(['doctor', '--yes']);
      expectOutput(result, `Removed stale storage lock: ${lockPath}`);
      expect(existsSync(lockPath)).toBe(false);
    });

    test('--dry-run reports the removal without doing it', async () => {
      const lockPath = writeStorageLock(startForeignHolder());

      const result = await ctx.lazy(['doctor', '--dry-run']);
      expectOutput(result, `Would remove stale storage lock: ${lockPath}`);
      // No assertion that the file survives: the rest of the sweep goes on to
      // use storage, and StorageLock reclaims a lock it can prove is stale.
      // What --dry-run must not do is remove it ITSELF, which is what the
      // "Would remove" line above reports.
    });

  });

  // The other half of the wedged-lock story: a holder whose identity VERIFIES,
  // so the stale-lock path above correctly declines to reclaim it. Doctor used
  // to queue behind such a holder on every storage-backed check and then die of
  // the very problem it exists to diagnose. It must now report the holder and
  // still produce a full report.
  describe('storage lock held by a live holder', () => {
    let holderDir: string;
    const holders: { kill: () => void }[] = [];

    beforeEach(() => {
      holderDir = mkdtempSync(join(tmpdir(), 'held-lock-doctor-'));
    });

    afterEach(() => {
      for (const h of holders) h.kill();
      holders.length = 0;
      rmSync(holderDir, { recursive: true, force: true });
    });

    /**
     * Write a lock file whose holder is a REAL live process AND whose recorded
     * identity matches that process exactly — the identity fields come from the
     * same reader `checkHolder` uses, so the verdict is "alive" by construction
     * rather than by luck of the command-line backstop.
     */
    async function holdLockLive(acquiredAt: string = new Date().toISOString()): Promise<number> {
      const binPath = join(holderDir, 'wedged-lazy-holder');
      copyFileSync('/bin/sleep', binPath);
      chmodSync(binPath, 0o755);
      const proc = spawn([binPath, '120'], { stdout: 'ignore', stderr: 'ignore' });
      holders.push({ kill: () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } } });

      const identity = await readProcessIdentity(proc.pid);
      if (!identity) throw new Error(`Could not read identity of holder pid ${proc.pid}`);
      writeFileSync(
        join(storageDirFor(ctx.root), '.storage-lock'),
        JSON.stringify({
          pid: proc.pid,
          acquired_at: acquiredAt,
          holder_started_at: identity.started,
          holder_start_source: identity.startedSource,
          holder_command: identity.command,
        }, null, 2) + '\n',
      );
      return proc.pid;
    }

    test('reports the holder and still prints the rest of the report', async () => {
      const pid = await holdLockLive();

      const started = Date.now();
      const result = await ctx.lazy(['doctor']);
      const elapsedMs = Date.now() - started;

      // The lock is NOT stale — the holder verifies — so doctor must not offer
      // to remove it. Removing a live holder's lock corrupts the store.
      expectOutputExcludes(result, 'is stale');
      expectOutput(result, `held by pid ${pid}`);
      // Checks that would have queued behind the lock are named as skipped,
      // not silently dropped.
      expectOutput(result, `(skipped — storage lock held by pid ${pid})`);
      // ...and everything that does not need storage still ran.
      expectOutput(result, 'Git installed');
      expectOutput(result, 'Repository has commits');

      // The point of the whole change: bounded time. The old behaviour waited
      // out the full retry loop on EVERY storage-backed check. The ceiling here
      // is deliberately loose — it is asserting "doesn't queue", not a budget.
      expect(elapsedMs).toBeLessThan(25_000);
    }, 40_000);

    test('a freshly-taken lock is a warning, not a failure', async () => {
      await holdLockLive();

      const result = await ctx.lazy(['doctor']);
      // A busy store is normal: FileStorage takes this lock per operation, so
      // doctor must not fail a project just for catching one in flight. The
      // exit code is not asserted — other checks in this suite's environment
      // (Docker) legitimately fail, so it would not be measuring this lock.
      expectOutput(result, 'the store is busy');
      expectOutput(result, '✓ Storage lock available');
      expectOutputExcludes(result, 'Storage lock is wedged');
    }, 40_000);

    test('a lock held far longer than any operation takes is a failure', async () => {
      const pid = await holdLockLive(new Date(Date.now() - 10 * 60_000).toISOString());

      const result = await ctx.lazy(['doctor']);
      // The ✗ marker is the assertion that this check FAILED — the exit code
      // alone would not distinguish it from an unrelated failing check.
      expectOutput(result, '✗ Storage lock is wedged');
      expectOutput(result, `pid ${pid}`);
      // Aimed at the process, never at the file — see describeHeldStorageLock.
      expectOutput(result, `ps -p ${pid}`);
      expectFailure(result);
    }, 40_000);

    // INVARIANT: an age doctor cannot read is a FAILURE, not the soft "busy"
    // warning. The warning's advice is "look again if this repeats", which is
    // only useful when a re-run could answer differently — and it cannot here:
    // the damaged timestamp is on disk, so every future run downgrades itself
    // identically and an indefinitely-held lock stays invisible forever.
    test('a live holder with an unreadable acquired_at is a failure, not a warning', async () => {
      const pid = await holdLockLive();
      // Strip acquired_at, leaving the identity fields intact so the holder
      // still verifies as alive — this is the truncated-file / older-lazy shape.
      const lockPath = join(storageDirFor(ctx.root), '.storage-lock');
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
      delete lock.acquired_at;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, '✗ Storage lock age is unreadable');
      expectOutput(result, `pid ${pid}`);
      // Aimed at the process, never at the file — see describeHeldStorageLock.
      expectOutput(result, `ps -p ${pid}`);
      expectOutputExcludes(result, 'the store is busy');
      expectFailure(result);
    }, 40_000);
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

  // The approval passphrase left the repository in v0.23: it is enrolled once
  // per machine, hashed, at ~/.lazy/passphrase.json. That makes "can a gated
  // merge be approved HERE?" a machine question the project cannot answer from
  // its config — so doctor is where it gets answered.
  describe('approval passphrase checks', () => {
    test('reports enrollment when this machine has a passphrase', async () => {
      await enrollPassphrase(ctx.passphraseBaseDir, 'correct-horse-battery');

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Approval passphrase enrolled');
      // Never the hash, never the phrase — doctor output is pasted into issues.
      expectOutputExcludes(result, 'correct-horse-battery');
      expectOutputExcludes(result, '$argon2');
    });

    test('warns when protection is on but nothing is enrolled here', async () => {
      expectSuccess(await ctx.lazy(['protect', 'main', 'on']));

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'no approval passphrase is enrolled on this machine');
      expectOutput(result, 'lazy system passphrase set');
    });

    // Protection off is the default, and an unenrolled machine is then simply
    // not a finding — doctor must not nag every project about a gate nobody
    // armed.
    test('says nothing is needed when protection is off', async () => {
      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'not needed — protection is off');
    });

    // The migration's other half: the pre-v0.23 plaintext file is no longer
    // consulted, but a live secret sitting in a tree every agent can read is
    // exactly what the move was for. Flagged whether or not protection is on.
    test('flags a leftover plaintext passphrase file with the command to remove it', async () => {
      const legacy = join(ctx.root, '.lazy', 'approve-passphrase');
      writeFileSync(legacy, 'old-plaintext-secret\n');

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, 'Legacy plaintext passphrase file');
      expectOutput(result, 'NO LONGER CONSULTED');
      expectOutput(result, `rm ${legacy}`);
      // The file's CONTENTS must never be echoed by a diagnostic command.
      expectOutputExcludes(result, 'old-plaintext-secret');
    });

    // A removed key must get its migration, not a generic "unknown option"
    // that sends the human hunting for a typo.
    test('reports the removed [protection] passphrase_file key with its migration', async () => {
      const configPath = join(ctx.root, 'lazy.toml');
      const before = readFileSync(configPath, 'utf-8');
      const after = before.replace(
        '[protection]',
        '[protection]\npassphrase_file = ".lazy/approve-passphrase"',
      );
      expect(after).not.toBe(before);
      writeFileSync(configPath, after);

      const result = await ctx.lazy(['doctor']);
      expectOutput(result, "'protection.passphrase_file' is obsolete and is IGNORED");
      expectOutput(result, 'lazy system passphrase set');
      expectOutputExcludes(result, "Unknown config option 'protection.passphrase_file'");
    });
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

  /**
   * Doctor already degrades gracefully on a broken lazy.toml — it reports a
   * failed 'lazy.toml parses' check and skips the config-dependent ones. But
   * that code was unreachable in the one situation it was written for: with no
   * daemon running, an ordinary command auto-starts one first, and auto-start's
   * own credential gate calls loadConfig before it checks anything, so the CLI
   * died at the auto-start boundary and doctor never ran a single check.
   *
   * These run the real CLI with LAZY_TEST='' so the production auto-start path
   * actually executes (under LAZY_TEST it is bypassed entirely and the bug is
   * invisible), and HOME pinned to a temp dir so a developer's real daemon
   * directory is untouched. No daemon comes up: the failure happens in-process
   * before any child is spawned.
   */
  describe('degraded mode when the daemon cannot auto-start', () => {
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'lazy-doctor-degraded-'));
    });

    afterEach(() => {
      rmSync(tmpHome, { recursive: true, force: true });
    });

    /** Auto-start live, and a credential present so the ONLY fault is the config. */
    const autoStartLive = () => ({
      HOME: tmpHome,
      LAZY_TEST: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-token-for-presence-check',
    });

    function breakConfig(): void {
      writeFileSync(join(ctx.root, 'lazy.toml'), '[server]\nport = = 26024\n');
    }

    // INVARIANT: `lazy doctor` never dies of the problem it exists to diagnose.
    // A broken lazy.toml with no daemon running is precisely when a user reaches
    // for doctor, and it must answer.
    test('a broken lazy.toml does not abort doctor at the auto-start boundary', async () => {
      breakConfig();

      const result = await ctx.lazy(['doctor'], { env: autoStartLive() });

      // Doctor ran: checks that need no config are reported...
      expectOutput(result, 'Git installed');
      // ...the broken config is reported as its own failed check, with the
      // parser's line-and-cause...
      expectOutput(result, 'lazy.toml parses');
      expectOutput(result, 'port = = 26024');
      // ...and the config-dependent checks are skipped rather than silently
      // evaluated against defaults the user never chose.
      expectOutput(result, 'every config-dependent check is skipped');
      // Reaching the summary at all is the proof it did not die early.
      expectOutput(result, 'issue');
    });

    // The daemon's absence is stated, not silently papered over — a doctor run
    // that skipped daemon-backed checks without saying so would be its own
    // misdiagnosis.
    test('doctor says why it is running without a daemon', async () => {
      breakConfig();

      const result = await ctx.lazy(['doctor'], { env: autoStartLive() });

      expectError(result, 'could not be auto-started');
      expectError(result, 'Continuing without it');
      // The old behavior: a fatal `Error:` from the auto-start catch, nothing else.
      expectOutputExcludes(result, 'All good!');
    });

    // INVARIANT: doctor is the ONLY command that degrades. Auto-start failing is
    // fatal everywhere else — a command that silently runs daemon-less would
    // bypass the daemon's single-owner guarantees on storage and auth.
    test('other commands still fail hard on the same broken config', async () => {
      breakConfig();

      const result = await ctx.lazy(['list'], { env: autoStartLive() });
      expectFailure(result);
      expectError(result, 'Failed to parse');
    });
  });
});
