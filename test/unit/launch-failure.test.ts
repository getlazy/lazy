/**
 * What lazy records when a turn's container fails to start.
 *
 * INVARIANT (fix-fatal-failure-silent-park): a launch failure is LAZY's, so the
 * `working → interrupted` park it causes never names the human who unblocked,
 * carries its reason, leaves a failure notice turn the task's failed:<class>
 * label is derived from, files an alert — and leaves the human's feedback
 * pending, so the next turn still delivers it. In the field this park was
 * written as `actor: human` with no reason and no turn, two seconds after a
 * member's unblock, and read as the member having stopped it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { recordLaunchFailure } from '../../src/daemon/launch-failure';
import { taskTurnFailure } from '../../src/task/turn-failure';

describe('recordLaunchFailure', () => {
  let root: string;
  let basePath: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-launch-fail-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-launch-fail-store-'));
    storage = new FileStorage(root, { basePath });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await rm(root, { recursive: true, force: true });
    await rm(basePath, { recursive: true, force: true });
  });

  test('parks interrupted as the system, with reason, notice turn, alert, and feedback still owed', async () => {
    const task = await storage.createTask('Do a thing', undefined, 'abc');
    const session = await storage.createSession(task.id, 'codex-subscription', `lazy/${task.id}`, 'abc');
    await storage.createTurn({
      sessionId: session.id,
      sequence: await storage.getNextTurnSequence(session.id),
      role: 'human',
      content: 'Please do the thing.',
      actor: 'human',
      carriesFeedback: true,
    });
    await storage.updateTaskStatus(task.id, 'working', 'human');

    const current = (await storage.getTask(task.id))!;
    await recordLaunchFailure(storage, current, session.id, new Error('image layer could not be extracted'), root);

    const after = (await storage.getTask(task.id))!;
    expect(after.status).toBe('interrupted');

    const changes = JSON.parse(await readFile(join(storage.getTaskDir(task.id), 'status-changelog.json'), 'utf-8')).changes;
    const park = changes.at(-1);
    expect(park.status).toBe('interrupted');
    expect(park.actor).not.toBe('human');
    expect(park.reason).toContain('image layer could not be extracted');

    const turns = await storage.getSessionTurns(session.id);
    const notice = turns.at(-1)!;
    expect(notice.failure?.class).toBe('launch_failed');
    // The human's feedback is still owed to the next turn.
    expect(turns.find(t => t.role === 'human')!.feedback_delivery).toBe('pending');

    const label = taskTurnFailure(after, await storage.getSessionByTaskId(task.id));
    expect(label?.class).toBe('launch_failed');

    const alerts = (await storage.listSystemMessages()).filter(m => m.kind === 'alert');
    expect(alerts.length).toBe(1);
  });

  test('the next work turn clears the derived label', async () => {
    const task = await storage.createTask('Do a thing', undefined, 'abc');
    const session = await storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, 'abc');
    await storage.updateTaskStatus(task.id, 'working', 'human');
    await recordLaunchFailure(storage, (await storage.getTask(task.id))!, session.id, new Error('boom'), root);
    expect((await storage.getSessionByTaskId(task.id))!.last_turn_failure?.class).toBe('launch_failed');

    await storage.createTurn({
      sessionId: session.id,
      sequence: await storage.getNextTurnSequence(session.id),
      role: 'human',
      content: 'again',
    });
    expect((await storage.getSessionByTaskId(task.id))!.last_turn_failure).toBeUndefined();
  });

  // INVARIANT: feedback saved while a launch was REFUSED ran nothing, so it
  // must not clear the failure the last turn that did run ended in.
  test('a withheld feedback turn keeps the label', async () => {
    const task = await storage.createTask('Do a thing', undefined, 'abc');
    const session = await storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, 'abc');
    await storage.updateTaskStatus(task.id, 'working', 'human');
    await recordLaunchFailure(storage, (await storage.getTask(task.id))!, session.id, new Error('boom'), root);
    await storage.createTurn({
      sessionId: session.id,
      sequence: await storage.getNextTurnSequence(session.id),
      role: 'human',
      content: 'again',
      feedbackWithheld: true,
    });
    expect((await storage.getSessionByTaskId(task.id))!.last_turn_failure?.class).toBe('launch_failed');
  });
});
