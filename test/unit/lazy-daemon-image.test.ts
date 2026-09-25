/**
 * The lazy daemon image's boot-time preparation — the image a project daemon
 * runs in inside its VM (smolvm being the vehicle today).
 *
 * INVARIANT: Docker's data-root must land on a real block filesystem whenever
 * the machine has one. smolvm's guest rootfs is an overlay whose lower layer is
 * ramfs, which has no file-handle support, so dockerd cannot stack overlay2 on
 * it (docs/spikes/smolvm.md §4, gotcha 1) — a data-root there means every image
 * layer and container lives in RAM and dies with the machine. The `--storage`
 * volume smolvm mounts at /storage is ext4 on /dev/vda and is the answer.
 *
 * These tests drive the real lazy-guest-init through its `--print-plan` mode
 * against synthetic mount tables, because the decision cannot be observed any
 * other way from a container with no KVM: the script itself is only ever
 * executed inside a microVM.
 *
 * The second block asserts what the image must contain. The fleet supervisor
 * gets exactly one hook — a `lazy` on the guest's PATH, invoked as
 * `sh -c '. env.sh; exec lazy …'` — so an image that ships lazy without the
 * wrapper, or without a Docker engine, fails only on real hardware, hours later,
 * as a task that will not start.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const IMAGE_DIR = join(import.meta.dir, '..', '..', 'lazy-teams', 'deploy', 'daemon-image');
const INIT = join(IMAGE_DIR, 'lazy-guest-init');
// `lazy-wrapper` here, installed as `lazy` in the guest — the repo's .gitignore
// ignores any path component named `lazy`, and the image's build context is a
// `git archive`, so a file with that name would not reach the build at all.
const WRAPPER = join(IMAGE_DIR, 'lazy-wrapper');
const DOCKERFILE = join(IMAGE_DIR, 'Dockerfile');

/** Run `lazy-guest-init --print-plan` against a synthetic /proc/mounts. */
async function plan(
  mounts: string,
  env: Record<string, string> = {}
): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-daemon-image-'));
  try {
    const mountsFile = join(dir, 'mounts');
    await writeFile(mountsFile, mounts);
    const result = spawnSyncUnsupervised(['sh', INIT, '--print-plan'], {
      env: { ...process.env, LAZY_GUEST_MOUNTS_FILE: mountsFile, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    const out: Record<string, string> = {};
    for (const line of result.stdout.toString().split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ROOTFS_ONLY = 'overlay / overlay rw 0 0\n';
const WITH_STORAGE = `${ROOTFS_ONLY}/dev/vda /storage ext4 rw 0 0\nhostshare /lazy/projects/7/store virtiofs rw 0 0\n`;

describe('lazy-guest-init data-root selection', () => {
  test('puts the data-root on the machine disk and uses overlay2', async () => {
    const p = await plan(WITH_STORAGE);
    expect(p.data_root).toBe('/storage/docker');
    expect(p.backing_fs).toBe('ext4');
    expect(p.storage_driver).toBe('overlay2');
  });

  test('never chooses a virtiofs mount — that is the host store, not a disk', async () => {
    const p = await plan(WITH_STORAGE);
    expect(p.data_root).not.toContain('/lazy/projects');
  });

  test('falls back to any other real disk when /storage is not mounted', async () => {
    const p = await plan(`${ROOTFS_ONLY}/dev/vdb /data xfs rw 0 0\n`);
    expect(p.data_root).toBe('/data/docker');
    expect(p.storage_driver).toBe('overlay2');
  });

  // A machine created without --storage still has to be able to run a task;
  // vfs on the rootfs overlay is slow and RAM-backed but it works, and the
  // script says so on stderr rather than letting dockerd fail opaquely.
  test('degrades to vfs on the rootfs overlay when there is no disk at all', async () => {
    const p = await plan(ROOTFS_ONLY);
    expect(p.data_root).toBe('/var/lib/docker');
    expect(p.storage_driver).toBe('vfs');
  });

  test('honours explicit data-root and driver overrides', async () => {
    const p = await plan(ROOTFS_ONLY, {
      LAZY_GUEST_DOCKER_DATA_ROOT: '/custom/docker',
      LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
    });
    expect(p.data_root).toBe('/custom/docker');
    expect(p.storage_driver).toBe('overlay2');
  });

  test('follows LAZY_GUEST_STORAGE_ROOT when the disk is mounted elsewhere', async () => {
    const p = await plan(`${ROOTFS_ONLY}/dev/vda /mnt/disk ext4 rw 0 0\n`, {
      LAZY_GUEST_STORAGE_ROOT: '/mnt/disk',
    });
    expect(p.data_root).toBe('/mnt/disk/docker');
    expect(p.storage_driver).toBe('overlay2');
  });
});

describe('the lazy daemon image contract', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf-8');

  // The supervisor's only entry point is `lazy` on PATH; it never runs
  // lazy-guest-init itself, and it cannot — it has no such command in its argv
  // vocabulary. The wrapper is what makes the preparation happen.
  test('installs the wrapper as the guest lazy command', () => {
    expect(dockerfile).toContain('/usr/local/bin/lazy-guest-init');
    expect(dockerfile).toContain('/usr/local/bin/lazy');
    expect(readFileSync(WRAPPER, 'utf-8')).toContain('lazy-guest-init --ensure');
  });

  // The image's build context is `git archive <ref>` — tracked files only. The
  // repo's .gitignore ignores any path component named `lazy` (the compiled
  // binary), so a wrapper called `lazy` is untracked, missing from the context,
  // and the build fails at COPY. That is why the file is `lazy-wrapper`.
  test('the wrapper source is a file git actually tracks', () => {
    const result = spawnSyncUnsupervised(['git', 'check-ignore', '-q', WRAPPER], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    // git check-ignore exits 0 when the path IS ignored.
    expect(result.exitCode).not.toBe(0);
  });

  test('carries a Docker engine, git, bun and the lazy checkout at /opt/lazy', () => {
    expect(dockerfile).toContain('docker.io');
    expect(dockerfile).toMatch(/^\s+git\b/m);
    expect(dockerfile).toContain('/usr/local/bin/bun');
    expect(dockerfile).toContain('WORKDIR /opt/lazy');
  });

  // The daemon builds the lazy-runner agent image from Dockerfile.lazy on the
  // guest's own dockerd. Without it in the checkout the build fails inside a VM
  // whose only diagnostic channel is `machine exec`.
  test('ships Dockerfile.lazy so the runner image can be built in the guest', () => {
    expect(dockerfile).toContain('COPY Dockerfile.lazy ./');
  });

  // A guest running a stale image is otherwise invisible from the host.
  test('labels the build with a version and a content fingerprint', () => {
    expect(dockerfile).toContain('LABEL lazyVersion=');
    expect(dockerfile).toContain('lazySourceFingerprint=');
  });

  test('is architecture-neutral — one Dockerfile for arm64 and x86_64', () => {
    expect(dockerfile).not.toContain('uname -m');
    expect(dockerfile).not.toContain('aarch64');
    expect(dockerfile).not.toContain('x86_64');
  });
});

describe('the guest lazy wrapper', () => {
  const wrapper = readFileSync(WRAPPER, 'utf-8');

  // `lazy --version` is the supervisor's readiness check AND the first line of
  // the real-hardware checklist. If it needed dockerd, a guest with a broken
  // Docker engine would be indistinguishable from a guest with no lazy in it.
  test('answers --version without preparing Docker', () => {
    expect(wrapper).toContain('--version|-v|--help|-h');
  });

  // The opposite failure: a daemon that starts happily and then fails every
  // task, with nothing pointing back at the guest's Docker engine.
  test('refuses to start the daemon when preparation failed', () => {
    expect(wrapper).toContain('"daemon start") needs_docker=1');
  });
});

// The COPY list itself is guarded by test/unit/deploy-image-copy-graph.test.ts,
// which scans BOTH checkout stages (self-host image and this one) against every
// import that leaves src/. What that scan does not cover is the publish script's
// content fingerprint: an input the image carries but the fingerprint ignores
// is an image that does not re-tag when that input changes.
describe('lazy daemon image fingerprints every out-of-src import', () => {
  const ROOT = join(import.meta.dir, '..', '..');
  const SRC = join(ROOT, 'src');

  function outOfSrcImports(): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          for (const m of text.matchAll(/from\s+['"]((?:\.\.\/)+[^'"]+)['"]/g)) {
            const target = relative(ROOT, resolve(dirname(full), m[1]));
            if (!target.startsWith('src/') && !target.startsWith('..')) found.add(target);
          }
        }
      }
    };
    walk(SRC);
    // lazy-agent is the compiled agent binary's placeholder: gitignored, absent
    // from the build context, and CREATED inside the image by the Dockerfile's
    // `bun run ensure:agent-placeholder` step — the one out-of-src import that is
    // made rather than copied. Asserted separately below.
    found.delete('lazy-agent');
    return [...found].sort();
  }

  test('derives at least the known imports, so the scan itself is not silently empty', () => {
    const imports = outOfSrcImports();
    expect(imports).toContain('design/industry/styles.css');
    expect(imports.some((p) => p.startsWith('scripts/'))).toBe(true);
  });

  test('the agent placeholder is created in the image rather than copied', () => {
    expect(readFileSync(DOCKERFILE, 'utf8')).toContain('ensure:agent-placeholder');
  });

  test('the publish script fingerprints those same inputs, so a change to one re-tags the image', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'publish-lazy-daemon-image.sh'), 'utf8');
    const paths = script.match(/FINGERPRINT_PATHS=\(([^)]*)\)/)?.[1].split(/\s+/).filter(Boolean) ?? [];
    for (const target of outOfSrcImports()) {
      const covered = paths.some((c) => target === c || target.startsWith(`${c}/`));
      expect(covered, `${target} is in the image but not in FINGERPRINT_PATHS`).toBe(true);
    }
  });
});

// MEASURED (hardware run 20260920-081830): smolvm's `-p` relay dials the
// guest's link address, not its loopback, while managed mode pins the daemon to
// 127.0.0.1. The init script's forwarder is the piece between them, and these
// pin down the two properties that make it safe and diagnosable rather than a
// second exposure: it binds the LINK address only, and its liveness is readable
// from outside through `--print-plan`.
describe('lazy daemon image forwards the relay to the daemon loopback', () => {
  const init = readFileSync(INIT, 'utf-8');
  const dockerfile = readFileSync(DOCKERFILE, 'utf-8');

  test('the image installs socat, the forwarder', () => {
    expect(dockerfile).toMatch(/^\s+socat \\$/m);
  });

  test('the forwarder binds the discovered link address and never 0.0.0.0', () => {
    expect(init).toContain('TCP4-LISTEN:${DAEMON_PORT},bind=${link},reuseaddr,fork');
    expect(init).toContain('TCP4:127.0.0.1:${DAEMON_PORT}');
    expect(init).not.toMatch(/bind=0\.0\.0\.0/);
    // Discovered from the interface table, or an explicit override — no literal
    // 100.96.0.2 anywhere: the vehicle owns that number.
    expect(init).not.toContain('100.96.0.2"');
    expect(init).toContain('LAZY_GUEST_LINK_ADDRESS');
  });

  test('--print-plan reports the forwarder bind and liveness without starting anything', async () => {
    const out = await plan('/dev/vda /storage ext4 rw 0 0\n');
    expect(out.forwarder_state).toMatch(/^(alive|dead|not-started)$/);
    expect(out.forwarder_bind).toMatch(/:26024$/);
    expect(out.docker_ready).toMatch(/^(yes|no)$/);
  });

  test('the daemon port the forwarder carries is managed mode\'s pin, overridable', () => {
    expect(init).toContain('DAEMON_PORT="${LAZY_GUEST_DAEMON_PORT:-26024}"');
  });

  test('a dead forwarder makes --ensure prepare again instead of trusting the marker', () => {
    expect(init).toContain('[ "$(forwarder_state)" != dead ]');
  });

  test('the wrapper surfaces the init report so a failed forwarder is named in the daemon log', () => {
    const wrapper = readFileSync(WRAPPER, 'utf-8');
    expect(wrapper).toContain('init_report="$(lazy-guest-init --ensure 2>&1)"');
    expect(wrapper).toContain('lazy-forwarder.log');
  });
});
