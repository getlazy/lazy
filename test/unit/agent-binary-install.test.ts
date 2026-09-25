import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { lstatSync, realpathSync, utimesSync } from 'fs';
import {
  AGENT_BINARY_TMP_PREFIX,
  adoptLegacyAgentBinary,
  adoptVersionedAgentBinary,
  agentBinaryContentId,
  agentBinaryPointerPath,
  atomicInstallAgentBinary,
  installVersionedAgentBinary,
  legacyAgentBinaryPath,
  listInstalledAgentBinaries,
  pruneAgentBinaries,
  resolveInstalledAgentBinary,
  updateAgentBinaryPointer,
  versionedAgentBinaryPath,
} from '../../src/agent/binary-install';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';

/**
 * INVARIANT: ~/.lazy/bin/lazy-agent is installed with same-directory temp +
 * rename — readers never observe a partial Bun runtime mid-write.
 */
describe('atomicInstallAgentBinary', () => {
  let testDir: string;
  let destPath: string;

  const agentLike = (marker: string) => {
    const head = '\u007fELF' + AGENT_SELFCHECK_SENTINEL + ' 0.0.0-test ' + marker;
    return Buffer.from(head + 'x'.repeat(4096 - head.length));
  };

  beforeEach(() => {
    testDir = join(tmpdir(), `lazy-agent-install-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    destPath = join(testDir, 'lazy-agent');
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  test('installs to the destination path', async () => {
    await atomicInstallAgentBinary(destPath, agentLike('A'));
    expect(existsSync(destPath)).toBe(true);
    expect(readdirSync(testDir)).toEqual(['lazy-agent']);
  });

  test('temp files use the shared prefix and are removed after install', async () => {
    await atomicInstallAgentBinary(destPath, agentLike('A'));
    const leftovers = readdirSync(testDir).filter((f) => f.startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(statSync(destPath).mode & 0o111).toBeGreaterThan(0);
  });

  test('replace swaps inode instead of rewriting in place', async () => {
    await atomicInstallAgentBinary(destPath, agentLike('A'));
    const oldIno = statSync(destPath).ino;

    await atomicInstallAgentBinary(destPath, agentLike('B'));
    expect(statSync(destPath).ino).not.toBe(oldIno);
    expect(agentLike('B').equals(await Bun.file(destPath).arrayBuffer().then((b) => Buffer.from(b)))).toBe(true);
  });

  // INVARIANT: during replace the destination path never holds partial bytes.
  // We cannot observe a real mid-write window without kernel hooks; the contract
  // is temp-in-same-dir + rename, so the destination is untouched until rename.
  test('destination is untouched until rename completes', async () => {
    writeFileSync(destPath, agentLike('OLD'));
    const before = statSync(destPath);

    await atomicInstallAgentBinary(destPath, agentLike('NEW'));

    expect(statSync(destPath).ino).not.toBe(before.ino);
    expect(readdirSync(testDir).some((f) => f.startsWith(AGENT_BINARY_TMP_PREFIX))).toBe(false);
  });
});

/** Same stand-in "compiled agent" bytes the suites above use. */
const agentLikeBytes = (marker: string) => {
  const head = 'ELF' + AGENT_SELFCHECK_SENTINEL + ' 0.0.0-test ' + marker;
  return Buffer.from(head + 'x'.repeat(4096 - head.length));
};

/**
 * INVARIANT: an agent binary installs under a name derived from its BYTES, and
 * an install that already exists and verifies is NEVER rewritten.
 *
 * Both halves are load-bearing. Containers bind-mount the versioned file, and a
 * Docker Desktop file bind mount re-resolves the HOST PATH on every access
 * (verified 2026-09-01 — see the header of src/agent/binary-install.ts), so a
 * writer landing on a mounted path IS visible inside running containers. And an
 * older `lazy` process re-extracts its own embedded agent at every launch; the
 * never-rewrite rule is what stops it from writing ~100MB over a binary that is
 * already correct, which under the old single-path layout silently downgraded a
 * freshly upgraded install.
 */
describe('content-addressed agent binary installs', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = join(tmpdir(), `lazy-agent-versioned-${randomUUID()}`);
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(binDir)) rmSync(binDir, { recursive: true, force: true });
  });

  test('installs under lazy-agent-<content-id>, never the pointer name', async () => {
    const bytes = agentLikeBytes('A');
    const result = await installVersionedAgentBinary(binDir, bytes);

    expect(result.installed).toBe(true);
    expect(result.contentId).toBe(agentBinaryContentId(bytes));
    expect(result.path).toBe(versionedAgentBinaryPath(binDir, result.contentId));
    expect(result.path).not.toBe(agentBinaryPointerPath(binDir));
    expect(statSync(result.path).mode & 0o111).toBeGreaterThan(0);
  });

  test('re-installing identical bytes does not rewrite the file', async () => {
    const first = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    const before = statSync(first.path);

    const second = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    expect(second.installed).toBe(false);
    expect(second.path).toBe(first.path);
    expect(statSync(first.path).ino).toBe(before.ino);
    expect(statSync(first.path).mtimeMs).toBe(before.mtimeMs);
  });

  test('a different build of identical size lands beside the old one', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    const b = await installVersionedAgentBinary(binDir, agentLikeBytes('B'));

    expect(b.path).not.toBe(a.path);
    expect(existsSync(a.path)).toBe(true);
    expect((await listInstalledAgentBinaries(binDir)).sort()).toEqual([a.path, b.path].sort());
  });

  test('adopting a built temp file keeps an existing verified install', async () => {
    const bytes = agentLikeBytes('A');
    const contentId = agentBinaryContentId(bytes);
    const first = await installVersionedAgentBinary(binDir, bytes, contentId);
    const before = statSync(first.path);

    const tmpPath = join(binDir, `${AGENT_BINARY_TMP_PREFIX}${randomUUID()}`);
    writeFileSync(tmpPath, bytes);
    const adopted = await adoptVersionedAgentBinary(binDir, tmpPath, contentId);

    expect(adopted.installed).toBe(false);
    expect(adopted.path).toBe(first.path);
    expect(statSync(first.path).ino).toBe(before.ino);
    // The temp file is discarded rather than renamed over the install.
    expect(existsSync(tmpPath)).toBe(false);
  });

  test('the pointer is a symlink resolving to the current install', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    await updateAgentBinaryPointer(binDir, a.path);

    const pointer = agentBinaryPointerPath(binDir);
    expect(lstatSync(pointer).isSymbolicLink()).toBe(true);
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(a.path));

    const b = await installVersionedAgentBinary(binDir, agentLikeBytes('B'));
    await updateAgentBinaryPointer(binDir, b.path, { force: b.installed });
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(b.path));
    // Repointing never disturbs the install a running container mounts.
    expect(existsSync(a.path)).toBe(true);
  });

  // INVARIANT: the legacy ~/.lazy/bin/lazy-agent path is NEVER written to.
  // It is the mount source of every container created before this layout, and
  // the mount tracks the host path — so replacing it (even with a one-byte
  // symlink, whose relative target does not exist inside the container) is the
  // same swap-under-a-live-mount failure, moved to the migration moment.
  test('adopts a legacy single-path binary without touching it', async () => {
    const legacy = legacyAgentBinaryPath(binDir);
    writeFileSync(legacy, agentLikeBytes('LEGACY'), { mode: 0o755 });
    const before = statSync(legacy);

    const adopted = (await adoptLegacyAgentBinary(binDir))!;
    expect(adopted.path).toBe(
      versionedAgentBinaryPath(binDir, agentBinaryContentId(agentLikeBytes('LEGACY'))),
    );

    // Same inode, same bytes, still a regular file — after adoption AND after
    // the pointer has been written.
    await updateAgentBinaryPointer(binDir, adopted.path, { force: adopted.installed });
    const after = statSync(legacy);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(false);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(legacy)).toEqual(agentLikeBytes('LEGACY'));

    // The pointer is a DIFFERENT name that was never a mount source.
    expect(agentBinaryPointerPath(binDir)).not.toBe(legacy);
    expect(lstatSync(agentBinaryPointerPath(binDir)).isSymbolicLink()).toBe(true);
  });

  test('adoption is a no-op when there is no legacy file', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    await updateAgentBinaryPointer(binDir, a.path, { force: true });
    expect(await adoptLegacyAgentBinary(binDir)).toBeNull();
  });

  // INVARIANT: only a process that installed bytes advances the pointer.
  // A pre-upgrade `lazy` re-extracting its own embedded agent otherwise drags
  // the pointer back to its version on every relaunch while the upgraded daemon
  // flips it forward — `lazy doctor` and the selfcheck probe then flap.
  test('a non-installing caller does not repoint a valid pointer', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    const b = await installVersionedAgentBinary(binDir, agentLikeBytes('B'));
    await updateAgentBinaryPointer(binDir, b.path, { force: true });

    await updateAgentBinaryPointer(binDir, a.path);
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(b.path));

    await updateAgentBinaryPointer(binDir, a.path, { force: true });
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(a.path));
  });

  test('a missing or dangling pointer is adopted without force', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    await updateAgentBinaryPointer(binDir, a.path);
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(a.path));

    // Dangle it: the install it names is gone.
    rmSync(a.path);
    const b = await installVersionedAgentBinary(binDir, agentLikeBytes('B'));
    await updateAgentBinaryPointer(binDir, b.path);
    expect(await resolveInstalledAgentBinary(binDir)).toBe(realpathSync(b.path));
  });

  test('the pointer is not mistaken for an install', async () => {
    const a = await installVersionedAgentBinary(binDir, agentLikeBytes('A'));
    await updateAgentBinaryPointer(binDir, a.path, { force: true });
    expect(await listInstalledAgentBinaries(binDir)).toEqual([a.path]);
  });
});

/**
 * INVARIANT: garbage collection never deletes a binary a container could be
 * mounting. Unknown container state (docker unreachable) collects NOTHING, and a
 * recently installed binary is kept even when nothing references it yet —
 * `docker ps` cannot see a container that is being created right now.
 */
describe('pruneAgentBinaries', () => {
  let binDir: string;
  const OLD = Date.now() - 48 * 60 * 60 * 1000;

  const age = (path: string) => utimesSync(path, new Date(OLD), new Date(OLD));

  beforeEach(() => {
    binDir = join(tmpdir(), `lazy-agent-gc-${randomUUID()}`);
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(binDir)) rmSync(binDir, { recursive: true, force: true });
  });

  test('collects an old, unreferenced, non-current install', async () => {
    const old = await installVersionedAgentBinary(binDir, agentLikeBytes('OLD'));
    const current = await installVersionedAgentBinary(binDir, agentLikeBytes('NEW'));
    age(old.path);

    const removed = await pruneAgentBinaries(binDir, { keep: [current.path], referenced: [] });
    expect(removed).toEqual([old.path]);
    expect(existsSync(current.path)).toBe(true);
  });

  test('keeps an install a running container mounts', async () => {
    const old = await installVersionedAgentBinary(binDir, agentLikeBytes('OLD'));
    const current = await installVersionedAgentBinary(binDir, agentLikeBytes('NEW'));
    age(old.path);

    const removed = await pruneAgentBinaries(binDir, {
      keep: [current.path],
      referenced: [old.path, '/some/other/mount'],
    });
    expect(removed).toEqual([]);
    expect(existsSync(old.path)).toBe(true);
  });

  test('keeps an install younger than the grace period', async () => {
    const old = await installVersionedAgentBinary(binDir, agentLikeBytes('OLD'));
    const current = await installVersionedAgentBinary(binDir, agentLikeBytes('NEW'));

    const removed = await pruneAgentBinaries(binDir, { keep: [current.path], referenced: [] });
    expect(removed).toEqual([]);
    expect(existsSync(old.path)).toBe(true);
  });

  // The legacy file is never overwritten, so GC is the ONLY thing that ever
  // removes it — and only once no running container mounts it.
  test('collects an old legacy binary nothing mounts', async () => {
    const legacy = legacyAgentBinaryPath(binDir);
    writeFileSync(legacy, agentLikeBytes('LEGACY'), { mode: 0o755 });
    const current = await installVersionedAgentBinary(binDir, agentLikeBytes('NEW'));
    age(legacy);

    const removed = await pruneAgentBinaries(binDir, { keep: [current.path], referenced: [] });
    expect(removed).toEqual([legacy]);
  });

  test('keeps a legacy binary a pre-upgrade container still mounts', async () => {
    const legacy = legacyAgentBinaryPath(binDir);
    writeFileSync(legacy, agentLikeBytes('LEGACY'), { mode: 0o755 });
    const current = await installVersionedAgentBinary(binDir, agentLikeBytes('NEW'));
    age(legacy);

    const removed = await pruneAgentBinaries(binDir, {
      keep: [current.path],
      referenced: [legacy],
    });
    expect(removed).toEqual([]);
    expect(existsSync(legacy)).toBe(true);
  });

  // INVARIANT: unknown container state collects nothing.
  test('collects nothing when the container runtime could not be queried', async () => {
    const old = await installVersionedAgentBinary(binDir, agentLikeBytes('OLD'));
    age(old.path);

    const removed = await pruneAgentBinaries(binDir, { referenced: null });
    expect(removed).toEqual([]);
    expect(existsSync(old.path)).toBe(true);
  });
});
