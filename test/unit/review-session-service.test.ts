/**
 * Unit tests: daemon ReviewSessionActions + headless builder turn orchestration.
 *
 * The launcher is stubbed — these tests pin durable-write ordering, idle-resume
 * behavior, preamble-once semantics, and credential refusal without Docker.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initDaemonStorage,
  getOrCreateStorage,
  closeAllStorage,
} from '../../src/daemon/rpc-handlers';
import { createReviewSessionActions } from '../../src/daemon/review-session-service';
import {
  assertReviewSessionActorCredential,
  type ReviewSessionTurnLauncher,
} from '../../src/daemon/review-session-builder-turn';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { putUserCredential, teamModeEnabled } from '../../src/daemon/user-credentials';
import { TurnCredentialUnavailableError } from '../../src/daemon/turn-credentials';

describe('review session service', () => {
  let root: string;
  let prevLazyConfig: string | undefined;
  let launchCalls: Array<{ prompt: string; resumeSessionId?: string | null }>;
  let launcher: ReviewSessionTurnLauncher;

  const testPreamble =
    '## Review session — demo\n\n(stub preamble)\n\nOpen items and initial read first; then wait for the human.';

  function actions() {
    return createReviewSessionActions(root, {
      launchTurn: launcher,
      assembleFirstMessage: async () => testPreamble,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-review-session-svc-'));
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);

    launchCalls = [];
    launcher = mock(async (input) => {
      launchCalls.push({ prompt: input.prompt, resumeSessionId: input.resumeSessionId ?? null });
      return { answer: 'builder says hello', sessionId: 'sess-new-1' };
    }) as ReviewSessionTurnLauncher;
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  async function blockedTask() {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Review me');
    await storage.updateTaskStatus(task.id, 'blocked');
    return task;
  }

  test('start creates session, stores preamble as first human message, calls launch once', async () => {
    const task = await blockedTask();
    const session = await actions().start(task.id);
    expect(session.task_id).toBe(task.id);

    // Wait for background dispatch.
    await new Promise(r => setTimeout(r, 50));

    const storage = await getOrCreateStorage();
    const reloaded = await storage.getReviewSessionByTaskId(task.id);
    expect(reloaded).not.toBeNull();
    const messages = await storage.listReviewSessionMessages(reloaded!.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('human');
    expect(messages[0].content).toContain('Review session —');
    expect(messages[0].content).toContain('Open items and initial read first');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('builder says hello');
    expect(reloaded!.resume_session_id).toBe('sess-new-1');
    expect(reloaded!.status).toBe('idle');
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].prompt).toContain('Review session —');
    expect(launchCalls[0].resumeSessionId).toBeNull();
  });

  test('start on existing idle session does NOT re-assemble preamble or launch', async () => {
    const task = await blockedTask();
    const storage = await getOrCreateStorage();
    const existing = await storage.createReviewSession(task.id);
    await storage.appendReviewSessionMessage(existing.id, {
      role: 'human',
      content: 'prior preamble',
      delivery: 'launched',
    });
    await storage.updateReviewSession(existing.id, { resumeSessionId: 'sess-old' });

    const returned = await actions().start(task.id);
    await new Promise(r => setTimeout(r, 30));

    expect(returned.id).toBe(existing.id);
    expect(launchCalls).toHaveLength(0);
    const messages = await storage.listReviewSessionMessages(existing.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('prior preamble');
  });

  test('send appends then launches with follow-up text only (prompt excludes preamble header)', async () => {
    const task = await blockedTask();
    const storage = await getOrCreateStorage();
    const session = await storage.createReviewSession(task.id);
    await storage.appendReviewSessionMessage(session.id, {
      role: 'human',
      content: '## Review session — foo\n\n(stored preamble)',
      delivery: 'launched',
    });
    await storage.updateReviewSession(session.id, { resumeSessionId: 'sess-resume-1' });

    await actions().send(task.id, 'What about the tests?');
    await new Promise(r => setTimeout(r, 50));

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].prompt).toBe('What about the tests?');
    expect(launchCalls[0].prompt).not.toContain('Review session —');
    expect(launchCalls[0].resumeSessionId).toBe('sess-resume-1');

    const messages = await storage.listReviewSessionMessages(session.id);
    const human = messages.filter(m => m.role === 'human');
    expect(human.some(m => m.content === 'What about the tests?')).toBe(true);
  });

  test('launch failure leaves message delivery=failed and content intact', async () => {
    const failingLauncher: ReviewSessionTurnLauncher = async () => {
      throw new Error('container exploded');
    };
    const task = await blockedTask();
    await createReviewSessionActions(root, {
      launchTurn: failingLauncher,
      assembleFirstMessage: async () => testPreamble,
    }).start(task.id);
    await new Promise(r => setTimeout(r, 50));

    const storage = await getOrCreateStorage();
    const session = await storage.getReviewSessionByTaskId(task.id);
    const messages = await storage.listReviewSessionMessages(session!.id);
    expect(messages[0].delivery).toBe('failed');
    expect(messages[0].content).toContain('Review session —');
    expect(session!.status).toBe('idle');
  });

  test('missing credential refuses before launch in team mode', async () => {
    // Any stored user credential puts the project on per-user billing.
    await putUserCredential(root, {
      userId: 'u-other',
      kind: 'oauth',
      token: 'oat-other',
      label: 'Other',
    });
    expect(await teamModeEnabled(root)).toBe(true);

    const task = await blockedTask();

    await expect(
      actions().start(task.id, { actor: { role: 'human', email: 'u-no-cred' } }),
    ).rejects.toThrow(NO_OWNER_CREDENTIAL_MARKER);

    expect(launchCalls).toHaveLength(0);

    const storage = await getOrCreateStorage();
    expect(await storage.getReviewSessionByTaskId(task.id)).toBeNull();
  });
});

describe('assertReviewSessionActorCredential', () => {
  let root: string;
  let prevLazyConfig: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-review-session-cred-'));
    const configPath = join(root, 'lazy.toml');
    await writeFile(
      configPath,
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    prevLazyConfig = process.env.LAZY_CONFIG;
    process.env.LAZY_CONFIG = configPath;
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    if (prevLazyConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = prevLazyConfig;
    await rm(root, { recursive: true, force: true });
  });

  // The actor's email is the credential-registry key. The keys here are not
  // spelled as addresses because that validator does not admit an `@` yet —
  // widening it is the migration task's job
  // (docs/design/actor-identity-and-remote-clients.md §3.8).
  test('refuses a user with no stored credential when team mode is on', async () => {
    await putUserCredential(root, {
      userId: 'u-other',
      kind: 'oauth',
      token: 'oat-other',
      label: 'Other',
    });

    await expect(
      assertReviewSessionActorCredential(root, { role: 'human', email: 'u-nemo' }),
    ).rejects.toThrow(TurnCredentialUnavailableError);

    await expect(
      assertReviewSessionActorCredential(root, { role: 'human', email: 'u-nemo' }),
    ).rejects.toThrow(NO_OWNER_CREDENTIAL_MARKER);
  });

  test('passes when the acting user has a credential', async () => {
    await putUserCredential(root, {
      userId: 'u-ada',
      kind: 'oauth',
      token: 'oat-test',
      label: 'Ada',
    });

    await assertReviewSessionActorCredential(root, { role: 'human', email: 'u-ada' });
  });
});
