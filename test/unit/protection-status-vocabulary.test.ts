/**
 * Unit tests for the SHARED protection vocabulary (src/protection/status.ts).
 *
 * INVARIANT: define once, render everywhere. Every surface — `lazy show`,
 * `lazy status`, `lazy list`, the review header, MCP `lazy_show`, the web
 * dashboard — renders these helpers rather than re-deriving protection from
 * config. These tests pin the words and the JSON keys, because divergent
 * wording across surfaces is how a friction feature turns into a mystery.
 */

import { describe, test, expect } from 'bun:test';
import {
  PROTECTED_MARKER,
  APPROVAL_PENDING_MARKER,
  contextIsInert,
  protectionMarkers,
  protectionSummary,
  protectionAdvice,
  protectionHeadline,
  protectionToJson,
  type ProtectionContext,
  type TaskProtectionStatus,
} from '../../src/protection/status';
import { buildStatusLine } from '../../src/cli/tui/review';
import type { ReviewData } from '../../src/cli/tui/review';
import type { Task } from '../../src/types';

function status(over: Partial<TaskProtectionStatus> = {}): TaskProtectionStatus {
  return {
    enabled: true,
    gated: false,
    taskGate: null,
    branchGate: null,
    targetBranch: 'main',
    pendingApproval: null,
    ...over,
  };
}

function ctx(over: Partial<ProtectionContext> = {}): ProtectionContext {
  return {
    enabled: false,
    protectedBranches: [],
    gateDefaultBranch: false,
    defaultBranch: null,
    protectedTaskIds: new Map(),
    ...over,
  };
}

const branchGated = status({
  gated: true,
  branchGate: { branch: 'main', source: 'default-branch' },
});
const taskGated = status({
  gated: true,
  taskGate: { listedAs: 'my-task', armed: true },
});

describe('contextIsInert', () => {
  // A stock project must skip ALL per-task protection work: a list of N tasks
  // otherwise pays N storage reads to render nothing.
  test('a project that protects nothing is inert', () => {
    expect(contextIsInert(ctx())).toBe(true);
  });

  test('protection enabled with no branches and no default gate is inert', () => {
    expect(contextIsInert(ctx({ enabled: true }))).toBe(true);
  });

  test('an enabled default-branch gate is not inert', () => {
    expect(contextIsInert(ctx({ enabled: true, gateDefaultBranch: true, defaultBranch: 'main' }))).toBe(false);
  });

  test('an enabled listed branch is not inert', () => {
    expect(contextIsInert(ctx({ enabled: true, protectedBranches: ['main'] }))).toBe(false);
  });

  // A protected BRANCH while the master switch is off gates nothing and names
  // no particular task — nothing to say, so stay inert.
  test('a protected branch with protection disabled is inert', () => {
    expect(contextIsInert(ctx({ protectedBranches: ['main'] }))).toBe(true);
  });

  // A listed TASK is reportable even while disabled — "listed, but disabled"
  // IS the report, and it is the only way the human learns their config is inert.
  test('a listed task is not inert even with protection disabled', () => {
    expect(contextIsInert(ctx({ protectedTaskIds: new Map([['t1', 'my-task']]) }))).toBe(false);
  });
});

describe('protectionMarkers', () => {
  test('nothing to say renders an empty string, so callers can concatenate', () => {
    expect(protectionMarkers(status())).toBe('');
  });

  test('a gated task renders the protected marker', () => {
    expect(protectionMarkers(branchGated)).toBe(PROTECTED_MARKER);
  });

  test('a pending approval adds the approval marker', () => {
    const s = status({ ...branchGated, pendingApproval: { approvedAt: '2026-08-04T00:00:00Z' } });
    expect(protectionMarkers(s)).toBe(`${PROTECTED_MARKER}${APPROVAL_PENDING_MARKER}`);
  });

  // These land inside padded, width-computed columns and in output scripts grep.
  // A shield emoji is two columns wide in some terminals and zero in others.
  test('markers are ASCII', () => {
    expect(PROTECTED_MARKER).toBe('[P]');
    expect(APPROVAL_PENDING_MARKER).toBe('[A]');
  });
});

describe('protectionSummary', () => {
  test('is null when there is nothing to report', () => {
    expect(protectionSummary(status())).toBeNull();
  });

  test('names each gate kind', () => {
    expect(protectionSummary(branchGated)).toBe('yes (branch gate)');
    expect(protectionSummary(taskGated)).toBe('yes (task gate)');
    expect(protectionSummary(status({ ...taskGated, branchGate: branchGated.branchGate })))
      .toBe('yes (task gate + branch gate)');
  });

  // Silence here would leave the human believing a gate is armed when the
  // master switch is off.
  test('a listed task with protection disabled says so instead of nothing', () => {
    const s = status({ enabled: false, gated: false, taskGate: { listedAs: 'my-task', armed: true } });
    expect(protectionSummary(s)).toContain('but protection is disabled');
  });
});

describe('protectionAdvice', () => {
  test('tells the reader who must approve, and how', () => {
    const lines = protectionAdvice(branchGated, 'abc123');
    expect(lines.join('\n')).toContain('the repo default branch');
    expect(lines.join('\n')).toContain('lazy approve abc123');
  });

  test('reports a recorded approval as pending instead of demanding another', () => {
    const s = status({ ...branchGated, pendingApproval: { approvedAt: '2026-08-04T00:00:00Z' } });
    const text = protectionAdvice(s, 'abc123').join('\n');
    expect(text).toContain('Approval pending');
    expect(text).not.toContain('No approval recorded');
  });

  // A protected_tasks entry resolves to a branch at decision time, so an
  // unstarted task gates nothing — reported, not hidden.
  test('an unarmed task gate says the gate arms when the branch exists', () => {
    const s = status({ gated: true, taskGate: { listedAs: 'my-task', armed: false } });
    expect(protectionAdvice(s, 'abc123').join('\n')).toContain('no branch yet');
  });

  test('an ungated listed task gets no approval instruction', () => {
    const s = status({ enabled: false, gated: false, taskGate: { listedAs: 'my-task', armed: true } });
    expect(protectionAdvice(s, 'abc123').join('\n')).not.toContain('lazy approve');
  });
});

describe('protectionHeadline', () => {
  test('is null when there is no gate', () => {
    expect(protectionHeadline(status())).toBeNull();
  });

  test('names the target branch and the required action', () => {
    expect(protectionHeadline(branchGated)).toBe('[P] protected (merges into `main`) — needs `lazy approve`');
  });

  test('reports a pending approval', () => {
    const s = status({ ...taskGated, pendingApproval: { approvedAt: '2026-08-04T00:00:00Z' } });
    expect(protectionHeadline(s)).toBe('[P] protected (task gate) — approval pending');
  });
});

describe('protectionToJson', () => {
  // The MCP and dashboard contract: every key present, null rather than
  // missing, so a consumer can rely on the shape.
  test('carries the full shape with null-safe fields', () => {
    const json = protectionToJson(status());
    expect(Object.keys(json).sort()).toEqual([
      'approval_pending', 'branch_gate', 'enabled', 'gated', 'markers', 'summary', 'target_branch', 'task_gate',
    ]);
    expect(json.task_gate).toBeNull();
    expect(json.branch_gate).toBeNull();
    expect(json.approval_pending).toBeNull();
  });

  test('snake_cases the gate details', () => {
    const s = status({
      ...taskGated,
      branchGate: { branch: 'main', source: 'default-branch' },
      pendingApproval: { approvedAt: '2026-08-04T00:00:00Z' },
    });
    const json = protectionToJson(s);
    expect(json.task_gate).toEqual({ listed_as: 'my-task', armed: true });
    expect(json.branch_gate).toEqual({ branch: 'main', source: 'default-branch' });
    expect(json.approval_pending).toEqual({ approved_at: '2026-08-04T00:00:00Z' });
    expect(json.markers).toBe('[P][A]');
  });
});

describe('review header', () => {
  const reviewData = (protection: TaskProtectionStatus | null): ReviewData => ({
    task: { id: 'abcdef1234', status: 'blocked' } as Task,
    turns: [],
    commits: [],
    unseenComments: [],
    followUps: [],
    protection,
  } as unknown as ReviewData);

  test('appends the protection headline last, so existing fields keep their place', () => {
    const line = buildStatusLine(reviewData(branchGated));
    expect(line.endsWith('[P] protected (merges into `main`) — needs `lazy approve`')).toBe(true);
  });

  // INVARIANT: additive. An unprotected project's review header is what it was.
  test('says nothing when there is no gate', () => {
    expect(buildStatusLine(reviewData(null))).not.toContain('[P]');
    expect(buildStatusLine(reviewData(status()))).not.toContain('[P]');
  });
});
