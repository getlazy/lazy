/**
 * The `builderTranscript` RPC Lazy Teams' Builder page renders from. Called
 * through `handleRpc`, because Teams' own tests use a stubbed daemon and cannot
 * notice a command that does not exist or a reply shape that moved.
 *
 * INVARIANT: the reply is the JOINED transcript of every segment, keyed by the
 * Builder id, whichever segment id asked. A remote page re-joining segments
 * itself would be a second copy of the ordering and de-duplication rule.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readdir, copyFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { parseConversation, extractSummary, conversationStats } from '../../src/import/claude-code-logs';
import { toStoredConversation } from '../../src/import/conversation-storage';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'builder-segments');
const A = 'aaaaaaaa-0000-4000-8000-000000000001'; // fresh start
const B = 'bbbbbbbb-0000-4000-8000-000000000002'; // compaction of A
const C = 'cccccccc-0000-4000-8000-000000000003'; // resume of B

describe('builderTranscript RPC', () => {
  let root: string;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-builder-transcript-'));
    const projects = join(root, 'projects');
    await mkdir(join(projects, '-repo'), { recursive: true });
    for (const f of await readdir(FIXTURES)) {
      if (f.endsWith('.jsonl')) await copyFile(join(FIXTURES, f), join(projects, '-repo', f));
    }
    await writeFile(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`,
    );
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    const storage = await getOrCreateStorage();
    for (const id of [A, B, C]) {
      const parsed = await parseConversation('-repo', id, projects);
      await storage.saveConversation(toStoredConversation(parsed, extractSummary(parsed), conversationStats(parsed)));
    }
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    await rm(root, { recursive: true, force: true });
  });

  test('a later segment id opens the whole Builder, joined', async () => {
    const res = await handleRpc('builderTranscript', root, { id: C }) as any;
    expect(res.builder.id).toBe(A);
    expect(res.builder.segments).toEqual([A, B, C]);
    expect(res.conversation.sessionId).toBe(A);
    expect(res.conversation.messages.map((m: any) => m.text)).toContain('Where were we?');
  });

  test('an unknown id is a 404 and a blank one a 400', async () => {
    await expect(handleRpc('builderTranscript', root, { id: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(handleRpc('builderTranscript', root, { id: ' ' })).rejects.toMatchObject({ status: 400 });
  });
});
