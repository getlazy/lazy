import { describe, test, expect } from 'bun:test';
import { shouldReconcileAgentSessionId } from '../../src/utils/reconcile';

/**
 * The reconciler must trust the session ID Claude Code reports for each turn,
 * not the one lazy asked it to resume. Claude Code rotates session IDs (auto-
 * compact, --resume fallback) and machine switches leave stored IDs pointing
 * at JSONLs that don't exist locally. Trusting the reported ID keeps the DB
 * in sync with whatever JSONL actually exists.
 */
describe('shouldReconcileAgentSessionId', () => {
  test('first turn: no stored ID, agent reports one — update', () => {
    expect(shouldReconcileAgentSessionId(null, 'abc')).toBe(true);
  });

  test('rotation: agent reports a different ID than stored — update', () => {
    // INVARIANT: This is the bug fix. Pre-fix, lazy only updated when the
    // stored ID was null, which let drift accumulate forever.
    expect(shouldReconcileAgentSessionId('old-id', 'new-id')).toBe(true);
  });

  test('steady state: agent reports the same ID — no-op', () => {
    expect(shouldReconcileAgentSessionId('abc', 'abc')).toBe(false);
  });

  test('sync-only turn: agent reports empty session ID — skip', () => {
    // INVARIANT: Sync turns with no agent call set session_id to ''. Updating
    // the stored ID to '' would clobber a real session.
    expect(shouldReconcileAgentSessionId('abc', '')).toBe(false);
    expect(shouldReconcileAgentSessionId('abc', undefined)).toBe(false);
  });
});
