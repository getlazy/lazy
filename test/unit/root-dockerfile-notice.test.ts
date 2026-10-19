import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SystemMessage, SystemMessageInput } from '../../src/types';
import {
  maybePostRootDockerfileNotice,
  ROOT_DOCKERFILE_NOTICE_TITLE,
  resetRootDockerfileNoticeMemory,
} from '../../src/daemon/root-dockerfile-notice';
import { MANAGED_BACKEND_ENV, MANAGED_ENV } from '../../src/config/managed-mode';
import { MANAGED_STORAGE_ENV } from '../../src/config/managed';

/** In-memory stand-in for the two Storage methods the notice uses. */
function memoryInbox() {
  const messages: SystemMessage[] = [];
  return {
    messages,
    async listSystemMessages(options?: { includeDismissed?: boolean }) {
      return messages.filter(m => options?.includeDismissed || m.dismissed_at === undefined);
    },
    async createSystemMessage(input: SystemMessageInput) {
      const message = { ...input, id: `m${messages.length}`, created_at: Date.now() } as SystemMessage;
      messages.push(message);
      return message;
    },
  };
}

// INVARIANT: a committed root Dockerfile.lazy that this install's backend never
// builds (Lazy Teams local-docker) is announced as ONE open system message —
// launch narration reaches nobody on a Teams- or daemon-started turn, so this
// is what keeps the base-image fallback from being silent.
describe('root Dockerfile.lazy notice', () => {
  let root: string;
  const saved = {
    managed: process.env[MANAGED_ENV],
    backend: process.env[MANAGED_BACKEND_ENV],
    storage: process.env[MANAGED_STORAGE_ENV],
  };
  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
    expect(r.exitCode).toBe(0);
  };

  beforeEach(async () => {
    resetRootDockerfileNoticeMemory();
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-notice-')));
    git('init', '-q');
    await writeFile(join(root, 'lazy.toml'), '[docker]\ndockerfile = ""\n');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM lazy-runner\n');
    git('add', 'Dockerfile.lazy');
    git('commit', '-q', '-m', 'task image');
    setEnv(MANAGED_ENV, '1');
    setEnv(MANAGED_BACKEND_ENV, 'local-docker');
    setEnv(MANAGED_STORAGE_ENV, join(root, '.store'));
  });
  afterEach(async () => {
    setEnv(MANAGED_ENV, saved.managed);
    setEnv(MANAGED_BACKEND_ENV, saved.backend);
    setEnv(MANAGED_STORAGE_ENV, saved.storage);
    await rm(root, { recursive: true, force: true });
  });

  test('two passes file ONE notice, naming the owner remedy', async () => {
    const inbox = memoryInbox();
    await maybePostRootDockerfileNotice(inbox, root);
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].title).toBe(ROOT_DOCKERFILE_NOTICE_TITLE);
    expect(inbox.messages[0].kind).toBe('notice');
    expect(inbox.messages[0].body).toContain('[docker] dockerfile');
  });

  // INVARIANT: a dismissal holds until the accepted file CHANGES. Re-filing on
  // every reconciler tick undid each dismissal within seconds.
  test('a dismissed notice stays dismissed; a newly accepted Dockerfile.lazy is announced again', async () => {
    const inbox = memoryInbox();
    await maybePostRootDockerfileNotice(inbox, root);
    inbox.messages[0].dismissed_at = Date.now();
    for (let tick = 0; tick < 3; tick++) await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(1);

    // An unrelated commit moves HEAD without changing the file: still quiet.
    await writeFile(join(root, 'README.md'), 'x\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'unrelated');
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(1);

    // A new accepted Dockerfile.lazy is news.
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo v2\n');
    git('add', 'Dockerfile.lazy');
    git('commit', '-q', '-m', 'task image v2');
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(2);
  });

  // INVARIANT: the dismissal survives a daemon restart (Teams restarts every
  // daemon on each upgrade) — the notice names its blob, and one for that blob
  // is never filed again, open or dismissed.
  test('after a restart a dismissed notice for the same blob is not re-filed; an open one is reused', async () => {
    const inbox = memoryInbox();
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages[0].body).toMatch(/Committed version: [0-9a-f]{12}/);
    resetRootDockerfileNoticeMemory();
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(1);
    inbox.messages[0].dismissed_at = Date.now();
    resetRootDockerfileNoticeMemory();
    await maybePostRootDockerfileNotice(inbox, root);
    expect(inbox.messages).toHaveLength(1);
  });

  test('nothing is filed where the file is built (microvm, unmanaged)', async () => {
    const inbox = memoryInbox();
    setEnv(MANAGED_BACKEND_ENV, 'microvm');
    expect(await maybePostRootDockerfileNotice(inbox, root)).toBeNull();
    setEnv(MANAGED_ENV, undefined);
    expect(await maybePostRootDockerfileNotice(inbox, root)).toBeNull();
    expect(inbox.messages).toHaveLength(0);
  });

  test('nothing is filed when the owner names a Dockerfile explicitly', async () => {
    const inbox = memoryInbox();
    await writeFile(join(root, 'lazy.toml'), '[docker]\ndockerfile = "Dockerfile.lazy"\n');
    expect(await maybePostRootDockerfileNotice(inbox, root)).toBeNull();
  });
});
