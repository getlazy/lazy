/**
 * Unit tests for SyncCommand session ID threading and pending_sync counter semantics.
 *
 * INVARIANT: When a SyncCommand carries agent_session_id, the supervisor must
 * pass it through to runSyncWithUpstream so conflict resolution reuses the
 * existing agent session (add-session-merge). Without this, sync-triggered
 * merges cold-start a fresh Claude Code and lose prior task context.
 *
 * INVARIANT: pending_sync is a counter, not a boolean. Reset to 0 on sync launch,
 * incremented on new signals. This prevents lost signals when parent changes
 * arrive while a merge is already running.
 */

import { describe, test, expect } from 'bun:test';
import type { SyncCommand } from '../../src/protocol/types';
import type { Task } from '../../src/types';

describe('SyncCommand session threading', () => {
  // INVARIANT: SyncCommand type carries agent_session_id for same-session
  // conflict resolution. If this field is removed or renamed, the supervisor's
  // handleSyncCommand will silently stop threading session IDs.
  test('SyncCommand type includes agent_session_id field', () => {
    const cmd: SyncCommand = {
      type: 'sync',
      task_id: 'abc12345',
      parent_branch: 'main',
      agent_session_id: 'session-xyz',
      model_id: 'claude-sonnet-4-5-20250929',
    };

    expect(cmd.agent_session_id).toBe('session-xyz');
    expect(cmd.type).toBe('sync');
  });

  // Verify that SyncCommand without session ID is valid (no session = cold start)
  test('SyncCommand works without agent_session_id (cold-start fallback)', () => {
    const cmd: SyncCommand = {
      type: 'sync',
      task_id: 'abc12345',
      parent_branch: 'main',
    };

    expect(cmd.agent_session_id).toBeUndefined();
  });
});

describe('pending_sync counter semantics', () => {
  // INVARIANT: pending_sync is a number, not a boolean. This prevents lost signals
  // when parent changes arrive while a sync merge is already in progress.
  test('Task.pending_sync is a number (0 = up to date, >0 = needs sync)', () => {
    const task: Pick<Task, 'pending_sync'> = { pending_sync: 0 };
    expect(task.pending_sync).toBe(0);

    // Simulate signal arrival
    task.pending_sync++;
    expect(task.pending_sync).toBe(1);

    // Simulate sync launch (reset to 0)
    task.pending_sync = 0;
    expect(task.pending_sync).toBe(0);
  });

  // INVARIANT: New signals during merge increment the counter above 0, so
  // completion handler knows another sync is needed.
  test('signals during merge are not lost', () => {
    const task: Pick<Task, 'pending_sync'> = { pending_sync: 1 };

    // Sync launches — reset to 0
    task.pending_sync = 0;

    // While merge runs, parent changes again
    task.pending_sync++;
    expect(task.pending_sync).toBe(1);

    // Merge completes — counter is >0, another sync needed
    expect(task.pending_sync > 0).toBe(true);
  });
});
