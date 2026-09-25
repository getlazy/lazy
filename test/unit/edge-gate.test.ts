/**
 * Unit tests for the branch-protection decision function
 * (src/protection/edge-gate.ts — internally modeled as a directed merge edge
 * source → target). Both directions ship: INCOMING ("the target is a
 * protected branch") and OUTGOING ("the source is a protected task").
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateEdgeGate,
  enforceEdgeGate,
  EdgeGateRefusedError,
  type ProtectionConfig,
} from '../../src/protection/edge-gate';
import type { Storage } from '../../src/storage';
import type { ResolvedConfig } from '../../src/config';
import { enrollPassphrase } from '../helpers/passphrase';

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
 * Satisfiers of the gate. A forge PR/MR approval and the inline passphrase
 * are two expressions of the SAME deliberate human act, resolved in one place
 * — not two parallel protection mechanisms (P0.2c).
 *
 * There is deliberately NO stored approval any more: the pre-v0.22
 * `lazy approve` record was a floating credential (no expiry, no binding to
 * the commits being merged). The passphrase now travels WITH the accept that
 * uses it, so approval cannot outlive or drift from the merge it authorizes.
 *
 * `protected_branches: ['release']` throughout so the decision is reached
 * without a git lookup for the repo default branch; which RULE gated the merge
 * is irrelevant to how it is satisfied, and that is exactly the point.
 */
describe('enforceEdgeGate — satisfiers', () => {
  /** Minimal in-memory Storage double: nothing is persisted by the gate. */
  function fakeStorage(): Storage {
    const meta = new Map<string, string>();
    return {
      getTaskMetadata: async (taskId: string, key: string) => meta.get(`${taskId}:${key}`) ?? null,
      updateTaskMetadata: async (taskId: string, key: string, value: string) => {
        meta.set(`${taskId}:${key}`, value);
      },
    } as unknown as Storage;
  }

  // A real project root plus a machine-global enrollment, so the inline token
  // path is exercised end-to-end through createHumanTokenVerifier. The store
  // is redirected to a temp dir via its own seam — never the developer's real
  // ~/.lazy/passphrase.json, which these tests would otherwise read.
  let projectRoot: string;
  let passphraseBase: string;
  let previousPassphraseBase: string | undefined;
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'edge-gate-test-'));
    await mkdir(join(projectRoot, '.lazy'), { recursive: true });
    passphraseBase = await mkdtemp(join(tmpdir(), 'edge-gate-passphrase-'));
    previousPassphraseBase = process.env.LAZY_PASSPHRASE_BASE_DIR;
    process.env.LAZY_PASSPHRASE_BASE_DIR = passphraseBase;
    await enrollPassphrase(passphraseBase, 'sesame');
  });
  afterAll(async () => {
    if (previousPassphraseBase === undefined) delete process.env.LAZY_PASSPHRASE_BASE_DIR;
    else process.env.LAZY_PASSPHRASE_BASE_DIR = previousPassphraseBase;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(passphraseBase, { recursive: true, force: true });
  });

  function config(overrides: Partial<ProtectionConfig> = {}): ResolvedConfig {
    return {
      protection: protection({ protected_branches: ['release'], ...overrides }),
      remote: { git_remote: 'origin' },
      git: { default_branch_prefix: 'lazy' },
    } as unknown as ResolvedConfig;
  }

  const edge = { sourceBranch: 'lazy/add-auth', targetBranch: 'release' };

  function enforce(storage: Storage, opts: {
    forgeApproval?: () => Promise<boolean>;
    token?: string;
  } = {}) {
    return enforceEdgeGate({
      storage,
      config: config(),
      projectRoot,
      taskId: 'task-1',
      displayId: 'add-auth',
      edge,
      forgeApproval: opts.forgeApproval,
      token: opts.token,
    });
  }

  // INVARIANT: a human's approval on the PR/MR satisfies the SAME gate as the
  // inline passphrase. It is not a parallel path that only remote drivers
  // take — it is a satisfier resolved inside enforceEdgeGate, so every driver
  // reaches the identical decision.
  test('a forge PR/MR approval satisfies the gate', async () => {
    const storage = fakeStorage();
    await enforce(storage, { forgeApproval: async () => true }); // must not throw
  });

  // INVARIANT: the correct passphrase, supplied inline with the accept,
  // satisfies the gate — approval is bound to this very invocation.
  test('the inline passphrase satisfies the gate', async () => {
    const storage = fakeStorage();
    await enforce(storage, { token: 'sesame' }); // must not throw
  });

  // INVARIANT: a wrong passphrase REFUSES — and the refusal never echoes the
  // expected token (the message travels back over builder-readable channels).
  test('a wrong passphrase refuses without echoing the expected one', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforce(storage, { token: 'wrong' });
    } catch (err) {
      expect(err).toBeInstanceOf(EdgeGateRefusedError);
      message = (err as Error).message;
    }
    expect(message).toContain('does not match');
    expect(message).not.toContain('sesame');
  });

  // INVARIANT: no satisfier means REFUSAL. This is the whole gate — an
  // unapproved merge must not land just because a forge exists.
  test('refuses when neither the forge nor a token approves', async () => {
    const storage = fakeStorage();
    await expect(enforce(storage, { forgeApproval: async () => false }))
      .rejects.toBeInstanceOf(EdgeGateRefusedError);
  });

  // INVARIANT: the forge probe FAILS CLOSED. An unreachable forge must never
  // open the gate — the human still has the inline passphrase as the offline
  // path.
  test('a throwing forge probe leaves the gate shut', async () => {
    const storage = fakeStorage();
    await expect(
      enforce(storage, { forgeApproval: async () => { throw new Error('network down'); } }),
    ).rejects.toBeInstanceOf(EdgeGateRefusedError);
  });

  // INVARIANT: the gate persists NOTHING. There is no stored approval to go
  // stale or to authorize a later, different diff — a successful token pass
  // leaves no metadata behind.
  test('a satisfied gate writes no approval record', async () => {
    const meta = new Map<string, string>();
    const storage = {
      getTaskMetadata: async (taskId: string, key: string) => meta.get(`${taskId}:${key}`) ?? null,
      updateTaskMetadata: async (taskId: string, key: string, value: string) => {
        meta.set(`${taskId}:${key}`, value);
      },
    } as unknown as Storage;
    await enforceEdgeGate({
      storage,
      config: config(),
      projectRoot,
      taskId: 'task-1',
      displayId: 'add-auth',
      edge,
      token: 'sesame',
    });
    expect(meta.size).toBe(0);
  });

  // INVARIANT: a local-driver project (no forge probe passed) is gated exactly
  // like a forge project and is never told to go approve a PR it cannot have.
  test('local driver (no forge probe): refusal names accept, not a PR', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforce(storage);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('lazy accept add-auth');
    expect(message).not.toContain('PR/MR');
  });

  test('refusal interpolates the complete accept command the daemon composed', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforceEdgeGate({
        storage,
        config: config(),
        projectRoot,
        taskId: 'task-1',
        displayId: 'add-auth',
        edge,
        acceptCommand: 'lazy accept add-auth --approve-file a.spec.ts --reason LGTM',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('lazy accept add-auth --approve-file a.spec.ts --reason LGTM');
    expect(message).not.toMatch(/lazy accept add-auth\n/);
  });

  // The refusal a forge project sees names both routes, because both work.
  test('forge driver: refusal names the PR/MR route too', async () => {
    const storage = fakeStorage();
    let message = '';
    try {
      await enforce(storage, { forgeApproval: async () => false });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('lazy accept add-auth');
    expect(message).toContain('PR/MR');
  });
});
