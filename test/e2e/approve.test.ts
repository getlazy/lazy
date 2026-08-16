/**
 * E2E tests for protected branches: human-approved accepts via `lazy approve`
 * (see docs/protected-branches.md and src/protection/edge-gate.ts).
 *
 * Branch protection is an opt-in feature (OFF by default), so the plain
 * harness state already exercises the unprotected default path; these tests
 * opt in via enableProtection(). The daemon reads lazy.toml on every accept,
 * so config edits mid-test take effect immediately.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

const PASSPHRASE = 'test-approval-passphrase';

/**
 * Opt in to branch protection (OFF by default — it's an opt-in feature) and
 * enroll a passphrase. Optionally add extra keys inside the [protection]
 * section.
 */
async function enableProtection(ctx: TestContext, extraProtectionToml = ''): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  if (!toml.includes('[protection]')) {
    throw new Error('Expected lazy init template to contain a [protection] section');
  }
  await writeFile(
    tomlPath,
    toml.replace('[protection]\n', `[protection]\nenabled = true\n${extraProtectionToml}`),
  );
  await writeFile(join(ctx.root, '.lazy', 'approve-passphrase'), `${PASSPHRASE}\n`);
}

/** Create a task, run a mocked turn, and commit a file so it's ready for accept. */
async function setupBlockedTask(ctx: TestContext, name: string): Promise<string> {
  const taskId = await createTask(ctx, `Protection test ${name}`, 'Add a file');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, `${name}.txt`), 'content\n');
  ctx.git('-C', worktreePath, 'add', `${name}.txt`);
  ctx.git('-C', worktreePath, 'commit', '-m', `Add ${name}.txt`);

  return taskId;
}

describe('protected branches: lazy approve + protected accepts', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` + `accept` require a real daemon (post-v0.11: CLI goes through
    // the daemon for storage — see accept-auto-sync.test.ts for rationale).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: protection applies on the LOCAL driver too. The forge-based
  // protection check hides behind driver.needsSync and leaves local-driver
  // projects completely unprotected — this check closes that hole uniformly
  // across all drivers.
  test('local-driver accept into the protected default branch refuses without approval', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'refusal');

    // --yes must NOT bypass protection: friction applies regardless of caller.
    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'requires human approval');
    expectError(result, `lazy approve ${taskId}`);

    // The merge must not have happened.
    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('refusal');
  });

  // INVARIANT: `lazy approve` with the correct passphrase unlocks exactly one
  // accept — the recorded approval is consumed by the accept that uses it.
  test('approve with correct passphrase unlocks the accept', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'approved');

    const approveResult = await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` });
    expectSuccess(approveResult);
    expectOutput(approveResult, 'Approval recorded');

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).toContain('Protection test approved');
  });

  // INVARIANT: the approval is still SINGLE-USE. Deferring consumption to the
  // point the merge lands must not let an approval outlive the accept it paid
  // for — a completed accept leaves no live approval behind.
  test('a successful accept leaves no live approval behind', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'single-use');

    const approveResult = await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` });
    expectSuccess(approveResult);
    expectOutput(await ctx.lazy(['show', taskId]), 'Approval pending');

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    // Nothing left for a second accept to spend.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expect(show.stdout).not.toContain('Approval pending');

    const list = await ctx.lazy(['list', '--all']);
    expectSuccess(list);
    expect(list.stdout).not.toContain('[P][A]');
  }, 30000);

  test('approve with wrong passphrase is refused and does not unlock accept', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'wrong-pass');

    const approveResult = await ctx.lazy(['approve', taskId], { input: 'not-the-passphrase\n' });
    expectFailure(approveResult);
    expectError(approveResult, 'does not match');

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'requires human approval');
  });

  test('approve without an enrolled passphrase gives setup instructions', async () => {
    await enableProtection(ctx);
    await rm(join(ctx.root, '.lazy', 'approve-passphrase'));
    const taskId = await setupBlockedTask(ctx, 'no-enroll');

    const approveResult = await ctx.lazy(['approve', taskId], { input: 'whatever\n' });
    expectFailure(approveResult);
    expectError(approveResult, 'No approval passphrase is enrolled');
    expectError(approveResult, '.lazy/approve-passphrase');
  });

  // INVARIANT: pre-flight before prompting (CLAUDE.md). With nothing enrolled,
  // NO token can verify — so `lazy approve` must say so and exit BEFORE it
  // asks the human to type a secret. Do NOT "simplify" this by letting the
  // daemon's verify() produce the message: that is the bug this test pins.
  test('approve without enrollment exits without ever prompting', async () => {
    await enableProtection(ctx);
    await rm(join(ctx.root, '.lazy', 'approve-passphrase'));
    const taskId = await setupBlockedTask(ctx, 'no-prompt');

    // A TTY with a prompt default armed: if the command reached promptLine,
    // promptLine would echo its message to stdout. It must not.
    const approveResult = await ctx.lazy(['approve', taskId], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1' },
    });

    expectFailure(approveResult);
    expectError(approveResult, 'No approval passphrase is enrolled');
    expect(approveResult.stdout).not.toContain('Approval passphrase');
    expect(approveResult.stderr).not.toContain('Approval passphrase (from');
  });

  // The interactive prompt names its source of truth, from the configured
  // path — a bare "Approval passphrase" leaves the human guessing what is
  // being checked and where to change it.
  test('the interactive prompt names the passphrase file', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'prompt-path');

    // LAZY_PROMPT_DEFAULTS makes promptLine echo its message and return the
    // (absent) default, so the command fails on the empty token afterwards.
    const approveResult = await ctx.lazy(['approve', taskId], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1' },
    });

    expectOutput(approveResult, 'Approval passphrase (from .lazy/approve-passphrase)');
    expectFailure(approveResult);
    expectError(approveResult, 'must not be empty');
  });

  // The prompt path follows [protection].passphrase_file, not a hardcoded
  // string.
  test('the prompt names a custom configured passphrase file', async () => {
    await enableProtection(ctx, 'passphrase_file = ".lazy/custom-pass"\n');
    await writeFile(join(ctx.root, '.lazy', 'custom-pass'), `${PASSPHRASE}\n`);
    const taskId = await setupBlockedTask(ctx, 'custom-path');

    const approveResult = await ctx.lazy(['approve', taskId], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1' },
    });

    expectOutput(approveResult, 'Approval passphrase (from .lazy/custom-pass)');
  });

  // INVARIANT: piped stdin is the supported CI/scripting path — there is no
  // --yes and no --passphrase flag, so this must keep working.
  test('piped stdin remains the script-friendly approval path', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'piped');

    // No TTY, passphrase piped exactly as CI would from a secret.
    const approveResult = await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` });
    expectSuccess(approveResult);
    expectOutput(approveResult, 'Approval recorded');
    // Nothing was prompted for.
    expect(approveResult.stdout).not.toContain('Approval passphrase (from');

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));
  }, 30000);

  // INVARIANT: the passphrase prompt is MASKED, so it needs a real TTY. When
  // it cannot have one it refuses loudly and names the piped route — it must
  // never fall back to an echoing line reader, which is the bug the mask
  // exists to fix. (LAZY_FORCE_TTY makes isTTY() true without a real TTY, so
  // this exercises exactly that gap.)
  test('the passphrase prompt refuses rather than echoing when it cannot mask', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'no-mask');

    const approveResult = await ctx.lazy(['approve', taskId], {
      env: { LAZY_FORCE_TTY: '1' },
    });

    expectFailure(approveResult);
    expectError(approveResult, 'not an interactive terminal');
    expectError(approveResult, 'pipe the value instead');
  }, 30000);

  // INVARIANT: an approval is scoped to its task — approving task A does not
  // unlock a protected accept of task B.
  test('approval of one task does not unlock another task', async () => {
    await enableProtection(ctx);
    const taskA = await setupBlockedTask(ctx, 'task-a');
    const taskB = await setupBlockedTask(ctx, 'task-b');

    const approveResult = await ctx.lazy(['approve', taskA], { input: `${PASSPHRASE}\n` });
    expectSuccess(approveResult);

    const acceptB = await ctx.lazy(['accept', taskB, '--yes']);
    expectFailure(acceptB);
    expectError(acceptB, 'requires human approval');

    const acceptA = await ctx.lazy(['accept', taskA, '--yes']);
    expectSuccess(acceptA);
  }, 30000);

  // INVARIANT: subtask→`lazy/*` intermediate-parent merges stay unprotected
  // and local — protection adds no friction to the inner loop.
  test('subtask accept into a lazy/* parent branch needs no approval', async () => {
    await enableProtection(ctx);

    const parentId = await setupBlockedTask(ctx, 'protected-parent');

    // Create a child task under the parent (its merge target is the parent's
    // lazy/* branch, not the default branch).
    const branchResult = await ctx.lazyMocked(
      ['branch', parentId, '--goal', 'Child of protected parent', '--prompt', 'Do child work', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(branchResult);
    const childIdMatch = branchResult.stdout.match(/Created variant task ([a-f0-9]{8})/);
    if (!childIdMatch) throw new Error(`No child task id in: ${branchResult.stdout}`);
    const childId = childIdMatch[1];
    expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);

    const childWorktree = join(ctx.root, '.lazy', 'worktrees', childId);
    writeFileSync(join(childWorktree, 'child.txt'), 'child\n');
    ctx.git('-C', childWorktree, 'add', 'child.txt');
    ctx.git('-C', childWorktree, 'commit', '-m', 'Add child.txt');

    const acceptResult = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  }, 30000);

  // INVARIANT: branch protection is OPT-IN. In the default state (no
  // [protection] config touched — enabled defaults to false) accepts into
  // the default branch complete unprotected, exactly as before the feature
  // existed.
  test('default state: accepts into the default branch need no approval', async () => {
    // Deliberately NO enableProtection() call — this exercises the defaults.
    const taskId = await setupBlockedTask(ctx, 'default-off');

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  });

  // INVARIANT: flipping the single master switch back off turns ALL
  // protection off — the one obvious knob for toggling while experimenting.
  test('setting enabled = false turns protection back off', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'toggle-off');

    // Protected while enabled...
    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));

    // ...unprotected after flipping the switch off.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, toml.replace('enabled = true', 'enabled = false'));

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  }, 30000);
});

/**
 * INVARIANT: approval consumption is atomic with accept completion.
 *
 * An accept that FAILS after passing the branch-protection gate must leave the
 * human's one-shot approval intact, so the retry needs no second
 * `lazy approve`. Observed live (2026-08-15): a human approved a task merging
 * into protected `main`; two accepts failed (one in pre-flight, one at the
 * merge on a dirty destination) and the next accept was refused with "No
 * approval recorded" — the approval had been spent by an accept that merged
 * nothing. The gate used to CONSUME the record while checking it; it now only
 * RESERVES it, and accept spends it where the merge becomes durable.
 *
 * Its own describe block because it needs the mock remote driver active on the
 * daemon (LAZY_MOCK_ACCEPT_GATES='[]'), which is a suite-level setting: a
 * blocking pre-merge gate is the deterministic way to fail an accept at a phase
 * AFTER the protection gate, and the gate list is varied per test through
 * <protocolBase>/mock-accept-gates.json (see accept-gates.test.ts).
 */
describe('protected branches: a failed accept does not spend the approval', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_ACCEPT_GATES: '[]' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Gate warnings the daemon's mock driver picks up on the next accept. */
  function setGates(gates: Array<{ gate: string; message: string }>) {
    writeFileSync(join(ctx.protocolBase, 'mock-accept-gates.json'), JSON.stringify(gates));
  }

  test('the approval survives a failed accept and unlocks the retry', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'survives');

    const approveResult = await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` });
    expectSuccess(approveResult);

    // Fail the accept at the pre-merge gates — well past the protection gate.
    setGates([{ gate: 'ci', message: 'CI checks failing: lint, test' }]);

    const failed = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(failed);
    expectError(failed, 'Merge blocked by pre-merge gates');
    // The failure must SAY the approval survived — silence here is what sent
    // the human back to `lazy approve` for an approval they still had.
    expectError(failed, 'was NOT consumed');

    // The approval is still recorded and pending.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'Approval pending');

    // Fix the cause, then retry WITHOUT approving again.
    setGates([]);

    const retry = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(retry);
    expectOutput(retry, 'accepted and merged');
  }, 30000);

  // The approval survives repeated failures, not just the first one — the
  // reported incident took two failed accepts to burn it.
  test('repeated failed accepts leave the approval intact', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'twice');

    expectSuccess(await ctx.lazy(['approve', taskId], { input: `${PASSPHRASE}\n` }));

    setGates([{ gate: 'ci', message: 'CI checks failing: lint, test' }]);
    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));
    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));

    expectOutput(await ctx.lazy(['show', taskId]), 'Approval pending');

    setGates([]);
    const retry = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(retry);
    expectOutput(retry, 'accepted and merged');
  }, 30000);
});
