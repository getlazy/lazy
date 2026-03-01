/**
 * Mock remote driver factory for e2e tests.
 *
 * When LAZY_MOCK_IMPORT_RESULT is set, createDriver returns a mock driver
 * whose importUrl resolves to the parsed JSON from that env var.
 * This allows link command e2e tests without needing real GitHub access.
 *
 * This module replaces src/remote/index.ts via mock.module in preload-mocks.ts.
 * It only needs to export createDriver (the only import link.ts uses from remote).
 * Other exports are stubbed to avoid circular imports.
 */

import type { ImportResult } from '../../src/remote/driver';
import type { RepositoryDriver } from '../../src/remote/driver';

const mockImportJson = process.env.LAZY_MOCK_IMPORT_RESULT;

function buildMockDriver(mockResult: ImportResult): RepositoryDriver {
  return {
    needsSync: false,
    canImport: (_url: string) => true,
    importUrl: async (_url: string, _opts: unknown) => mockResult,
    merge: async () => ({ status: 'merged' as const }),
    getChecksStatus: async () => ({ status: 'passed' as const }),
    waitForChecks: async () => ({ passed: true as const }),
    pushBranch: async () => {},
    fetchBranch: async () => false,
    publishBranch: async () => ({}),
    markReadyForReview: async () => ({}),
    syncComments: async () => [],
    getPRState: async () => null,
    postTurnSummary: async () => {},
    postAcceptReview: async () => null,
    postRejectReview: async () => null,
    cleanup: async () => {},
    checkHealth: async () => [],
    getConfigOptions: () => ({ valid: [], deprecated: [] }),
    getTaskUrl: async () => null,
    hasRemoteRef: () => false,
    validateAccept: () => null,
    resolveUpstreamRef: async (branch: string) => branch,
    fastForwardLocal: async () => ({ success: true }),
    fetchRemoteState: async () => {},
    getLastCommentSyncedAt: () => undefined,
    commentSyncedAtKey: () => 'comment_synced_at',
    getLastPostedTurnSeq: () => -1,
    postedTurnSeqKey: () => 'posted_turn_seq',
    getLastPostedNoteAt: () => undefined,
    postedNoteAtKey: () => 'posted_note_at',
    formatImportedComment: (comment: unknown) => String(comment),
    isImportedComment: () => false,
    getRemoteRefUrl: () => null,
    getRemoteRefState: () => null,
  } as RepositoryDriver;
}

const _mockResult = mockImportJson ? JSON.parse(mockImportJson) as ImportResult : null;
const _mockDriver = _mockResult ? buildMockDriver(_mockResult) : null;

export function createDriver(_config: unknown): RepositoryDriver {
  return _mockDriver!;
}

// Stubs for other exports that other modules may import during the link flow
export function detectRemote(_repoDir: string) { return null; }
export class LocalDriver {}
export class GitHubDriver {}
export function detectGitHub(_repoDir: string) { return null; }
