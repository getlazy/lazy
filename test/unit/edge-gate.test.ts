/**
 * Unit tests for the branch-protection decision function
 * (src/protection/edge-gate.ts — internally modeled as a directed merge edge
 * source → target). Both directions ship: INCOMING ("the target is a
 * protected branch") and OUTGOING ("the source is a protected task").
 */

import { describe, test, expect } from 'bun:test';
import {
  evaluateEdgeGate,
  enforceEdgeGate,
  EdgeGateRefusedError,
  peekHumanApproval,
  recordHumanApproval,
  type ProtectionConfig,
} from '../../src/protection/edge-gate';
import type { Storage } from '../../src/storage';
import type { ResolvedConfig } from '../../src/config';

/**
 * `enabled: true` in the helper: these tests exercise the protection decision
 * logic, which only runs when the opt-in switch is on. The default-state
 * (disabled) invariant has its own tests below.
 */
function protection(overrides: Partial<ProtectionConfig> = {}): ProtectionConfig {
  return {
    enabled: true,
    protected_branches: [],
    protected_tasks: [],
    gate_default_branch: true,
    passphrase_file: '.lazy/approve-passphrase',
    ...overrides,
  };
}

describe('evaluateEdgeGate', () => {
  // INVARIANT: branch protection is OPT-IN. In the default state
  // ([protection].enabled = false, i.e. a project with no [protection]
  // section) NO merge is protected — not even a merge into the default
  // branch. Accepts behave exactly as before the feature existed.
  test('default state (enabled = false): no merge is protected, not even into main', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'main' },
      protection({ enabled: false }),
      'main',
    );
    expect(decision.gated).toBe(false);
    expect(decision.reason).toBe('');
  });

  // INVARIANT: while disabled, the master switch overrides EVERY other
  // [protection] key — an explicit protected_branches list has no effect.
  test('enabled = false overrides protected_branches', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'release' },
      protection({ enabled: false, protected_branches: ['release'] }),
      'main',
    );
    expect(decision.gated).toBe(false);
  });

  // INVARIANT: the zero-config common case — opting IN with the single
  // master switch protects the repo default branch. `enabled = true` alone
  // is enough; no branch listing required.
  test('opt-in: enabled = true protects the default branch with no branch listing', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'main' },
      protection(),
      'main',
    );
    expect(decision.gated).toBe(true);
    expect(decision.reason).toContain('default branch');
  });

  // INVARIANT: when enabled, gate_default_branch = false switches off the
  // automatic default-branch protection (leaving only the explicit list).
  test('gate_default_branch = false unprotects the default branch while enabled', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'main' },
      protection({ gate_default_branch: false }),
      'main',
    );
    expect(decision.gated).toBe(false);
  });

  // INVARIANT: subtask→intermediate-parent merges stay unprotected — no
  // friction in the inner loop.
  test('merge into a lazy/* intermediate parent is not protected', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/subtask', targetBranch: 'lazy/parent-task' },
      protection(),
      'main',
    );
    expect(decision.gated).toBe(false);
  });

  test('explicitly listed branch is protected', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'release' },
      protection({ protected_branches: ['release'] }),
      'main',
    );
    expect(decision.gated).toBe(true);
    expect(decision.reason).toContain('protected_branches');
  });

  test('branch matching is exact, not glob or prefix', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/some-task', targetBranch: 'release-v2' },
      protection({ protected_branches: ['release'] }),
      'main',
    );
    expect(decision.gated).toBe(false);
  });

  test('null default branch skips only the default-branch rule', () => {
    const gatedExplicit = evaluateEdgeGate(
      { sourceBranch: 'lazy/t', targetBranch: 'release' },
      protection({ protected_branches: ['release'] }),
      null,
    );
    expect(gatedExplicit.gated).toBe(true);

    const ungatedDefault = evaluateEdgeGate(
      { sourceBranch: 'lazy/t', targetBranch: 'main' },
      protection(),
      null,
    );
    expect(ungatedDefault.gated).toBe(false);
  });
});

describe('evaluateEdgeGate — protected tasks (outgoing)', () => {
  // INVARIANT: a protected task gates its own work going OUT, regardless of
  // the target. This is the whole point of the task form: the human protects
  // a body of work, not a destination.
  test('protected task gates its merge into an unprotected branch', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/add-auth', targetBranch: 'feature-x' },
      protection({ gate_default_branch: false, protected_tasks: ['add-auth'] }),
      'main',
      [{ listedAs: 'add-auth', branch: 'lazy/add-auth' }],
    );
    expect(decision.gated).toBe(true);
    expect(decision.reason).toContain('protected_tasks');
    expect(decision.reason).toContain('add-auth');
  });

  // INVARIANT: the outgoing gate is the deliberate exception to "subtask→
  // lazy/* parent merges are never protected". Listing a task means its work
  // needs a human to move upward — including into its parent's branch.
  test('protected task gates its merge into a lazy/* parent branch', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/child', targetBranch: 'lazy/parent-task' },
      protection({ protected_tasks: ['child'] }),
      'main',
      [{ listedAs: 'child', branch: 'lazy/child' }],
    );
    expect(decision.gated).toBe(true);
    expect(decision.reason).toContain('protected_tasks');
  });

  // INVARIANT: outgoing is about the SOURCE only — an unlisted task merging
  // into a protected task's branch is not gated by the task rule.
  test('merging INTO a protected task\'s branch is not gated by the task rule', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/other', targetBranch: 'lazy/add-auth' },
      protection({ protected_tasks: ['add-auth'] }),
      'main',
      [{ listedAs: 'add-auth', branch: 'lazy/add-auth' }],
    );
    expect(decision.gated).toBe(false);
  });

  // INVARIANT: the master switch overrides the task list too.
  test('enabled = false overrides protected_tasks', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/add-auth', targetBranch: 'main' },
      protection({ enabled: false, protected_tasks: ['add-auth'] }),
      'main',
      [{ listedAs: 'add-auth', branch: 'lazy/add-auth' }],
    );
    expect(decision.gated).toBe(false);
  });

  // A listed task that could not be resolved to a branch (deleted, or never
  // started) contributes no resolved entry and therefore gates nothing — the
  // caller warns about it instead of failing every accept.
  test('unresolvable protected task gates nothing', () => {
    const decision = evaluateEdgeGate(
      { sourceBranch: 'lazy/add-auth', targetBranch: 'feature-x' },
      protection({ gate_default_branch: false, protected_tasks: ['gone'] }),
      'main',
      [],
    );
    expect(decision.gated).toBe(false);
  });
});

/**
 * Satisfiers of the gate. A forge PR/MR approval and a `lazy approve` record
 * are two expressions of the SAME deliberate human act, resolved in one place
 * — not two parallel protection mechanisms (P0.2c).
 *
 * `protected_branches: ['release']` throughout so the decision is reached
 * without a git lookup for the repo default branch; which RULE gated the merge
 * is irrelevant to how it is satisfied, and that is exactly the point.
 */
describe('enforceEdgeGate — satisfiers', () => {
  /** Minimal in-memory Storage double: only task metadata is touched here. */
  function fakeStorage(): Storage {
    const meta = new Map<string, string>();
    return {
      getTaskMetadata: async (taskId: string, key: string) => meta.get(`${taskId}:${key}`) ?? null,
      updateTaskMetadata: async (taskId: string, key: string, value: string) => {
        meta.set(`${taskId}:${key}`, value);
      },
    } as unknown as Storage;
  }

  function config(overrides: Partial<ProtectionConfig> = {}): ResolvedConfig {
    return {
      protection: protection({ protected_branches: ['release'], ...overrides }),
      remote: { git_remote: 'origin' },
      git: { default_branch_prefix: 'lazy' },
    } as unknown as ResolvedConfig;
  }

  const edge = { sourceBranch: 'lazy/add-auth', targetBranch: 'release' };

  function enforce(storage: Storage, forgeApproval?: () => Promise<boolean>) {
    return enforceEdgeGate({
      storage,
      config: config(),
      projectRoot: '/tmp/does-not-matter',
      taskId: 'task-1',
      displayId: 'add-auth',
      edge,
      forgeApproval,
    });
  }

  // INVARIANT: a human's approval on the PR/MR satisfies the SAME gate as
  // `lazy approve`. It is not a parallel path that only remote drivers take —
  // it is a satisfier resolved inside enforceEdgeGate, so every driver reaches
  // the identical decision.
  test('a forge PR/MR approval satisfies the gate', async () => {
    const storage = fakeStorage();
    await enforce(storage, async () => true); // must not throw
  });

  // INVARIANT: the forge is checked BEFORE the stored approval so an
  // already-approved PR does not silently burn the human's one-shot
  // `lazy approve` record — it stays pending for an accept that needs it.
  test('a forge approval does not consume a pending lazy-approve record', async () => {
    const storage = fakeStorage();
    await recordHumanApproval(storage, 'task-1');

    await enforce(storage, async () => true);

    expect(await peekHumanApproval(storage, 'task-1')).not.toBeNull();
  });

  // INVARIANT: with no forge approval, the local one-shot approval still
  // satisfies the gate — and is consumed, so it unlocks exactly one accept.
  test('falls through to the lazy-approve record when the forge has no approval', async () => {
    const storage = fakeStorage();
    await recordHumanApproval(storage, 'task-1');

    await enforce(storage, async () => false);

    expect(await peekHumanApproval(storage, 'task-1')).toBeNull();
  });

  // INVARIANT: no satisfier of either kind means REFUSAL. This is the whole
  // gate — an unapproved PR must not merge just because a forge exists.
  test('refuses when neither the forge nor a record approves', async () => {
    const storage = fakeStorage();
    await expect(enforce(storage, async () => false)).rejects.toBeInstanceOf(EdgeGateRefusedError);
  });

  // INVARIANT: the forge probe FAILS CLOSED. An unreachable forge must never
  // open the gate — the human still has `lazy approve` as the offline path.
  test('a throwing forge probe leaves the gate shut', async () => {
    const storage = fakeStorage();
    await expect(
      enforce(storage, async () => { throw new Error('network down'); }),
    ).rejects.toBeInstanceOf(EdgeGateRefusedError);
  });

  // INVARIANT: a local-driver project (no forge probe passed) is gated exactly
  // like a forge project and is never told to go approve a PR it cannot have.
  test('local driver (no forge probe): refusal names only lazy approve', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforce(storage);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('lazy approve add-auth');
    expect(message).not.toContain('PR/MR');
  });

  // The refusal a forge project sees names both routes, because both work.
  test('forge driver: refusal names the PR/MR route too', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforce(storage, async () => false);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('lazy approve add-auth');
    expect(message).toContain('PR/MR');
  });
});
