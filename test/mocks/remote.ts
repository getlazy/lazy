/**
 * Mock remote driver factory for e2e tests.
 *
 * When a mock import / find-PR / accept-gates / protected-branch / needsSync
 * signal is present, createDriver (via tryCreateMockDriver) returns a fake
 * forge. Signals come from env (daemonless CLI subprocesses) or from files
 * under LAZY_PROTOCOL_BASE (daemon-backed suites — env cannot change after
 * the daemon starts).
 *
 * This module is overlaid onto src/remote/index.ts by preload-mocks.ts.
 * tryCreateMockDriver returns null when nothing is mocked so the real
 * factory still runs.
 */

import type { ImportResult, AcceptGateWarning } from '../../src/remote/driver';
import type { RepositoryDriver, MarkReadyOptions, OpenReview } from '../../src/remote/driver';
import type { Task } from '../../src/types';

const mockImportJson = process.env.LAZY_MOCK_IMPORT_RESULT;
const mockFindPrJson = process.env.LAZY_MOCK_FIND_PR_RESULT;
const mockAcceptGatesJson = process.env.LAZY_MOCK_ACCEPT_GATES;
const mockProtectedBranch = process.env.LAZY_MOCK_PROTECTED_BRANCH === '1';
const mockHasExternalApproval = process.env.LAZY_MOCK_HAS_EXTERNAL_APPROVAL === '1';
// Opt-in to remote driver behavior (needsSync=true). Required for tests that
// exercise code paths gated on driver.needsSync (e.g., protected branch checks,
// push-before-merge). Separate from other mock env vars because needsSync=true
// triggers validateBranchInSyncWithRemote in preflight, which does real git
// operations and would break tests without a real remote.
const mockNeedsSync = process.env.LAZY_MOCK_NEEDS_SYNC === '1';
// See upstreamRefName below: makes the mock answer `origin/<branch>` the way a
// hosted driver does, for tests about parent-ref resolution.
const mockUpstreamRemote = process.env.LAZY_MOCK_UPSTREAM_REMOTE === '1';

function readJsonFile(name: string): unknown | null {
  const base = process.env.LAZY_PROTOCOL_BASE;
  if (!base) return null;
  try {
    // Sync read is acceptable in test mocks (no event loop concerns).
    const { readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const filePath = join(base, name);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Per-call gate file path. Tests running against a daemon can't pass
 * `LAZY_MOCK_ACCEPT_GATES` per-test (the env reaches the CLI subprocess but
 * NOT the long-running daemon). Instead, tests write gate JSON to this file
 * and the mock re-reads it on every checkAcceptGates() call.
 *
 * Path: <LAZY_PROTOCOL_BASE>/mock-accept-gates.json (both daemon and tests
 * share LAZY_PROTOCOL_BASE so they agree on the file location).
 */
function readGatesFromFile(): AcceptGateWarning[] | null {
  const parsed = readJsonFile('mock-accept-gates.json');
  return parsed === null ? null : (parsed as AcceptGateWarning[]);
}

/**
 * Per-call approval state, mirroring readGatesFromFile(). Protected-branch
 * tests run against a daemon and must vary `hasRemoteRef` / `hasExternalApproval`
 * per-test, but env can't change after daemon startup. Tests write approval JSON
 * to <LAZY_PROTOCOL_BASE>/mock-approval.json and the mock re-reads it per call.
 * Returns null when no file is present so callers fall back to the env consts.
 */
function readApprovalFromFile(): { hasRemoteRef?: boolean; hasExternalApproval?: boolean } | null {
  const parsed = readJsonFile('mock-approval.json');
  return parsed === null ? null : (parsed as { hasRemoteRef?: boolean; hasExternalApproval?: boolean });
}

function consumeJsonFile(name: string): void {
  const base = process.env.LAZY_PROTOCOL_BASE;
  if (!base) return;
  try {
    const { unlinkSync, existsSync } = require('fs');
    const { join } = require('path');
    const filePath = join(base, name);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best-effort: a leftover file is a test-isolation leak, not a mock failure.
  }
}

function readImportFromFile(): ImportResult | null {
  const parsed = readJsonFile('mock-import-result.json');
  return parsed === null ? null : (parsed as ImportResult);
}

function readFindPrFromFile(): ImportResult | null {
  const parsed = readJsonFile('mock-find-pr.json');
  return parsed === null ? null : (parsed as ImportResult);
}

/**
 * Presence of `mock-forge-writes.json` turns the mock driver on for a suite
 * that wants to observe forge WRITES. Its contents are unused — the file is
 * the activation signal; what the suite reads back is the call log below.
 */
function readForgeWritesFromFile(): Record<string, unknown> | null {
  const parsed = readJsonFile('mock-forge-writes.json');
  return parsed === null ? null : (parsed as Record<string, unknown>);
}

/**
 * Record every write this driver makes to the forge.
 *
 * INVARIANT the log exists for: lazy writes NOTHING to a PR/MR that a human
 * receives as a notification (engineer decision, 2026-09-21). Only three
 * kinds may ever appear here — `body` (the lazy-owned description section),
 * `approve` (the `[remote] auto_approve` merge approval) and `close` (the
 * cleanup that closes a PR/MR for a discarded branch). A `comment` or
 * `review` kind would mean the removed posting paths came back.
 */
function appendForgeWriteCall(payload: { kind: string; taskId: string }): void {
  const base = process.env.LAZY_PROTOCOL_BASE;
  if (!base) return;
  try {
    const { appendFileSync } = require('fs');
    const { join } = require('path');
    appendFileSync(join(base, 'mock-forge-write-calls.jsonl'), `${JSON.stringify(payload)}\n`);
  } catch {
    // Best-effort: a missing record fails the e2e assertion, not the mock.
  }
}

/**
 * Presence of `mock-review-create.json` (`{ url, id }`) makes
 * markReadyForReview CREATE a PR the way a hosted driver does: it returns that
 * url/id as metadata, logs `{ taskId, base }` to `mock-review-created.jsonl`
 * (base null = derived, not explicit) and marks `mock-pr-state.json` OPEN.
 * Without it markReadyForReview is the historical no-op.
 */
function readReviewCreateFromFile(): { url: string; id: string } | null {
  const parsed = readJsonFile('mock-review-create.json');
  return parsed === null ? null : (parsed as { url: string; id: string });
}

function appendJsonLine(name: string, payload: unknown): void {
  const base = process.env.LAZY_PROTOCOL_BASE;
  if (!base) return;
  const { appendFileSync } = require('fs');
  const { join } = require('path');
  appendFileSync(join(base, name), `${JSON.stringify(payload)}\n`);
}

function writeJsonFile(name: string, payload: unknown): void {
  const base = process.env.LAZY_PROTOCOL_BASE;
  if (!base) return;
  const { writeFileSync } = require('fs');
  const { join } = require('path');
  writeFileSync(join(base, name), JSON.stringify(payload));
}

function currentImportResult(): ImportResult | null {
  if (mockImportJson) return JSON.parse(mockImportJson) as ImportResult;
  return readImportFromFile();
}

function currentFindPrResult(): ImportResult | null {
  if (mockFindPrJson) return JSON.parse(mockFindPrJson) as ImportResult;
  return readFindPrFromFile();
}

function forgeUrlOf(task: Task): string | null {
  return task.metadata?.github_remote_ref_url
    ?? task.metadata?.gitlab_remote_ref_url
    ?? task.metadata?.remote_ref_url
    ?? null;
}

function forgeIdOf(task: Task): string | undefined {
  return task.metadata?.github_remote_ref_id
    ?? task.metadata?.gitlab_remote_ref_id
    ?? task.metadata?.remote_ref_id
    ?? task.metadata?.github_pr_number;
}

function forgeStateOf(task: Task): string | null {
  return task.metadata?.github_remote_ref_state
    ?? task.metadata?.gitlab_remote_ref_state
    ?? task.metadata?.remote_ref_state
    ?? null;
}

function buildMockDriver(mockResult: ImportResult | null): RepositoryDriver {
  const staticGateWarnings: AcceptGateWarning[] = mockAcceptGatesJson
    ? JSON.parse(mockAcceptGatesJson)
    : [];

  return {
    needsSync: mockNeedsSync,
    canImport: (_url: string) => true,
    importUrl: async (_url: string, _opts: unknown) => {
      const fromFile = readImportFromFile();
      const result = (mockImportJson ? JSON.parse(mockImportJson) as ImportResult : null)
        ?? fromFile
        ?? mockResult;
      if (!result) {
        throw new Error('Mock driver importUrl called with no LAZY_MOCK_IMPORT_RESULT');
      }
      // Consume the file after one successful import so a later regular-task
      // start in the same protocol base does not keep the forge mock armed.
      if (fromFile && !mockImportJson) consumeJsonFile('mock-import-result.json');
      return result;
    },
    findPullRequestForBranch: async (branch: string) => {
      const found = currentFindPrResult();
      if (!found) return null;
      if (found.branch && found.branch !== branch) return null;
      return found;
    },
    // Every forge merge is logged with the base it would land in, so a suite
    // can assert that a merge into the wrong base never happened.
    merge: async (opts: { task: Task; targetBranch: string }) => {
      const pr = readJsonFile('mock-pr-state.json') as { state?: string; base?: string } | null;
      appendJsonLine('mock-merges.jsonl', { taskId: opts.task.id, target: opts.targetBranch, prBase: pr?.base ?? null });
      // Only the task that records the (one) mock PR merges it; another task's
      // forge merge must not flip a different task's PR state.
      if (pr?.state === 'OPEN' && forgeIdOf(opts.task)) writeJsonFile('mock-pr-state.json', { ...pr, state: 'MERGED' });
      return { status: 'merged' as const };
    },
    getChecksStatus: async () => ({ status: 'passed' as const }),
    waitForChecks: async () => ({ passed: true as const }),
    pushBranch: async () => {},
    fetchBranch: async () => false,
    publishBranch: async () => ({}),
    markReadyForReview: async (task: Task, opts?: MarkReadyOptions) => {
      const create = readReviewCreateFromFile();
      if (!create) return {};
      // Like the real drivers: an existing PR is never re-created or re-targeted.
      if (forgeIdOf(task)) return {};
      // Like the real drivers: with no explicit base, a task stacked on another
      // task is REFUSED — that is the "no PR for intermediate branches by
      // default" invariant, and a suite exercising an automatic path must see
      // it throw exactly as GitHub/GitLab would.
      if (!opts?.baseBranch && task.target?.kind === 'task') {
        throw new Error(`Refusing to create a PR for task ${task.id}: it is stacked on another task (mock driver).`);
      }
      const base = opts?.baseBranch ?? (task.target?.kind === 'branch' ? task.target.branch : null) ?? 'main';
      appendJsonLine('mock-review-created.jsonl', { taskId: task.id, base: opts?.baseBranch ?? null });
      writeJsonFile('mock-pr-state.json', { state: 'OPEN', base });
      return {
        metadata: {
          github_remote_ref_url: create.url,
          github_remote_ref_id: create.id,
        },
      };
    },
    remoteBranchHead: async (branch: string) => {
      const branches = readJsonFile('mock-remote-branches.json') as Record<string, string> | null;
      return branches?.[branch] ?? null;
    },
    findOpenReviewForBranch: async (branch: string) => {
      const open = readJsonFile('mock-open-review.json') as (OpenReview & { branch?: string }) | null;
      if (!open) return null;
      if (open.branch && open.branch !== branch) return null;
      return { url: open.url, baseBranch: open.baseBranch, metadata: open.metadata };
    },
    // Retargeting succeeds unless `mock-retarget-fails.json` exists; every
    // attempt is logged to `mock-retargets.jsonl`.
    retargetReview: async (task: Task, base: string) => {
      const fails = readJsonFile('mock-retarget-fails.json') !== null;
      appendJsonLine('mock-retargets.jsonl', { taskId: task.id, base, ok: !fails });
      if (fails) throw new Error('mock forge refused the retarget');
      const pr = readJsonFile('mock-pr-state.json') as Record<string, unknown> | null;
      writeJsonFile('mock-pr-state.json', { ...(pr ?? { state: 'OPEN' }), base });
    },
    getReviewBase: async (task: Task) => {
      if (!forgeIdOf(task)) return null;
      const pr = readJsonFile('mock-pr-state.json') as { base?: string } | null;
      return pr?.base ?? null;
    },
    syncComments: async () => [],
    // Like a real forge, a PR the task records has a state — OPEN until
    // something closes or merges it — and `null` only for a task with no PR.
    // (A real driver answers null otherwise only when it cannot ask the forge;
    // unit tests fake that case directly.)
    getPRState: async (task: Task) => {
      // `mock-pr-state-unreadable.json` makes the forge's answer unreadable
      // (a real driver's null on a gh/glab failure), while the PR's actual
      // state keeps moving underneath — a close still closes it.
      if (readJsonFile('mock-pr-state-unreadable.json') !== null) return null;
      const state = readJsonFile('mock-pr-state.json') as { state?: string } | null;
      if (state?.state) return state.state as 'OPEN' | 'MERGED' | 'CLOSED';
      return forgeIdOf(task) ? 'OPEN' : null;
    },
    updateRemoteBody: async (task: Task) => {
      appendForgeWriteCall({ kind: 'body', taskId: task.id });
    },
    approveForMerge: async (task: Task) => {
      appendForgeWriteCall({ kind: 'approve', taskId: task.id });
      return null;
    },
    // Closing the PR on reject IS a forge write, so it is logged — but under
    // its own kind, so a test asserting "no comment or review was written"
    // does not have to pretend the close did not happen.
    cleanup: async (branch: string) => {
      appendForgeWriteCall({ kind: 'close', taskId: branch });
      const state = readJsonFile('mock-pr-state.json') as { state?: string } | null;
      // No state file is the implicit OPEN above, which a close closes too.
      if (!state?.state || state.state === 'OPEN') writeJsonFile('mock-pr-state.json', { ...(state ?? {}), state: 'CLOSED' });
      // `mock-pr-state-unreadable-after-close.json`: the close succeeds, then
      // the forge's answers become unreadable — the transient read failure
      // right after a close that lazy must not mistake for anything.
      if (readJsonFile('mock-pr-state-unreadable-after-close.json') !== null) writeJsonFile('mock-pr-state-unreadable.json', {});
    },
    checkHealth: async () => [],
    getConfigOptions: () => ({ valid: [], deprecated: [] }),
    getTaskUrl: async (task: Task) => forgeUrlOf(task),
    hasRemoteRef: (task: Task) => {
      // File overrides the env default so daemon-backed protected-branch tests
      // can toggle a remote ref per-test (env can't change after daemon startup).
      const approval = readApprovalFromFile();
      if (approval?.hasRemoteRef !== undefined) return approval.hasRemoteRef;
      if (forgeIdOf(task)) return true;
      return mockHasExternalApproval;
    },
    recoverRemoteRef: async () => null,
    validateAccept: () => null,
    isTargetBranchProtected: async () => mockProtectedBranch,
    hasExternalApproval: async () => {
      const approval = readApprovalFromFile();
      return approval?.hasExternalApproval ?? mockHasExternalApproval;
    },
    checkAcceptGates: async () => {
      // File overrides static env value — supports per-test injection in
      // daemon-backed tests where env can't change after daemon startup.
      const fileGates = readGatesFromFile();
      return fileGates !== null ? fileGates : staticGateWarnings;
    },
    // A real hosted driver names `<remote>/<branch>` here; the mock says "local"
    // by default because most suites assert against local refs. Opt in with
    // LAZY_MOCK_UPSTREAM_REMOTE=1 to get the hosted answer, for tests about which
    // ref a surface resolves a parent branch to.
    upstreamRefName: (branch: string) => (mockUpstreamRemote ? `origin/${branch}` : branch),
    resolveUpstreamRef: async (branch: string) => (mockUpstreamRemote ? `origin/${branch}` : branch),
    fastForwardLocal: async () => ({ success: true }),
    fetchRemoteState: async () => {},
    getLastFidelityTurnSeq: () => -1,
    fidelityTurnSeqKey: () => 'fidelity_turn_seq',
    formatImportedComment: (comment: { author?: string; body?: string }) => `[PR #? @${comment.author}] ${comment.body}`,
    isImportedComment: () => false,
    getRemoteRefUrl: (task: Task) => forgeUrlOf(task),
    getRemoteRefState: (task: Task) => forgeStateOf(task),
    getLastCIFailureSynced: () => undefined,
    ciFailureSyncedKey: () => 'ci_failure_synced',
    getFailedCIJobs: async () => [],
  } as RepositoryDriver;
}

/**
 * Return a mock driver when any mock signal is present; otherwise null so
 * preload can fall through to the real factory.
 *
 * Re-reads protocol-base files each call so a daemon-backed suite can write
 * an import or find-PR result after the daemon has already started.
 */
export function tryCreateMockDriver(): RepositoryDriver | null {
  const importResult = currentImportResult();
  const findPr = currentFindPrResult();
  const fileGates = readGatesFromFile();
  const forgeWrites = readForgeWritesFromFile();
  const reviewCreate = readReviewCreateFromFile();
  if (
    !importResult
    && !findPr
    && !mockImportJson
    && !mockFindPrJson
    && !mockAcceptGatesJson
    && fileGates === null
    && forgeWrites === null
    && reviewCreate === null
    && !mockProtectedBranch
    && !mockNeedsSync
  ) {
    return null;
  }
  return buildMockDriver(importResult);
}

export function createDriver(_config: unknown): RepositoryDriver {
  const mock = tryCreateMockDriver();
  if (!mock) {
    throw new Error(
      'test/mocks/remote.ts createDriver called with no mock signal. ' +
      'Set LAZY_MOCK_IMPORT_RESULT (or write mock-import-result.json) or use tryCreateMockDriver.',
    );
  }
  return mock;
}

// Stubs for other exports that other modules may import during the link flow
export function detectRemote(_repoDir: string) { return null; }
export class LocalDriver {}
export class GitHubDriver {}
export function detectGitHub(_repoDir: string) { return null; }
