import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';

test('image history retains summaries while expiring only older complete logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-build-history-'));
  const storage = new FileStorage(root, { basePath: join(root, 'store') });
  try {
    await storage.initialize();
    for (let i = 1; i <= 21; i++) {
      const id = `project-${i}-abcdef`;
      await storage.appendImageBuildLog(id, JSON.stringify({ seq: 1, text: 'full log ' + i }) + '\n');
      await storage.saveImageBuild({ id, logsRetained: true, build: { id, outcome: 'succeeded', startedAt: new Date(i * 1000).toISOString(), lastSeq: 1 } });
    }
    // INVARIANT: retention expires logs, never a build's permanent summary.
    await storage.pruneImageBuildLogs(20);
    const builds = await storage.listImageBuilds();
    expect(builds).toHaveLength(21);
    expect(builds.filter(b => b.logsRetained)).toHaveLength(20);
    expect((await storage.readImageBuildLog('project-1-abcdef', 0, 20)).lines).toHaveLength(0);
    expect((await storage.readImageBuildLog('project-21-abcdef', 0, 20)).lines[0].text).toBe('full log 21');
    await storage.close();
    const reopened = new FileStorage(root, { basePath: join(root, 'store') });
    await reopened.initialize();
    try {
      expect(await reopened.listImageBuilds()).toHaveLength(21);
      expect((await reopened.readImageBuildLog('project-21-abcdef', 0, 20)).lines).toHaveLength(1);
      await expect(reopened.readImageBuildLog('../escape', 0, 20)).rejects.toThrow('Invalid image build id');
    } finally { await reopened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
