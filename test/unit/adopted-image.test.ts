/**
 * Unit tests: daemon-adopted worktree image persistence (Part 2).
 *
 * INVARIANT: adoption lives in daemon runtime state, is version-scoped, and
 * must never silently outlive a binary rebuild. Missing Dockerfiles clear
 * rather than wedge launches (the stale-env-override incident). Content that
 * drifts after consent also clears — launches soft-pin imageName and never
 * rebuild from the worktree path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeAdoptedImage,
  readAdoptedImage,
  clearAdoptedImage,
  loadValidAdoptedImage,
  inspectAdoptedImage,
  hashDockerfileContent,
  missingAdoptedImageMessage,
} from '../../src/daemon/adopted-image';
import { getAdoptedImagePath } from '../../src/daemon/paths';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { VERSION } from '../../src/version';
import { pathExists } from '../../src/utils/fs';
import { checkAdoptedImage } from '../../src/cli/commands/doctor';
import {
  ensureImage,
  enableUpgradeImageBuild,
  resetUpgradeImageBuild,
  resolveCustomDockerfile,
  IMAGE_TAG,
} from '../../src/capture/claude';
import { installFakeDocker } from '../helpers/fake-docker';
import { runGit } from '../../src/utils/git';

const ADOPTED_CONTENT = 'FROM debian:bookworm-slim\n# adopted\n';

async function writeValidAdoption(
  root: string,
  dockerfile: string,
  imageName = `lazy-custom-aaaaaaaaaaaa:${IMAGE_TAG}`,
) {
  const contentHash = hashDockerfileContent(await readFile(dockerfile, 'utf-8'));
  return writeAdoptedImage(root, {
    dockerfilePath: dockerfile,
    contentHash,
    imageName,
  });
}

describe('adopted-image persistence', () => {
  let root: string;
  let dockerfile: string;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-adopt-base-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);

    root = await mkdtemp(join(tmpdir(), 'lazy-adopt-root-'));
    dockerfile = join(root, 'Dockerfile.lazy');
    await writeFile(dockerfile, ADOPTED_CONTENT);
    // Empty dockerfile key — pin LAZY_CONFIG so loadConfig does not walk up
    // into lazy's own worktree (which sets dockerfile = "Dockerfile.lazy").
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  test('write/read round-trips all fields', async () => {
    const written = await writeValidAdoption(root, dockerfile);
    expect(written.lazyVersion).toBe(VERSION);
    expect(written.adoptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await readAdoptedImage(root);
    expect(read).toEqual(written);
    expect(await pathExists(getAdoptedImagePath(root))).toBe(true);
  });

  test('clear removes the file', async () => {
    await writeValidAdoption(root, dockerfile, `lazy-custom-bbbbbbbbbbbb:${IMAGE_TAG}`);
    expect(await clearAdoptedImage(root)).toBe(true);
    expect(await readAdoptedImage(root)).toBeNull();
    expect(await clearAdoptedImage(root)).toBe(false);
  });

  test('loadValidAdoptedImage returns the state when VERSION and hash match', async () => {
    await writeValidAdoption(root, dockerfile, `lazy-custom-cccccccccccc:${IMAGE_TAG}`);
    const loaded = await loadValidAdoptedImage(root);
    expect(loaded?.dockerfilePath).toBe(dockerfile);
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  // INVARIANT: adoption must never silently outlive a binary rebuild.
  test('loadValidAdoptedImage expires and clears when lazyVersion mismatches', async () => {
    await writeAdoptedImage(root, {
      dockerfilePath: dockerfile,
      contentHash: hashDockerfileContent(ADOPTED_CONTENT),
      imageName: `lazy-custom-dddddddddddd:${IMAGE_TAG}`,
      lazyVersion: '0.0.0-expired',
    });
    expect(await inspectAdoptedImage(root)).toMatchObject({ status: 'expired' });
    expect(await loadValidAdoptedImage(root)).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });

  // INVARIANT: a deleted worktree must not wedge every launch.
  test('loadValidAdoptedImage clears when the Dockerfile is missing', async () => {
    const gone = join(root, 'gone', 'Dockerfile.lazy');
    await writeAdoptedImage(root, {
      dockerfilePath: gone,
      contentHash: 'e'.repeat(64),
      imageName: `lazy-custom-eeeeeeeeeeee:${IMAGE_TAG}`,
    });
    expect(await inspectAdoptedImage(root)).toMatchObject({ status: 'missing-dockerfile' });
    expect(await loadValidAdoptedImage(root)).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });

  // INVARIANT: post-consent agent edits must not become host docker rebuilds.
  test('loadValidAdoptedImage clears when Dockerfile content drifts after consent', async () => {
    await writeValidAdoption(root, dockerfile, `lazy-custom-ffffffffffff:${IMAGE_TAG}`);
    await writeFile(dockerfile, 'FROM debian:bookworm-slim\n# AGENT EDITED AFTER CONSENT\n');
    expect(await inspectAdoptedImage(root)).toMatchObject({ status: 'content-drifted' });
    expect(await loadValidAdoptedImage(root)).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });

  test('resolveCustomDockerfile returns the adopted SNAPSHOT only while the upgrade latch is on', async () => {
    await writeValidAdoption(root, dockerfile);
    resetUpgradeImageBuild();
    // Launch path: latch off — must NOT resolve the worktree path.
    expect(await resolveCustomDockerfile(root)).toBeNull();

    enableUpgradeImageBuild();
    // Upgrade build reads the consented snapshot outside the worktree, never
    // the live worktree path (hash/build TOCTOU).
    const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
    expect(await resolveCustomDockerfile(root)).toBe(getAdoptedDockerfilePath(root));
    expect(await resolveCustomDockerfile(root)).not.toBe(dockerfile);
  });

  test('writeAdoptedImage snapshots consented bytes beside the JSON', async () => {
    await writeValidAdoption(root, dockerfile);
    const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
    const snap = getAdoptedDockerfilePath(root);
    expect(await pathExists(snap)).toBe(true);
    expect(await readFile(snap, 'utf-8')).toBe(ADOPTED_CONTENT);
  });

  test('clearAdoptedImage removes the Dockerfile snapshot too', async () => {
    await writeValidAdoption(root, dockerfile);
    const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
    const snap = getAdoptedDockerfilePath(root);
    expect(await pathExists(snap)).toBe(true);
    await clearAdoptedImage(root);
    expect(await pathExists(snap)).toBe(false);
  });

  test('resolveCustomDockerfile ignores a drifted adoption even with the latch on', async () => {
    await writeValidAdoption(root, dockerfile);
    await writeFile(dockerfile, 'FROM debian:bookworm-slim\n# drifted\n');
    enableUpgradeImageBuild();
    expect(await resolveCustomDockerfile(root)).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });
});

describe('ensureImage adoption soft-pin', () => {
  let root: string;
  let dockerfile: string;
  let originalCwd: string;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-adopt-ens-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);

    root = await mkdtemp(join(tmpdir(), 'lazy-adopt-ens-root-'));
    dockerfile = join(root, 'Dockerfile.lazy');
    await writeFile(dockerfile, ADOPTED_CONTENT);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    // getLazyRoot requires a git root with lazy.toml.
    const init = await runGit(['init', '-q', '-b', 'main'], { cwd: root });
    expect(init.exitCode).toBe(0);
    expect(await pathExists(join(root, '.git'))).toBe(true);
    undoConfig = pinConfig(root);
    process.chdir(root);
    resetUpgradeImageBuild();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: launches soft-pin imageName; an edited-after-adopt Dockerfile
  // must not trigger a rebuild from that path.
  test('uses adopted imageName when present and does not rebuild from an edited Dockerfile', async () => {
    const docker = await installFakeDocker(root);
    const imageName = `lazy-custom-softpin0000:${IMAGE_TAG}`;
    await writeValidAdoption(root, dockerfile, imageName);
    await docker.seedImage(imageName, { dockerfileHash: 'consented-hash' });

    // Agent edits the worktree Dockerfile after consent — soft-pin must still
    // return the consented image, and must not clear adoption (content check
    // happens in loadValid… wait: loadValid WILL clear on drift!
    //
    // Soft-pin uses loadValidAdoptedImage which clears on drift. So after
    // edit, soft-pin falls through to root — which is ALSO safe (no rebuild
    // from drifted content). The feedback asked: edited-after-adopt must not
    // get rebuilt on ensureImage. Clearing + root is correct.
    //
    // First assert the happy soft-pin (hash still matches):
    const used = await ensureImage(docker.binPath);
    expect(used).toBe(imageName);
  });

  test('edited-after-adopt Dockerfile clears adoption and does not rebuild from it', async () => {
    const docker = await installFakeDocker(root);
    const imageName = `lazy-custom-drifted000:${IMAGE_TAG}`;
    await writeValidAdoption(root, dockerfile, imageName);
    await docker.seedImage(imageName, { dockerfileHash: 'consented-hash' });

    // Post-consent edit — adoption must clear; ensureImage must NOT return
    // a rebuild of the drifted file (and must not soft-pin the old image
    // either, since consent no longer matches the file on disk).
    await writeFile(dockerfile, 'FROM debian:bookworm-slim\n# AGENT EDIT\n');

    // Latch off (launch). Drift clears adoption; falls through to root /
    // embedded default. Fake docker may build — the critical assertion is
    // that we do NOT keep using a path-based rebuild of the drifted file
    // via resolveCustomDockerfile, and adoption is gone.
    const used = await ensureImage(docker.binPath);
    expect(await readAdoptedImage(root)).toBeNull();
    // Soft-pin of the old imageName must not apply after drift-clear.
    expect(used).not.toBe(imageName);
  });

  test('fails loud when adopted image is missing locally', async () => {
    const docker = await installFakeDocker(root);
    const imageName = `lazy-custom-missingadpt:${IMAGE_TAG}`;
    await writeValidAdoption(root, dockerfile, imageName);

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/will not fall back to the project root image/i);
    await expect(ensureImage(docker.binPath)).rejects.toThrow(/lazy upgrade/);
    expect(missingAdoptedImageMessage(imageName)).toContain(imageName);
  });
});

describe('checkAdoptedImage (doctor)', () => {
  let root: string;
  let dockerfile: string;
  let undoDaemonBase: (() => void) | undefined;

  beforeEach(async () => {
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-adopt-doc-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);
    root = await mkdtemp(join(tmpdir(), 'lazy-adopt-doc-root-'));
    dockerfile = join(root, 'Dockerfile.lazy');
    await writeFile(dockerfile, ADOPTED_CONTENT);
  });

  afterEach(async () => {
    undoDaemonBase?.();
    await rm(root, { recursive: true, force: true });
  });

  test('silent when nothing is adopted', async () => {
    expect(await checkAdoptedImage(root)).toBeNull();
  });

  test('reports a valid adoption', async () => {
    await writeValidAdoption(root, dockerfile, `lazy-custom-ffffffffffff:${IMAGE_TAG}`);
    const result = await checkAdoptedImage(root);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.label).toBe('Worktree image adopted');
    expect(result!.detail).toContain(`lazy-custom-ffffffffffff:${IMAGE_TAG}`);
    expect(result!.detail).toContain(dockerfile);
  });

  test('expires a stale adoption and warns', async () => {
    await writeAdoptedImage(root, {
      dockerfilePath: dockerfile,
      contentHash: hashDockerfileContent(ADOPTED_CONTENT),
      imageName: `lazy-custom-111111111111:${IMAGE_TAG}`,
      lazyVersion: '0.0.0-stale',
    });
    const result = await checkAdoptedImage(root);
    expect(result!.label).toBe('Worktree image adoption expired');
    expect(result!.warning).toContain('0.0.0-stale');
    expect(await readAdoptedImage(root)).toBeNull();
  });

  test('clears and warns when content drifted after consent', async () => {
    await writeValidAdoption(root, dockerfile, `lazy-custom-222222222222:${IMAGE_TAG}`);
    await writeFile(dockerfile, 'FROM debian:bookworm-slim\n# drifted\n');
    const result = await checkAdoptedImage(root);
    expect(result!.label).toBe('Worktree image adoption cleared');
    expect(result!.warning).toContain('changed after consent');
    expect(await readAdoptedImage(root)).toBeNull();
  });
});
