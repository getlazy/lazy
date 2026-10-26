import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import { readImageBuildHistory, resetImageBuildJobsForTests, startImageBuildJob } from '../../src/daemon/image-build-job';
import type { Redactor } from '../../src/daemon/observability-redaction';

const createRedactor = (_secrets: string[], complete = true): Redactor => ({
  complete,
  redact: text => text.replaceAll("test-secret-value", "[REDACTED]"),
  redactField: (_field, text) => text.replaceAll("test-secret-value", "[REDACTED]"),
});

let root: string;
let storage: FileStorage;
beforeEach(async () => {
  resetImageBuildJobsForTests();
  root = await mkdtemp(join(tmpdir(), 'lazy-archive-recovery-'));
  storage = new FileStorage(root, { basePath: join(root, 'store') });
  await storage.initialize();
});
afterEach(async () => {
  resetImageBuildJobsForTests();
  await storage.close();
  await rm(root, { recursive: true, force: true });
});

class UnavailableStorage extends FileStorage {
  unavailable = true;
  override async appendImageBuildLog(id: string, lines: string): Promise<void> {
    if (this.unavailable) throw new Error('temporary write failure');
    return super.appendImageBuildLog(id, lines);
  }
}

// INVARIANT: a temporary archive failure cannot discard lines or poison other builds.
test('failed batches and subsequent lines are recovered while healthy history remains readable', async () => {
  const failing = new UnavailableStorage(root, { basePath: join(root, 'store') });
  const redactor = createRedactor(['test-secret-value']);
  const job = startImageBuildJob('project', 'recovering build');
  job.enableArchive(root, async () => ({ storage: failing, redactor }));
  job.note('first test-secret-value');
  await expect(job.flushArchive()).rejects.toThrow('temporary write failure');
  job.note('second');
  job.finish('succeeded');
  const healthy = startImageBuildJob('project', 'healthy build');
  healthy.enableArchive(root, async () => ({ storage, redactor }));
  healthy.note('healthy log');
  healthy.finish('succeeded');
  const history = await readImageBuildHistory(storage);
  expect(history.find(row => row.id === job.id)?.build.archiveError).toContain('temporary write failure');
  expect(history.find(row => row.id === healthy.id)?.build.outcome).toBe('succeeded');
  failing.unavailable = false;
  await job.flushArchive();
  const page = await storage.readImageBuildLog(job.id, 0, 20);
  expect(page.lines.map(line => line.seq)).toEqual([1, 2, 3]);
  expect(page.lines[0].text).not.toContain('test-secret-value');
  expect(page.lines[1].text).toBe('second');
  expect(job.archiveFailure()).toBeNull();
  expect((await storage.listImageBuilds()).find(row => row.id === job.id)?.build.outcome).toBe('succeeded');
});

// INVARIANT: retrying redaction never archives text before all secret registries are available.
test('an unavailable redactor can recover without writing unredacted logs', async () => {
  let complete = false;
  const job = startImageBuildJob('project', 'redactor recovery');
  job.enableArchive(root, async () => ({ storage, redactor: createRedactor(['test-secret-value'], complete) }));
  job.note('test-secret-value');
  await expect(job.flushArchive()).rejects.toThrow('redactor is unavailable');
  expect(await storage.listImageBuilds()).toHaveLength(0);
  complete = true;
  job.finish('succeeded');
  await job.flushArchive();
  const page = await storage.readImageBuildLog(job.id, 0, 20);
  expect(page.lines).toHaveLength(2);
  expect(JSON.stringify(page)).not.toContain('test-secret-value');
});

// INVARIANT: orphaned running builds are terminal after restart and cannot escape log retention.
test('restart settles an interrupted build and expires its old log while preserving live builds', async () => {
  const interrupted = startImageBuildJob('project', 'interrupted build');
  interrupted.enableArchive(root, async () => ({ storage, redactor: createRedactor([]) }));
  interrupted.note('saved before restart');
  await interrupted.flushArchive();
  resetImageBuildJobsForTests();
  const live = startImageBuildJob('project', 'still running');
  live.enableArchive(root, async () => ({ storage, redactor: createRedactor([]) }));
  live.note('live log');
  await live.flushArchive();
  for (let i = 1; i <= 21; i++) {
    const id = `project-${i}-abcdef`;
    await storage.appendImageBuildLog(id, JSON.stringify({ seq: 1, text: 'finished' }) + '\n');
    await storage.saveImageBuild({ id, build: { id, outcome: 'succeeded', startedAt: new Date(Date.now() + i * 1000).toISOString() }, logsRetained: true });
  }
  await readImageBuildHistory(storage);
  const rows = await storage.listImageBuilds();
  expect(rows.find(row => row.id === interrupted.id)?.build.outcome).toBe('interrupted');
  expect(rows.find(row => row.id === interrupted.id)?.logsRetained).toBe(false);
  expect((await storage.readImageBuildLog(interrupted.id, 0, 10)).lines).toHaveLength(0);
  expect(rows.find(row => row.id === live.id)?.build.outcome).toBe('running');
  expect((await storage.readImageBuildLog(live.id, 0, 10)).lines).toHaveLength(1);
  expect(rows.filter(row => row.logsRetained && row.build.outcome !== 'running')).toHaveLength(20);
});

// INVARIANT: summary requests never wait for a full-log write/backfill to complete.
test('metadata-only history stays readable while the archive writer is blocked', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const job = startImageBuildJob('project', 'slow archive');
  job.enableArchive(root, async () => {
    await blocked;
    return { storage, redactor: createRedactor([]) };
  });
  job.note('waiting to archive');
  try {
    const rows = await readImageBuildHistory(storage, { flush: false });
    expect(rows.find(row => row.id === job.id)?.build.lastSeq).toBe(1);
    expect(rows.find(row => row.id === job.id)?.build.outcome).toBe('running');
  } finally {
    release();
    job.finish('succeeded');
    await job.flushArchive();
  }
});
