/**
 * Evidence of a damaged runner image is captured automatically, before the
 * self-repair removes anything (src/docker/damaged-image-evidence.ts).
 *
 * INVARIANT: the next layer-extraction failure explains itself. token-watch's
 * damage (2026-10-14/15) was intermittent and gone by the time anyone could
 * look; three rounds of by-hand diagnostics on the engineer's Mac were the
 * cost. So the daemon records the failing blob (digest vs actual hash, size,
 * where gzip fails, a hex window) and what else was going on, bounded and with
 * readable text withheld, before the repair deletes the evidence.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import {
  EVIDENCE_MAX_CHARS, collectDamagedImageEvidence, examineBlob, failingLayerDigest, safeHexDump,
} from '../../src/docker/damaged-image-evidence';
import {
  DamagedImageError, resetDamagedImageRepairForTests, setDamagedImageReporter, withDamagedImageRepair,
  type DamagedImageRepairEvent,
} from '../../src/docker/damaged-image';
import {
  EVIDENCE_HEADING, damagedImageDoctorResult, damagedImageJournalEntry, damagedImageSystemMessage, recordDamagedImageRepair,
} from '../../src/daemon/damaged-image-record';

const SECRET = 'sk-live-THIS-MUST-NEVER-BE-RECORDED';

let dir: string;
let blobs: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'damaged-evidence-'));
  blobs = join(dir, 'root', 'containerd', 'daemon', 'io.containerd.content.v1.content', 'blobs', 'sha256');
  await mkdir(blobs, { recursive: true });
});

afterEach(async () => {
  resetDamagedImageRepairForTests();
  await rm(dir, { recursive: true, force: true });
});

/** A gzip layer filed under its digest, then damaged: 4 KiB at 64 KiB overwritten with `junk`. */
async function damagedBlob(junk: Buffer): Promise<{ digest: string; path: string }> {
  const random = randomBytes(400_000); // incompressible, so the blob is far larger than the damaged offset
  const gz = gzipSync(Buffer.concat([random, Buffer.from('x'.repeat(200_000))]), { level: 1 });
  const digest = createHash('sha256').update(gz).digest('hex');
  junk.copy(gz, 65536);
  const path = join(blobs, digest);
  await writeFile(path, gz);
  return { digest, path };
}

describe('the failing blob', () => {
  test('the blob digest is read from Docker\'s extraction error', () => {
    const d = 'c315cf96' + '0'.repeat(56);
    expect(failingLayerDigest(`docker: Error response from daemon: apply layer error for "": failed to extract layer sha256:${d}: archive/tar: invalid tar header`)).toBe(d);
    expect(failingLayerDigest('failed to extract layer sha256:c315cf96…: archive/tar: invalid tar header')).toBeNull();
  });

  // INVARIANT: layer bytes can hold anything a Dockerfile copied in, so the
  // hex window never shows a readable run — only that one was there.
  test('the hex window withholds readable text', () => {
    const buf = Buffer.concat([Buffer.from([0x01, 0xff, 0x10]), Buffer.from(SECRET), Buffer.from([0x00, 0x02])]);
    const lines = safeHexDump(buf, 4096).join('\n');
    expect(lines).not.toContain(Buffer.from(SECRET).toString('hex').slice(0, 16));
    expect(lines).toContain('01 ff 10 ..');
    expect(lines).toContain(`${SECRET.length} bytes of readable text withheld`);
  });

  test('a damaged blob: its real hash, its size, where gzip fails, and no readable text', async () => {
    const junk = Buffer.alloc(4096, 0x5a);
    Buffer.from(SECRET).copy(junk, 100);
    const { digest, path } = await damagedBlob(junk);
    const x = await examineBlob(path, digest);
    expect(x.actualDigest).not.toBe(digest);
    expect(x.size).toBeGreaterThan(65536);
    expect(x.gzipFailure).not.toBeNull();
    expect(x.hexWindow?.lines.join('\n') ?? '').not.toContain('sk-live');
  });
});

describe('collecting the evidence', () => {
  async function fakeDocker(): Promise<string> {
    const bin = join(dir, 'docker');
    const ns = BigInt(Date.parse('2026-10-15T19:20:00Z')) * 1_000_000n;
    await writeFile(bin, `#!/bin/sh
case "$1" in
  info) echo "${join(dir, 'root')}" ;;
  events) echo "${ns} delete sha256:aaaa"; echo "${ns} pull debian:bookworm-slim" ;;
esac
exit 0
`);
    await chmod(bin, 0o755);
    return bin;
  }

  test('the blob, the dockerd history and Docker\'s image events, bounded', async () => {
    const { digest } = await damagedBlob(Buffer.alloc(4096, 0x5a));
    const history = join(dir, 'restarts.log');
    await writeFile(history, '=== 2026-10-15T19:19:04Z resetting docker storage /storage/docker: requested\nnoise\n');
    const text = await collectDamagedImageEvidence({
      binary: await fakeDocker(), imageName: 'lazy-runner:0.91', historyLog: history,
      dockerMessage: `failed to extract layer sha256:${digest}: archive/tar: invalid tar header`,
    });
    expect(text).toContain(`Blob ${digest}`);
    expect(text).toContain('NOT to its name');
    expect(text).toContain('resetting docker storage');
    expect(text).toContain('2026-10-15T19:20:00.000Z delete sha256:aaaa');
    expect(text).toContain('lazy image builds in the last hour');
    expect(text.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS + 100);
  });

  test('a blob that is not in the store, or a message without a digest, says so', async () => {
    const binary = await fakeDocker();
    const gone = await collectDamagedImageEvidence({ binary, imageName: 'i', historyLog: join(dir, 'none'), dockerMessage: `failed to extract layer sha256:${'a'.repeat(64)}: x` });
    expect(gone).toContain('no such blob in the content store');
    expect(gone).toContain('dockerd history: none on this machine');
    const nameless = await collectDamagedImageEvidence({ binary, imageName: 'i', historyLog: join(dir, 'none'), dockerMessage: 'invalid tar header' });
    expect(nameless).toContain('names no full layer digest');
  });
});

describe('the repair records it', () => {
  async function loggingDocker(log: string): Promise<string> {
    const bin = join(dir, 'docker-rm');
    await writeFile(bin, `#!/bin/sh\necho "docker $*" >> "${log}"\nexit 0\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  // INVARIANT: the evidence is collected BEFORE the image is removed — after
  // the removal there is nothing left to examine.
  test('evidence is collected before the image is removed, and reaches the record', async () => {
    const log = join(dir, 'calls.log');
    const events: DamagedImageRepairEvent[] = [];
    setDamagedImageReporter(async (e) => { events.push(e); });
    let launches = 0;
    await withDamagedImageRepair({
      binary: await loggingDocker(log), subject: 'task', canRebuild: async () => true, rebuild: async () => {},
      collectEvidence: async () => { await writeFile(log, 'evidence\n', { flag: 'a' }); return 'the evidence'; },
    }, async () => {
      if (++launches === 1) throw new DamagedImageError('lazy-runner:0.91', 'failed to extract layer');
      return 'ok';
    });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['evidence', 'docker image rm lazy-runner:0.91']);
    expect(events[0].evidence).toBe('the evidence');
  });

  test('a collector that fails does not stop the repair', async () => {
    const events: DamagedImageRepairEvent[] = [];
    setDamagedImageReporter(async (e) => { events.push(e); });
    let launches = 0;
    const result = await withDamagedImageRepair({
      binary: await loggingDocker(join(dir, 'c2.log')), subject: 'task', canRebuild: async () => true, rebuild: async () => {},
      collectEvidence: async () => { throw new Error('disk on fire'); },
    }, async () => {
      if (++launches === 1) throw new DamagedImageError('lazy-runner:0.91', 'failed to extract layer');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(events[0].outcome).toBe('repaired');
    expect(events[0].evidence).toContain('could not be collected: disk on fire');
  });

  test('journal and system message carry the evidence; a message with evidence is never collapsed', async () => {
    const event: DamagedImageRepairEvent = {
      outcome: 'repaired', imageName: 'lazy-runner:0.91', subject: 'task', taskId: 't1',
      dockerMessage: 'failed to extract layer', evidence: 'Blob abc: hashes to def',
    };
    expect(damagedImageJournalEntry(event)).toContain(`${EVIDENCE_HEADING}\n\n\`\`\`\nBlob abc`);
    expect(damagedImageSystemMessage(event).body).toContain(`${EVIDENCE_HEADING}\nBlob abc`);
    const calls: Array<{ collapseRepeats?: boolean }> = [];
    await recordDamagedImageRepair({
      createSystemMessage: async (_i, o) => { calls.push(o ?? {}); return {} as never; },
      getTask: async () => ({ id: 't1' }),
      appendJournalEntry: async () => undefined,
    }, event);
    expect(calls[0].collapseRepeats).toBe(false);
  });

  // INVARIANT: a repeat (a relaunch hitting damage whose repair already failed)
  // collapses into the open alert and adds no journal entry — auto-resume
  // relaunches a stuck task many times.
  test('a repeat collapses into the open alert and adds no journal entry', async () => {
    const calls: Array<{ collapseRepeats?: boolean }> = [];
    let journal = 0;
    await recordDamagedImageRepair({
      createSystemMessage: async (_i, o) => { calls.push(o ?? {}); return {} as never; },
      getTask: async () => ({ id: 't1' }),
      appendJournalEntry: async () => { journal++; },
    }, { outcome: 'failed', imageName: 'lazy-runner:0.91', subject: 'task', taskId: 't1', dockerMessage: 'failed to extract layer', error: 'x', repeat: true });
    expect(calls[0].collapseRepeats).toBe(true);
    expect(journal).toBe(0);
  });
});

describe('god mode\'s Doctor', () => {
  const msg = (title: string, body: string, created_at: number) => ({ source: 'machine-docker', title, body, created_at });

  test('nothing recorded is a pass', () => {
    expect(damagedImageDoctorResult([]).ok).toBe(true);
    expect(damagedImageDoctorResult([msg('Docker stopped in this project\'s machine and was restarted', 'x', 1)]).warning).toBeUndefined();
  });

  test('a repaired image is a warning carrying the newest evidence; an unrepaired one fails with the reset remedy', () => {
    const repaired = damagedImageDoctorResult([
      msg("A damaged runner image was rebuilt in this project's machine", `old\n${EVIDENCE_HEADING}\nold evidence`, 1),
      msg("A damaged runner image was rebuilt in this project's machine", `new\n${EVIDENCE_HEADING}\nnew evidence`, 2),
    ]);
    expect(repaired.ok).toBe(true);
    expect(repaired.warning).toContain('new evidence');
    expect(repaired.warning).not.toContain('old evidence');
    const failed = damagedImageDoctorResult([msg("A damaged runner image could not be repaired in this project's machine", 'body', 3)]);
    expect(failed.ok).toBe(false);
    expect(failed.remedy).toContain('Reset Docker storage');
  });
});
