/**
 * E2E tests for `lazy protect <branch|task> on|off` — the single CLI for
 * branch protection (see public-docs/protected-branches.md).
 *
 * Two suites, because they need different harnesses:
 *   - config editing + listing: no daemon needed (pure lazy.toml round trips)
 *   - the task-form gate: needs a real daemon, since `start`/`accept` do
 *     (post-v0.11 the CLI goes through the daemon for storage, and the accept
 *     merge — including the protection gate — runs inside it)
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { enrollPassphrase } from '../helpers/passphrase';

const PASSPHRASE = 'test-approval-passphrase';

/**
 * Env that drives the masked `lazy approve` prompt as if a human typed the
 * correct passphrase at a TTY. The passphrase is TTY-only BY DESIGN — no flag,
 * no env var, no piped-stdin route — so this test-only pair is the only way a
 * test can supply it (see test/e2e/system-passphrase.test.ts).
 */
const TYPES_PASSPHRASE = {
  LAZY_FORCE_TTY: '1',
  LAZY_PROMPT_DEFAULTS: '1',
  LAZY_PROMPT_SECRET: PASSPHRASE,
};

/** Read lazy.toml and parse its [protection] section. */
async function readProtection(ctx: TestContext): Promise<Record<string, unknown>> {
  const toml = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
  const parsed = Bun.TOML.parse(toml) as { protection?: Record<string, unknown> };
  return parsed.protection ?? {};
}

/** Opt in to protection (OFF by default) and enroll an approval passphrase. */
async function enableProtection(ctx: TestContext): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  await writeFile(tomlPath, toml.replace('[protection]\n', '[protection]\nenabled = true\n'));
  await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);
}

describe('lazy protect: lazy.toml is the one store', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: ONE STORE — protection lives in lazy.toml [protection], and
  // `lazy protect` is just a safe editor for it. There is no parallel
  // per-task or per-branch store to fall out of sync with.
  test('branch on/off round-trips through [protection].protected_branches', async () => {
    await enableProtection(ctx);

    const on = await ctx.lazy(['protect', 'release', 'on']);
    expectSuccess(on);
    expectOutput(on, 'Branch `release` is now protected');
    expect((await readProtection(ctx)).protected_branches).toEqual(['release']);

    // A second branch appends rather than replacing.
    expectSuccess(await ctx.lazy(['protect', 'staging', 'on']));
    expect((await readProtection(ctx)).protected_branches).toEqual(['release', 'staging']);

    const off = await ctx.lazy(['protect', 'release', 'off']);
    expectSuccess(off);
    expectOutput(off, 'is now unprotected');
    expect((await readProtection(ctx)).protected_branches).toEqual(['staging']);

    // Other keys survive the edits untouched.
    expect((await readProtection(ctx)).enabled).toBe(true);
  });

  // INVARIANT: editing lazy.toml must not destroy its comments — the file
  // `lazy init` writes is mostly documentation.
  test('editing preserves the comments in lazy.toml', async () => {
    const before = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    const commentLines = before.split('\n').filter((l) => l.trim().startsWith('#'));
    expect(commentLines.length).toBeGreaterThan(10);

    expectSuccess(await ctx.lazy(['protect', 'release', 'on']));

    const after = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    for (const line of commentLines) expect(after).toContain(line);
  });

  test('turning protection off for something unprotected changes nothing', async () => {
    const result = await ctx.lazy(['protect', 'release', 'off']);
    expectSuccess(result);
    expectOutput(result, 'nothing to change');
    expect((await readProtection(ctx)).protected_branches).toBeUndefined();
  });

  test('turning protection on twice is idempotent', async () => {
    expectSuccess(await ctx.lazy(['protect', 'release', 'on']));
    const again = await ctx.lazy(['protect', 'release', 'on']);
    expectSuccess(again);
    expectOutput(again, 'already protected');
    expect((await readProtection(ctx)).protected_branches).toEqual(['release']);
  });

  // INVARIANT: turning any target ON engages the opt-in master switch. Without
  // this, `lazy protect main on` — the exact command the accept tip suggests —
  // would edit a list that protects nothing, and the user would believe they
  // had gated `main`. The switch flip is announced, never silent.
  test('turning a target on engages the master switch and says so', async () => {
    const result = await ctx.lazy(['protect', 'release', 'on']);
    expectSuccess(result);
    expectOutput(result, 'enabled = true');
    const protection = await readProtection(ctx);
    expect(protection.enabled).toBe(true);
    expect(protection.protected_branches).toEqual(['release']);
  });

  // INVARIANT: `off` never touches the master switch — unprotecting one branch
  // is not the same act as disabling the feature. With protection disabled the
  // edit is still SAVED (losing the human's edit would be worse than a no-op),
  // but the command says plainly that it has no effect, and how to fix that.
  test('turning a target off warns (but still saves) while protection is disabled', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    await writeFile(
      tomlPath,
      toml.replace('[protection]\n', '[protection]\nenabled = false\nprotected_branches = ["release", "staging"]\n'),
    );

    const result = await ctx.lazy(['protect', 'release', 'off']);
    expectSuccess(result);
    expectOutput(result, 'protection is globally disabled');
    expectOutput(result, 'enabled = true');
    const protection = await readProtection(ctx);
    expect(protection.enabled).toBe(false);
    expect(protection.protected_branches).toEqual(['staging']);
  });

  test('no-args listing shows state, protected branches and protected tasks', async () => {
    await enableProtection(ctx);
    const taskId = await createTask(ctx, 'Listing test', 'Do a thing');
    expectSuccess(await ctx.lazy(['protect', 'release', 'on']));
    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));

    const result = await ctx.lazy(['protect']);
    expectSuccess(result);
    expectOutput(result, 'enabled');
    expectOutput(result, 'Protected branches');
    expectOutput(result, 'release');
    expectOutput(result, 'Protected tasks');
    expectOutput(result, taskId);
    expectOutput(result, 'Listing test');
  });

  // INVARIANT: the repo default branch is gated by [protection].gate_default_branch
  // without appearing in protected_branches. A human scanning "what is
  // protected" must see it in the list, marked as implicit — not have to
  // remember that one entry lives in a boolean elsewhere.
  test('listing shows the implicitly-gated default branch among protected branches', async () => {
    await enableProtection(ctx);
    const result = await ctx.lazy(['protect']);
    expectSuccess(result);
    expectOutput(result, 'Protected branches');
    expectOutput(result, 'implicit');
    expectOutput(result, 'gate_default_branch');
  });

  // INVARIANT: `lazy protect <default-branch> off` must never report "not
  // protected". The branch IS gated — just implicitly — and editing the list
  // cannot turn that off, so the command says what actually protects it and
  // which key lifts it.
  test('turning off the implicitly-gated default branch explains the real knob', async () => {
    await enableProtection(ctx);
    const result = await ctx.lazy(['protect', '--branch', 'main', 'off']);
    expectSuccess(result);
    expectOutput(result, 'protected as the repo default branch');
    expectOutput(result, 'gate_default_branch = false');
    expectOutputExcludes(result, 'nothing to change');
  });

  // Listing it explicitly is not a no-op — the entry outlives a later
  // `gate_default_branch = false` — so it is saved, with that said out loud.
  test('protecting the default branch explicitly is saved, and says what it adds', async () => {
    await enableProtection(ctx);
    const result = await ctx.lazy(['protect', '--branch', 'main', 'on']);
    expectSuccess(result);
    expectOutput(result, 'already protected as the repo default branch');
    expect((await readProtection(ctx)).protected_branches).toEqual(['main']);
  });

  test('no-args listing on a fresh project reports disabled and no entries', async () => {
    const result = await ctx.lazy(['protect']);
    expectSuccess(result);
    expectOutput(result, 'disabled');
    expectOutput(result, 'none');
    expectOutput(result, 'enabled = true');
  });

  // INVARIANT: a target resolves as a TASK first, then as a branch — the
  // engineer thinks in tasks. --branch forces the branch reading.
  test('a task code resolves to the task form; --branch forces the branch form', async () => {
    const taskId = await createTask(ctx, 'Task-vs-branch', 'Do a thing');

    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));
    expect((await readProtection(ctx)).protected_tasks).toEqual([taskId]);
    expect((await readProtection(ctx)).protected_branches).toBeUndefined();

    expectSuccess(await ctx.lazy(['protect', '--branch', taskId, 'on']));
    expect((await readProtection(ctx)).protected_branches).toEqual([taskId]);
  });

  test('--task on a non-task target fails instead of guessing', async () => {
    const result = await ctx.lazy(['protect', '--task', 'no-such-thing', 'on']);
    expectFailure(result);
    expectError(result, 'no task matches');
  });

  test('a missing or bad action is rejected', async () => {
    expectFailure(await ctx.lazy(['protect', 'release']));
    const bad = await ctx.lazy(['protect', 'release', 'maybe']);
    expectFailure(bad);
    expectError(bad, "expected 'on' or 'off'");
  });
});

/**
 * A stale `protected_tasks` entry gates NOTHING — the accept path fails open
 * rather than blocking every accept on a config typo. That makes it a gate the
 * human believes is armed but isn't, so `lazy doctor` must name it. These
 * tests pin the loud half of that trade.
 */
describe('lazy doctor: stale protected_tasks entries', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Append raw keys inside the [protection] section of lazy.toml. */
  async function writeProtection(ctx: TestContext, extra: string): Promise<void> {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, toml.replace('[protection]\n', `[protection]\nenabled = true\n${extra}`));
  }

  test('a project with no protected tasks reports the check as trivially clean', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Protected tasks resolvable (none configured)');
  });

  // INVARIANT: doctor names each stale code AND its fix — a warning that
  // doesn't say what to do is just noise.
  test('names a protected task that matches no task, with the fix', async () => {
    await writeProtection(ctx, 'protected_tasks = ["ghost-task"]\n');

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'protected_tasks');
    expectOutput(result, 'ghost-task');
    expectOutput(result, 'matches no task');
    expectOutput(result, 'lazy protect <code> off');
  });

  // A task that exists but was never started has no branch, so there is
  // nothing to gate on — distinct from "deleted", and said differently.
  test('names a protected task that has never been started', async () => {
    const taskId = await createTask(ctx, 'Never started', 'Do a thing');
    await writeProtection(ctx, `protected_tasks = ["${taskId}"]\n`);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, taskId);
    expectOutput(result, 'has no branch yet');
  });

  // INVARIANT: report-only. A stale config entry is not a broken repo, so the
  // check never turns into a hard failure of its own.
  test('the check is report-only — it reports ok even while warning', async () => {
    await writeProtection(ctx, 'protected_tasks = ["ghost-task"]\n');

    const result = await ctx.lazy(['doctor']);
    // The check's own line is a pass (✓/ok), with the detail as a warning.
    expectOutput(result, 'Protected tasks resolvable');
    expectOutputExcludes(result, 'Protected tasks resolvable (none configured)');
  });

  test('mentions the stale check in help text', async () => {
    const result = await ctx.lazy(['doctor', '--help']);
    expectSuccess(result);
    expectOutput(result, 'protected_tasks');
  });

  // INVARIANT: the implicit default-branch gate is resolved from
  // refs/remotes/<remote>/HEAD at accept time and falls back to the literal
  // "main" when that ref is missing. That is a gate the human believes is
  // armed but may not be — same failure mode as a stale protected_tasks
  // entry, so doctor names it and its one-line fix.
  test('warns when the default branch cannot be resolved from the remote', async () => {
    await writeProtection(ctx, '');

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Default-branch protection');
    expectOutput(result, 'git remote set-head');
  });

  // Costs no git call and says so when there is nothing to check.
  test('skips the default-branch check when protection is off', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Default-branch protection (not enabled)');
  });

  // INVARIANT: protection is opt-in, so being off is the normal state — doctor
  // must NOT nag a project that simply never turned it on.
  test('no warning when protection was never turned on and nothing is configured', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'Protection off');
    expectOutputExcludes(result, 'have no effect');
  });

  // The combination that IS likely a mistake: gate keys configured while the
  // master switch is off, so they gate nothing.
  test('warns when gate keys are configured while the master switch is off', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    await writeFile(
      tomlPath,
      toml.replace('[protection]\n', '[protection]\nprotected_branches = ["release"]\n'),
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'have no effect');
    expectOutput(result, 'protected_branches');
    expectOutput(result, 'lazy protect');
  });

  // The same warning, for the explicit opt-out — the wording differs because
  // the human's expressed intent differs.
  test('warns when an explicit opt-out sits next to gate keys', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    await writeFile(
      tomlPath,
      toml.replace('[protection]\n', '[protection]\nenabled = false\nprotected_branches = ["release"]\n'),
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'explicitly disabled');
    expectOutput(result, 'have no effect');
  });
});

describe('lazy protect: the task form gates that task\'s accept', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create a task, run a mocked turn, and commit a file so it can be accepted. */
  async function setupBlockedTask(name: string): Promise<string> {
    const taskId = await createTask(ctx, `Protect test ${name}`, 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, `${name}.txt`), 'content\n');
    ctx.git('-C', worktreePath, 'add', `${name}.txt`);
    ctx.git('-C', worktreePath, 'commit', '-m', `Add ${name}.txt`);
    return taskId;
  }

  // INVARIANT: `lazy protect <task> on` records an OUTGOING gate — merging
  // that task's branch upward requires human approval. gate_default_branch is
  // switched off here so the ONLY thing that can gate the accept is the task
  // entry itself.
  test('a protected task refuses its own accept, naming lazy approve', async () => {
    await enableProtection(ctx);
    const tomlPath = join(ctx.root, 'lazy.toml');
    await writeFile(
      tomlPath,
      (await readFile(tomlPath, 'utf-8')).replace('enabled = true\n', 'enabled = true\ngate_default_branch = false\n'),
    );

    const taskId = await setupBlockedTask('outgoing');

    // Unprotected until the human says otherwise: prove the gate is the entry.
    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));
    expect((await readProtection(ctx)).protected_tasks).toEqual([taskId]);

    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(refused);
    expectError(refused, 'requires human approval');
    expectError(refused, 'protected_tasks');
    expectError(refused, `lazy approve ${taskId}`);

    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('outgoing');
  }, 30000);

  // INVARIANT: `lazy protect <task> off` lifts the gate it added — the CLI
  // round trip is complete, not write-only.
  test('a task gate can be lifted and the accept then completes', async () => {
    await enableProtection(ctx);
    const tomlPath = join(ctx.root, 'lazy.toml');
    await writeFile(
      tomlPath,
      (await readFile(tomlPath, 'utf-8')).replace('enabled = true\n', 'enabled = true\ngate_default_branch = false\n'),
    );

    const taskId = await setupBlockedTask('lift');
    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));
    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));

    expectSuccess(await ctx.lazy(['protect', taskId, 'off']));
    expect((await readProtection(ctx)).protected_tasks).toEqual([]);

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    expectOutput(accepted, 'accepted and merged');
  }, 30000);

  // INVARIANT: `lazy approve` satisfies the outgoing gate exactly as it does
  // the incoming one — one approval mechanism, not two.
  test('lazy approve unlocks a protected task\'s accept', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask('approve-outgoing');
    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));

    expectSuccess(await ctx.lazy(['approve', taskId], { env: TYPES_PASSPHRASE }));

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    expectOutput(accepted, 'accepted and merged');
  }, 30000);

  // The other half of the doctor check: a genuinely armed gate must NOT be
  // reported as stale. A warning that cries wolf is worse than no warning.
  test('lazy doctor does not flag a protected task that resolves to a branch', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask('doctor-clean');
    expectSuccess(await ctx.lazy(['protect', taskId, 'on']));

    const doctor = await ctx.lazy(['doctor']);
    expectOutput(doctor, 'Protected tasks resolvable (1)');
    expectOutputExcludes(doctor, 'gate nothing');
  }, 30000);
});
