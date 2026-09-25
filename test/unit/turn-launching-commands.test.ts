/**
 * INVARIANT: TURN_LAUNCHING_COMMANDS is a command-name set, not an intent
 * inspector. Every command in it is billed to the calling user's credential
 * when it arrives on a user token; every command out of it is not.
 *
 * The first review-ask used to ride `reviewPostComment` with `intent: 'ask'`.
 * That command also stores a plain comment that launches nothing, so it cannot
 * live in this set — a control plane that minted a per-user token for every
 * comment would attribute a spend that never happened, and recording an owner
 * on a comment post would leak onto the next turn (see per-user-credentials.md).
 * The ask is therefore its own command (`reviewAsk`), sibling of
 * `reviewRetryAsk`. Adding a dual-purpose command here, or inspecting params
 * to decide, is the regression this file exists to catch. The leftover
 * `intent: 'ask'` on `reviewPostComment` is refused, not launched.
 */

import { describe, test, expect } from 'bun:test';
import { TURN_LAUNCHING_COMMANDS } from '../../src/daemon/rpc-handlers';
import { handleReviewPostComment } from '../../src/daemon/rpc-review';
import { RpcError } from '../../src/daemon/rpc-error';

describe('TURN_LAUNCHING_COMMANDS', () => {
  test('the first review-ask is turn-launching; a comment post is not', () => {
    expect(TURN_LAUNCHING_COMMANDS.has('reviewAsk')).toBe(true);
    expect(TURN_LAUNCHING_COMMANDS.has('reviewRetryAsk')).toBe(true);
    expect(TURN_LAUNCHING_COMMANDS.has('reviewPostComment')).toBe(false);
    expect(TURN_LAUNCHING_COMMANDS.has('reviewWithdrawComment')).toBe(false);
  });

  test('reviewPostComment refuses intent=ask rather than launching unbilled', async () => {
    // INVARIANT: no launch may remain reachable from a command that is not in
    // TURN_LAUNCHING_COMMANDS. The leftover `intent: 'ask'` path would spend
    // without a turn owner. The refusal happens before storage is opened, so
    // a dummy projectRoot is enough.
    const err = await handleReviewPostComment('/unused', {
      taskId: 'any',
      file: 'a.ts',
      line: 1,
      side: 'new',
      content: 'why this?',
      intent: 'ask',
    }).catch(e => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(400);
    expect((err as Error).message).toContain('reviewAsk');
  });

  test('the rest of the billed set is named, not inferred', () => {
    // A new turn-launching command belongs in the production set AND here —
    // the set is the contract a control plane uses to pick a user token.
    expect(TURN_LAUNCHING_COMMANDS).toEqual(new Set([
      'startTask',
      'unblockTask',
      'resumeTask',
      'askTask',
      // Agent-run `lazy review <task>` — ephemeral review container, same worktree.
      'reviewTask',
      'syncTask',
      'reparentTask',
      'acceptTask',
      'reviewUnblock',
      'reviewSync',
      'reviewAsk',
      'reviewRetryAsk',
      'reviewAccept',
    ]));
  });
});
