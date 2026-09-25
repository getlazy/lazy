/**
 * E2E tests for protected branches: the inline approval passphrase at
 * `lazy accept` (see docs/protected-branches.md and
 * src/protection/edge-gate.ts).
 *
 * There is no `lazy approve` and no stored approval any more: a protected
 * accept prompts for the passphrase and merges in the same invocation, so the
 * approval is bound to the exact commits being merged. The passphrase is
 * TTY-only BY DESIGN — no flag, no env var, no stdin route (stdin is the
 * accept REASON). Tests drive the masked prompt through the test-only
 * LAZY_PROMPT_DEFAULTS / LAZY_PROMPT_SECRET pair.
 *
 * Branch protection is an opt-in feature (OFF by default), so the plain
 * harness state already exercises the unprotected default path; these tests
 * opt in via enableProtection(). The daemon reads lazy.toml on every accept,
 * so config edits mid-test take effect immediately.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { enrollPassphrase, clearPassphrase } from '../helpers/passphrase';
import { seedFinal } from '../helpers/final';

const PASSPHRASE = 'test-approval-passphrase';

/**
 * Env that drives the masked passphrase prompt as if a human typed the
 * correct passphrase at a TTY. LAZY_PROMPT_DEFAULTS='1' also makes the accept
 * REASON prompt return its default, so the flow stays fully non-blocking.
 */
const TYPES_PASSPHRASE = {
  LAZY_FORCE_TTY: '1',
  LAZY_PROMPT_DEFAULTS: '1',
  LAZY_PROMPT_SECRET: PASSPHRASE,
};

/**
 * Opt in to branch protection (OFF by default — it's an opt-in feature) and
 * enroll a passphrase on the "machine".
 *
 * The two halves are deliberately independent: the config lives in the repo,
 * the passphrase lives in the machine-global hashed store (pinned to this
 * context's temp base dir), and neither knows about the other.
 */
async function enableProtection(ctx: TestContext): Promise<void> {
  await enableProtectionConfigOnly(ctx);
  await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);
}

/** Turn protection on in lazy.toml WITHOUT enrolling anything. */
async function enableProtectionConfigOnly(ctx: TestContext): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  if (!toml.includes('[protection]')) {
    throw new Error('Expected lazy init template to contain a [protection] section');
  }
  await writeFile(tomlPath, toml.replace('[protection]\n', '[protection]\nenabled = true\n'));
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

  // Fixture setup, not the subject: the finality gate needs a standing final
  // before any accept of a committed task (see test/helpers/final.ts).
  await seedFinal(ctx, taskId);

  return taskId;
}

describe('protected branches: inline passphrase at lazy accept', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` + `accept` require a real daemon (post-v0.11: CLI goes through
    // the daemon for storage — see accept-auto-sync.test.ts for rationale).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: protection applies on the LOCAL driver too, and --yes skips
  // prompts, NOT the gate. Without a TTY there is no way to supply the
  // passphrase — deliberately: no flag, no env var, no stdin route — so a
  // non-interactive protected accept refuses and names the interactive route.
  test('non-interactive accept of a protected merge refuses and points at a terminal', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'refusal');

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    expectError(result, 'approval passphrase');
    expectError(result, 'from a terminal');

    // The merge must not have happened.
    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('refusal');
  });

  // INVARIANT: the passphrase typed at accept's own prompt approves and merges
  // in ONE invocation — no second command, no stored token.
  test('typing the correct passphrase at the prompt merges in the same invocation', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'approved');

    const acceptResult = await ctx.lazy(['accept', taskId], { env: TYPES_PASSPHRASE });
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');

    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).toContain('Protection test approved');
  });

  test('a wrong passphrase is refused and nothing merges', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'wrong-pass');

    const acceptResult = await ctx.lazy(['accept', taskId], {
      env: { ...TYPES_PASSPHRASE, LAZY_PROMPT_SECRET: 'not-the-passphrase' },
    });
    expectFailure(acceptResult);
    expectError(acceptResult, 'does not match');

    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('wrong-pass');
  });

  // INVARIANT: pre-flight before prompting (CLAUDE.md). With nothing enrolled,
  // NO passphrase can verify — so accept must say so and exit BEFORE it asks
  // the human to type a secret. Do NOT "simplify" this by letting the gate's
  // verify() produce the message after the prompt: that is the bug this pins.
  test('accept without enrollment exits with instructions, without ever prompting', async () => {
    await enableProtectionConfigOnly(ctx);
    await clearPassphrase(ctx.passphraseBaseDir);
    const taskId = await setupBlockedTask(ctx, 'no-enroll');

    const acceptResult = await ctx.lazy(['accept', taskId], { env: TYPES_PASSPHRASE });

    expectFailure(acceptResult);
    expectError(acceptResult, 'No approval passphrase is enrolled');
    expectError(acceptResult, 'lazy system passphrase set');
    expect(acceptResult.stdout).not.toContain('Approval passphrase');
  });

  // INVARIANT: the gate is decided from COMMITTED CONFIG ALONE. A fresh clone
  // of a protected repo on a machine that has never enrolled is protected —
  // and fails CLOSED, with instructions, rather than merging because the local
  // machine happens to have no credential.
  test('a protected repo on a never-enrolled machine fails closed, not open', async () => {
    await enableProtectionConfigOnly(ctx);
    const taskId = await setupBlockedTask(ctx, 'never-enrolled');

    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(acceptResult);
    expectError(acceptResult, 'lazy system passphrase set');
    const log = ctx.git('log', '--oneline', 'main');
    expect(log.stdout).not.toContain('never-enrolled');
  });

  // The prompt names NOTHING to read: the passphrase lives in the human's
  // memory and the store holds only a hash, so a "(from <path>)" suffix would
  // invite them to go cat a secret that no longer exists anywhere in the repo.
  test('the prompt names no file, and an empty entry refuses', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'prompt-path');

    // LAZY_PROMPT_SECRET unset: the driven masked prompt "types" nothing.
    const acceptResult = await ctx.lazy(['accept', taskId], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: '1' },
    });

    expectOutput(acceptResult, 'Approval passphrase');
    expect(acceptResult.stdout).not.toContain('Approval passphrase (from');
    expectFailure(acceptResult);
    expectError(acceptResult, 'passphrase is required');
  });

  // INVARIANT: the passphrase is machine-global and hashed — a plaintext file
  // in the repo is NOT a credential any more, however tempting the old path
  // looks. Re-creating it must not unlock anything.
  test('a leftover plaintext .lazy/approve-passphrase does not satisfy the gate', async () => {
    await enableProtectionConfigOnly(ctx);
    await writeFile(join(ctx.root, '.lazy', 'approve-passphrase'), `${PASSPHRASE}\n`);
    const taskId = await setupBlockedTask(ctx, 'legacy-file');

    const acceptResult = await ctx.lazy(['accept', taskId], { env: TYPES_PASSPHRASE });

    expectFailure(acceptResult);
    expectError(acceptResult, 'No approval passphrase is enrolled');
    // ...and the human is told the stale file is dead, not silently left with it.
    expectError(acceptResult, 'no longer consulted');
  });

  // INVARIANT: the passphrase prompt is MASKED, so it needs a real TTY. When
  // it cannot have one it refuses loudly — it must never fall back to an
  // echoing line reader, which is the bug the mask exists to fix. And unlike
  // other secrets there is no piped route to point at: stdin is the accept
  // REASON. (LAZY_FORCE_TTY makes isTTY() true without a real TTY, so this
  // exercises exactly that gap.)
  test('the passphrase prompt refuses rather than echoing when it cannot mask', async () => {
    await enableProtection(ctx);
    const taskId = await setupBlockedTask(ctx, 'no-mask');

    // The reason comes via --reason so the flow reaches the passphrase prompt
    // without blocking on the (forced-TTY) reason prompt first.
    const acceptResult = await ctx.lazy(['accept', taskId, '--reason', 'looks good'], {
      env: { LAZY_FORCE_TTY: '1' },
    });

    expectFailure(acceptResult);
    expectError(acceptResult, 'not an interactive terminal');
  }, 30000);

  // INVARIANT: nothing is stored. Approving one accept with the passphrase
  // leaves no record that could unlock a different task's protected accept —
  // the floating-credential hazard the inline design removes by construction.
  test('a passphrase accept leaves nothing that unlocks another task', async () => {
    await enableProtection(ctx);
    const taskA = await setupBlockedTask(ctx, 'task-a');
    const taskB = await setupBlockedTask(ctx, 'task-b');

    const acceptA = await ctx.lazy(['accept', taskA], { env: TYPES_PASSPHRASE });
    expectSuccess(acceptA);

    const acceptB = await ctx.lazy(['accept', taskB, '--yes']);
    expectFailure(acceptB);
    expectError(acceptB, 'approval passphrase');
  }, 30000);

  // INVARIANT: `lazy approve` is GONE — removed completely, no shim, no
  // deprecated alias. The dispatcher treats it as an unknown command.
  test('lazy approve no longer exists', async () => {
    await enableProtection(ctx);

    const result = await ctx.lazy(['approve', 'whatever']);
    expectFailure(result);
    expectError(result, 'Unknown command');
  });

  // INVARIANT: subtask→`lazy/*` intermediate-parent merges stay unprotected
  // and local — protection adds no friction to the inner loop.
  test('subtask accept into a lazy/* parent branch needs no passphrase', async () => {
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

    // Fixture setup, not the subject: the finality gate needs a standing final
    // before any accept of a committed task (see test/helpers/final.ts).
    await seedFinal(ctx, childId);

    const acceptResult = await ctx.lazy(['accept', childId, '--yes']);
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'accepted and merged');
  }, 30000);

  // INVARIANT: branch protection is OPT-IN. In the default state (no
  // [protection] config touched — enabled defaults to false) accepts into
  // the default branch complete unprotected, exactly as before the feature
  // existed.
  test('default state: accepts into the default branch need no passphrase', async () => {
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
