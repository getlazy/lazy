/**
 * What `ensureImage` tells whoever is watching a launch while the image is
 * resolved. A member's Teams terminal is bounded by SILENCE while it waits
 * (src/server/session-attach-ws.ts), so a phase that takes minutes and says
 * nothing ends a healthy terminal as "stopped making progress".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker } from '../helpers/fake-docker';
import { ensureImage, resetUpgradeImageBuild, IMAGE_TAG } from '../../src/capture/claude';

describe('image resolution narrates every long phase', () => {
  let root: string;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    undoDaemonBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-narrate-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-narrate-root-')));
  });

  afterEach(async () => {
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: waiting behind another caller's build of the same image is
  // announced — after an upgrade the resumed turns start the build and a
  // member's terminal waits behind it for as long as it takes.
  test('a caller waiting on another build of the same image is told so', async () => {
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    undoConfig = pinConfig(root);
    const docker = await installFakeDocker(root);
    await docker.slowBuilds(1);
    const first = ensureImage(docker.binPath);
    // Let the first caller take the image lock and start its build.
    await new Promise((r) => setTimeout(r, 400));
    const notes: string[] = [];
    const second = ensureImage(docker.binPath, { notify: (n) => notes.push(n) });
    await Promise.all([first, second]);
    expect(notes.some((n) => /^waiting for .* to finish building$/.test(n))).toBe(true);
  }, 30_000);

  // INVARIANT: a base image built first for a Dockerfile FROM it is narrated.
  test('building the base image first is narrated', async () => {
    // The image is resolved against the project the PROCESS is in (git root).
    Bun.spawnSync(['git', 'init', '-q', root]);
    const cwd = process.cwd();
    process.chdir(root);
    try {
    await writeFile(join(root, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN true\n`);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\n');
    undoConfig = pinConfig(root);
    const docker = await installFakeDocker(root);
    const notes: string[] = [];
    await ensureImage(docker.binPath, { notify: (n) => notes.push(n) });
    expect(notes).toContain('building the base image lazy-runner first');
    } finally {
      process.chdir(cwd);
    }
  }, 60_000);
});
