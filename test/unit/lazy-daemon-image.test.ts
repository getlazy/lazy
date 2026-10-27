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
import { mkdtemp, writeFile, rm, readFile, stat, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { SECOND_LOOPBACK_HOST, secondLoopbackSuiteSkipped } from '../helpers/second-loopback';
import { pickPortFreeEverywhere } from '../helpers/port-free-everywhere';
import { GUEST_INIT_SCRIPT, guestInitId, materializeGuestInit } from '../../src/guest/guest-init';

const IMAGE_DIR = join(import.meta.dir, '..', '..', 'lazy-teams', 'deploy', 'daemon-image');
// The script itself is lazy's own code, embedded in the binary; the image ships
// only SHIM, which runs the binary's copy (src/guest/guest-init.ts).
const INIT = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');
const SHIM = join(IMAGE_DIR, 'lazy-guest-init');
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
  test('puts the data-root on the machine disk, on the containerd image store with overlayfs', async () => {
    const p = await plan(WITH_STORAGE);
    expect(p.data_root).toBe('/storage/docker');
    expect(p.backing_fs).toBe('ext4');
    expect(p.image_store).toBe('containerd');
    expect(p.storage_driver).toBe('overlayfs');
  });

  test('never chooses a virtiofs mount — that is the host store, not a disk', async () => {
    const p = await plan(WITH_STORAGE);
    expect(p.data_root).not.toContain('/lazy/projects');
  });

  test('falls back to any other real disk when /storage is not mounted', async () => {
    const p = await plan(`${ROOTFS_ONLY}/dev/vdb /data xfs rw 0 0\n`);
    expect(p.data_root).toBe('/data/docker');
    expect(p.storage_driver).toBe('overlayfs');
  });

  // A machine created without --storage still has to be able to run a task;
  // vfs on the rootfs overlay is slow and RAM-backed but it works, and the
  // script says so on stderr rather than letting dockerd fail opaquely.
  test('degrades to the native snapshotter on the rootfs overlay when there is no disk at all', async () => {
    // native is the image store's vfs: overlay cannot stack on the rootfs overlay,
    // and dockerd refuses the graph-driver name vfs with the image store on.
    const p = await plan(ROOTFS_ONLY);
    expect(p.data_root).toBe('/var/lib/docker');
    expect(p.image_store).toBe('containerd');
    expect(p.storage_driver).toBe('native');
  });

  test('honours explicit data-root and driver overrides', async () => {
    const p = await plan(ROOTFS_ONLY, {
      LAZY_GUEST_DOCKER_DATA_ROOT: '/custom/docker',
      LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
    });
    expect(p.data_root).toBe('/custom/docker');
    expect(p.storage_driver).toBe('overlay2');
    // A legacy graph driver cannot run on the image store, so naming one turns it off.
    expect(p.image_store).toBe('graphdriver');
  });

  test('follows LAZY_GUEST_STORAGE_ROOT when the disk is mounted elsewhere', async () => {
    const p = await plan(`${ROOTFS_ONLY}/dev/vda /mnt/disk ext4 rw 0 0\n`, {
      LAZY_GUEST_STORAGE_ROOT: '/mnt/disk',
    });
    expect(p.data_root).toBe('/mnt/disk/docker');
    expect(p.storage_driver).toBe('overlayfs');
  });

  // INVARIANT: dockerd's settings come only from lazy's own --config-file, so a
  // hand-written /etc/docker/daemon.json is never read and can never collide
  // with a flag ("conflicting options") — the plan says it is ignored.
  test('reports a hand-written daemon.json as ignored, and lazy\'s own config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-daemon-json-'));
    try {
      const daemonJson = join(dir, 'daemon.json');
      const absent = await plan(WITH_STORAGE, { LAZY_GUEST_DOCKER_DAEMON_JSON: daemonJson, LAZY_GUEST_RUN_DIR: dir });
      expect(absent.docker_daemon_json).toBe('absent');
      expect(absent.dockerd_config).toBe(join(dir, 'lazy-dockerd.json'));
      await writeFile(daemonJson, '{ "features": { "containerd-snapshotter": true } }');
      const present = await plan(WITH_STORAGE, { LAZY_GUEST_DOCKER_DAEMON_JSON: daemonJson, LAZY_GUEST_RUN_DIR: dir });
      expect(present.docker_daemon_json).toBe('ignored');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  // INVARIANT: the guest runs lazy as the COMPILED release binary — no bun, no
  // source tree, no node_modules. The upgrade design delivers one versioned
  // binary and swaps it; a tree of 17k files cannot be swapped that way.
  test('carries a Docker engine, git and the compiled lazy binary — and no bun or sources', () => {
    expect(dockerfile).toContain('docker.io');
    expect(dockerfile).toMatch(/^\s+git\b/m);
    expect(dockerfile).toContain('RUN bun run scripts/build.ts');
    expect(dockerfile).toContain('COPY --from=lazy-checkout /opt/lazy/lazy /opt/lazy/bin/lazy');
    expect(dockerfile).toContain('.source-fingerprint');
    // Runtime stage must not copy bun or the whole checkout.
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).not.toContain('/usr/local/bin/bun');
    expect(runtime).not.toMatch(/COPY --from=lazy-checkout \/opt\/lazy /);
  });

  // INVARIANT: the guest ships gh and glab at exact versions, each tarball
  // checked against a pinned sha256 for BOTH architectures. Without them a
  // Teams project cannot open PRs/MRs or read reviews; an unpinned download
  // would make two builds of one release carry different forge CLIs.
  test('ships gh and glab, pinned and checksummed for amd64 and arm64', () => {
    const gh = /^ARG GH_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
    const glab = /^ARG GLAB_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
    expect(gh).toBeTruthy();
    expect(glab).toBeTruthy();
    for (const arch of ['amd64', 'arm64']) {
      expect(dockerfile).toMatch(new RegExp(`[0-9a-f]{64}  gh_${gh}_linux_${arch}\\.tar\\.gz`));
      expect(dockerfile).toMatch(new RegExp(`[0-9a-f]{64}  glab_${glab}_linux_${arch}\\.tar\\.gz`));
    }
    expect(dockerfile).toContain('sha256sum -c');
    expect(dockerfile).not.toMatch(/releases\/latest/);
  });

  // Dockerfile.lazy is part of the source fingerprint (FINGERPRINT_ROOTS), so the
  // build stage needs it to bake the same id a checkout computes. It is NOT
  // shipped: the daemon builds the runner image from the Dockerfile embedded in
  // the binary, or the project's own.
  test('has Dockerfile.lazy in the build stage so the fingerprint matches a checkout', () => {
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

  // INVARIANT: the wrapper execs the compiled binary, never `bun run` on a source
  // tree — the image no longer has either.
  test('execs the compiled binary, not bun', () => {
    expect(wrapper).toContain('exec "$LAZY_BINARY" "$@"');
    expect(wrapper).toContain('/opt/lazy/bin/lazy');
    expect(wrapper).not.toMatch(/exec bun/);
  });

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
// which scans this image's checkout stage (the only one: the self-host image copies it) against every
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
    expect(init).toContain('TCP4-LISTEN:${DAEMON_PORT},bind=${1},reuseaddr,fork');
    expect(init).toContain('forwarder_spec_for "$link"');
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

describe('lazy daemon image trusts the worktrees its task containers adopt', () => {
  // INVARIANT: the image installs the daemon-image gitconfig as the SYSTEM git
  // config. The daemon runs as root; task containers take ownership of their
  // worktree as uid 1000; without system-level safe.directory the daemon's own
  // git (lazy_commit, lazy_final) refuses every such worktree. Behaviour is
  // proven in guest-worktree-ownership.test.ts; this pins that it ships.
  test('the Dockerfile copies gitconfig to /etc/gitconfig', () => {
    expect(readFileSync(DOCKERFILE, 'utf-8')).toMatch(
      /^COPY lazy-teams\/deploy\/daemon-image\/gitconfig \/etc\/gitconfig$/m,
    );
    expect(readFileSync(join(IMAGE_DIR, 'gitconfig'), 'utf-8')).toMatch(/^\[safe\]\n\tdirectory = \*$/m);
  });
});

describe('the image tar carries the source id its daemon reports', () => {
  const script = readFileSync(resolve(import.meta.dir, '../../scripts/publish-lazy-daemon-image.sh'), 'utf-8');

  // INVARIANT: `<tar>.source-id` is COPIED OUT of the built image, never
  // recomputed from the git archive. The image's tree holds generated,
  // gitignored files (src/version.ts, src/build-info.ts) the archive lacks, so a
  // recomputed id never equals the `sourceId` the daemon reports — and Lazy
  // Teams would then judge every project stale and replace its machine on
  // every roll.
  test('the --save sidecar is read from /opt/lazy/.source-fingerprint in the image', () => {
    expect(script).toContain('docker cp "${SOURCE_ID_CID}:/opt/lazy/.source-fingerprint"');
    expect(script).toContain('${SAVE_PATH}.source-id');
    expect(script).not.toContain('computeSourceIdentityOf');
  });
});

describe('daemon image builds with BuildKit', () => {
  // INVARIANT: the guest's `docker build` must be BuildKit. Debian's docker.io (20.10) is the legacy builder and rejects `RUN --network`/`--mount`/heredocs in a project's Dockerfile.lazy; the image installs Docker 23+ with buildx, fails its own build without it, and lazy-guest-init refuses to report ready without it.
  test('Dockerfile installs docker-ce with buildx and not docker.io', () => {
    const df = readFileSync(DOCKERFILE, 'utf8');
    expect(df).toContain('docker-buildx-plugin=');
    expect(df).toContain('docker buildx version');
    expect(df).not.toMatch(/^\s+docker\.io\s*\\?$/m);
  });
  test('lazy-guest-init checks buildx', () => {
    expect(readFileSync(INIT, 'utf8')).toContain('docker buildx version');
  });
});

/**
 * INVARIANT: a change to what a machine's ROOT FILESYSTEM holds raises the
 * image's guest ABI (`org.getlazy.guest-abi`). A Teams upgrade swaps only the
 * lazy binary into a running machine and keeps everything else, so a machine
 * created under the same ABI never sees a change to the packages, Docker, the
 * lazy-guest-init shim, the wrapper or /etc/gitconfig — only a replacement,
 * which an ABI change forces, does. A forgotten bump would ship a change that
 * silently never reaches any existing machine.
 *
 * INVARIANT (engineer, 2026-10-13): lazy's OWN guest logic is NOT root
 * filesystem. lazy-guest-init is embedded in the binary (src/guest/) and
 * upgrades in place with it, so changing it must never require a bump — every
 * bump replaces every machine, losing its docker images, build cache and tools.
 * The digest therefore reads nothing under src/, and the runtime stage copies
 * nothing from it.
 *
 * The digest covers the runtime stage (comments, blank lines and the ABI label
 * itself left out), the version ARGs it uses, and the three guest files. When
 * this fails: raise the label in the Dockerfile by one, then set both numbers
 * below to what the failure prints.
 */
describe('the daemon image guest ABI', () => {
  const PINNED_ABI = 5;
  const PINNED_DIGEST = '9a57b4251f8bf9a5b150d042413048adc526257c03f4836d84e82057825c4d6a';

  function guestDigest(read: (path: string) => string | Buffer = (p) => readFileSync(p)): string {
    const dockerfile = read(DOCKERFILE).toString();
    const code = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('LABEL org.getlazy.guest-abi='));
    const runtime = dockerfile.slice(dockerfile.indexOf('\nFROM docker.io/library/debian:'));
    const versionArgs = code(dockerfile).filter((line) =>
      /^ARG (DEBIAN_TAG|GH_VERSION|GLAB_VERSION|DOCKER_VERSION|DOCKER_BUILDX_VERSION)=/.test(line),
    );
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(versionArgs.join('\n'));
    hash.update(code(runtime).join('\n'));
    for (const name of ['lazy-guest-init', 'lazy-wrapper', 'gitconfig']) {
      hash.update(`\0${name}\0`);
      hash.update(read(join(IMAGE_DIR, name)));
    }
    return hash.digest('hex');
  }

  test('the label is one whole number', () => {
    const labels = [...readFileSync(DOCKERFILE, 'utf8').matchAll(/^LABEL org\.getlazy\.guest-abi="(\d+)"$/gm)];
    expect(labels.length).toBe(1);
    expect(Number(labels[0][1])).toBe(PINNED_ABI);
  });

  test('the guest root filesystem has not changed without an ABI bump', () => {
    const digest = guestDigest();
    if (digest !== PINNED_DIGEST) {
      throw new Error(
        `the daemon image's guest root filesystem changed (digest ${digest}, pinned ${PINNED_DIGEST} for ABI ${PINNED_ABI}). ` +
          `Raise LABEL org.getlazy.guest-abi in lazy-teams/deploy/daemon-image/Dockerfile by one and pin ` +
          `PINNED_ABI and PINNED_DIGEST to the new values — existing machines are then REPLACED on the next upgrade.`,
      );
    }
  });

  test('changing lazy-guest-init itself needs no bump: the digest never reads the script', () => {
    const read: string[] = [];
    guestDigest((p) => {
      read.push(relative(join(import.meta.dir, '..', '..'), p));
      return readFileSync(p);
    });
    expect(read.some((p) => p.startsWith('src/'))).toBe(false);
    expect(read).toContain('lazy-teams/deploy/daemon-image/lazy-guest-init');
    // ...while a change to the SHIM, which is in the image, still moves it.
    const shimChanged = guestDigest((p) => (p === SHIM ? `${readFileSync(p, 'utf8')}\n:` : readFileSync(p)));
    expect(shimChanged).not.toBe(guestDigest());
  });

  // A compiled binary that silently lacked the script would fail every daemon
  // start on every ABI-5 machine, and only on hardware: the build refuses it.
  test('the build stage proves the compiled binary hands out the script byte for byte', () => {
    const df = readFileSync(DOCKERFILE, 'utf8');
    const build = df.slice(0, df.indexOf('\nFROM docker.io/library/debian:'));
    expect(build).toContain('gi="$(./lazy system guest-init-script --run-dir /tmp/guest-init-check)"');
    expect(build).toContain('cmp "$gi" src/guest/lazy-guest-init');
    expect(build).toContain('[ "$gi" = "/tmp/guest-init-check/lazy-guest-init.$(./lazy system guest-init-script --id)" ]');
  });

  test('the image bakes in the shim, never the script', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('\nFROM docker.io/library/debian:'));
    const code = runtime.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(code).not.toContain('src/guest');
    expect(runtime).toMatch(/^COPY lazy-teams\/deploy\/daemon-image\/lazy-guest-init \/usr\/local\/bin\/lazy-guest-init$/m);
  });
});

/**
 * The shim is the whole of lazy-guest-init that the image holds, so it must stay
 * a pass-through: ask the CURRENT binary for its script, run it with the same
 * arguments. Anything more would be logic that only a machine replacement can
 * change, which is what moving the script into the binary was for.
 */
describe('the lazy-guest-init shim runs the binary\'s own script', () => {
  const ROOT = join(import.meta.dir, '..', '..');

  // A stand-in for /opt/lazy/bin/lazy: this checkout, run from source.
  async function fakeBinary(dir: string): Promise<string> {
    const bin = join(dir, 'lazy');
    await writeFile(bin, `#!/bin/sh\nexec bun run ${JSON.stringify(join(ROOT, 'src', 'index.ts'))} "$@"\n`, { mode: 0o755 });
    return bin;
  }

  test('runs the script the binary carries, from the run dir, with the caller\'s arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-guest-shim-'));
    try {
      const mountsFile = join(dir, 'mounts');
      await writeFile(mountsFile, WITH_STORAGE);
      const result = spawnSyncUnsupervised(['sh', SHIM, '--print-plan'], {
        env: { ...process.env, LAZY_BIN: await fakeBinary(dir), LAZY_GUEST_RUN_DIR: dir, LAZY_GUEST_MOUNTS_FILE: mountsFile },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString();
      expect(out).toContain(`guest_init_id=${guestInitId()}`);
      expect(out).toContain('data_root=/storage/docker');
      expect(readdirSync(dir)).toContain(`lazy-guest-init.${guestInitId()}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('says which piece failed when the binary cannot hand the script over', () => {
    const result = spawnSyncUnsupervised(['sh', SHIM, '--ensure'], {
      env: { ...process.env, LAZY_BIN: '/nonexistent/lazy' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('reason=guest-init-unavailable');
    expect(result.stderr.toString()).toContain('system guest-init-script');
  });

  test('stays a thin pass-through', () => {
    const shim = readFileSync(SHIM, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n');
    expect(shim).toContain('system guest-init-script');
    expect(shim).toContain('exec sh "$script" "$@"');
    expect(shim).not.toContain('dockerd');
    expect(shim).not.toContain('socat');
  });
});

describe('the binary hands the script over', () => {
  test('the id is the script\'s own sha256 prefix — what the script reports for itself', async () => {
    const script = readFileSync(INIT, 'utf8');
    expect(GUEST_INIT_SCRIPT).toBe(script);
    const out = await plan(WITH_STORAGE);
    expect(out.guest_init_id).toBe(guestInitId());
  });

  test('writes it 0755 under its id, reuses an intact copy and rewrites a damaged one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-guest-materialize-'));
    try {
      const path = await materializeGuestInit(dir);
      expect(path).toBe(join(dir, `lazy-guest-init.${guestInitId()}`));
      expect((await stat(path)).mode & 0o777).toBe(0o755);
      expect(await readFile(path, 'utf8')).toBe(GUEST_INIT_SCRIPT);
      await writeFile(path, 'damaged');
      expect(await materializeGuestInit(dir)).toBe(path);
      expect(await readFile(path, 'utf8')).toBe(GUEST_INIT_SCRIPT);
      expect(readdirSync(dir)).toEqual([`lazy-guest-init.${guestInitId()}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A setting that changed with an in-place swap. The forwarder is restarted by
 * --ensure when the one running was started with other options; dockerd's
 * config is only REPORTED as pending — a roll never kills dockerd, which may be
 * mid-build.
 */
describe('settings that change with an in-place swap', () => {
  async function withRunDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-guest-settings-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('a live forwarder started with other options is reported stale; with these, current', async () => {
    await withRunDir(async (dir) => {
      const env = { LAZY_GUEST_RUN_DIR: dir, LAZY_GUEST_LINK_ADDRESS: '127.0.0.1' };
      expect((await plan(WITH_STORAGE, env)).forwarder_spec).toBe('none');
      const live = Bun.spawn(['sleep', '30']);
      try {
        await writeFile(join(dir, 'lazy-guest-forwarder.pid'), `${live.pid}\n`);
        // No spec at all: a forwarder an older lazy-guest-init started.
        expect((await plan(WITH_STORAGE, env)).forwarder_spec).toBe('stale');
        await writeFile(join(dir, 'lazy-guest-forwarder.spec'),
          'socat -d TCP4-LISTEN:26024,bind=127.0.0.1,reuseaddr,fork,backlog=1024 TCP4:127.0.0.1:26024\n');
        expect((await plan(WITH_STORAGE, env)).forwarder_spec).toBe('current');
      } finally {
        live.kill();
      }
    });
  });

  test('a running dockerd with another config is pending-restart, never restarted by the plan', async () => {
    await withRunDir(async (dir) => {
      const dataRoot = join(dir, 'docker');
      const env = { LAZY_GUEST_RUN_DIR: dir, LAZY_GUEST_DOCKER_DATA_ROOT: dataRoot, LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlayfs' };
      const first = await plan(WITH_STORAGE, env);
      expect(first.dockerd_config_state).toBe('none');
      const config = join(dir, 'lazy-dockerd.json');
      await writeFile(config, '{ "storage-driver": "overlay2" }\n');
      expect((await plan(WITH_STORAGE, env)).dockerd_config_state).toBe('pending-restart');
      // Exactly what write_dockerd_config renders for this plan.
      await writeFile(config,
        `{\n  "storage-driver": "overlayfs",\n  "features": {\n    "containerd-snapshotter": true\n  },\n  "builder": {\n    "gc": {\n` +
        `      "enabled": true,\n      "defaultReservedSpace": "1GB",\n      "defaultMaxUsedSpace": "${first.build_cache_max}",\n` +
        `      "defaultMinFreeSpace": "${first.build_cache_min_free}"\n    }\n  }\n}\n`);
      expect((await plan(WITH_STORAGE, env)).dockerd_config_state).toBe('current');
    });
  });

  // The behaviour itself, end to end, with a REAL socat and the real script,
  // hermetic like guest-init-forwarder-burst.test.ts: every dockerd-side command
  // is a fake on PATH (id answers 0, so no root is needed), the cgroup, overlay
  // and mount seams point into a temp dir, and the "daemon" is a Bun server on
  // 127.0.0.1 behind a forwarder on the second loopback address.
  const forwarderSkip = secondLoopbackSuiteSkipped('guest-init forwarder restart')
    ? 'no second loopback address'
    : !Bun.which('socat') || !Bun.which('setsid') ? 'needs setsid and socat on PATH' : null;
  if (forwarderSkip === 'needs setsid and socat on PATH') console.log(`SKIP guest-init forwarder restart: ${forwarderSkip}`);

  test.skipIf(forwarderSkip !== null)('--ensure restarts a forwarder whose options changed, keeping open connections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-guest-fwd-'));
    const bin = join(dir, 'bin');
    const runDir = join(dir, 'run');
    for (const d of [bin, runDir, join(dir, 'log')]) await mkdir(d, { recursive: true });
    const fake = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await fake('docker', 'case "$1" in info) [ "$2" = "--format" ] && echo overlay2; exit 0 ;; esac\nexit 0');
    await fake('dockerd', 'exit 0');
    await fake('id', 'echo 0');
    await fake('dmesg', 'exit 0');
    // Free on 0.0.0.0 and the second loopback too: socat binds the same port there.
    const daemon = Bun.serve({ hostname: '127.0.0.1', port: pickPortFreeEverywhere(), fetch: () => new Response('daemon-ok') });
    const mountsFile = join(dir, 'mounts');
    await writeFile(mountsFile, WITH_STORAGE);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAZY_GUEST_RUN_DIR: runDir,
      LAZY_GUEST_LOG_DIR: join(dir, 'log'),
      LAZY_GUEST_CGROUP_ROOT: join(dir, 'no-cgroup'),
      LAZY_GUEST_OVERLAY_PARAMS_DIR: join(dir, 'overlay-params'),
      LAZY_GUEST_MOUNTS_FILE: mountsFile,
      LAZY_GUEST_DOCKER_DATA_ROOT: join(dir, 'docker'),
      LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
      LAZY_GUEST_LINK_ADDRESS: SECOND_LOOPBACK_HOST,
      LAZY_GUEST_DAEMON_PORT: String(daemon.port),
    };
    const run = (...a: string[]) =>
      spawnSyncUnsupervised(['sh', INIT, ...a], { env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 }).stdout.toString();
    const pidFile = join(runDir, 'lazy-guest-forwarder.pid');
    let held: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    try {
      expect(run('--ensure', '--timeout', '5')).toMatch(/^forwarder=started$/m);
      const oldPid = (await readFile(pidFile, 'utf8')).trim();
      // A connection through the OLD forwarder, held open across the restart.
      let reply = '';
      held = await Bun.connect({
        hostname: SECOND_LOOPBACK_HOST,
        port: daemon.port!,
        socket: { data(_s, chunk) { reply += chunk.toString(); } },
      });
      // What an older lazy-guest-init leaves: a live forwarder with another spec.
      await writeFile(join(runDir, 'lazy-guest-forwarder.spec'), 'socat -d TCP4-LISTEN:1,an-older-lazy TCP4:127.0.0.1:1\n');
      expect(run('--print-plan')).toContain('forwarder_spec=stale');

      const out = run('--ensure', '--timeout', '5');
      expect(out).toContain('forwarder_restarted=options-changed');
      expect(out).toMatch(/^forwarder=started$/m);
      const newPid = (await readFile(pidFile, 'utf8')).trim();
      expect(newPid).not.toBe(oldPid);
      expect(run('--print-plan')).toContain('forwarder_spec=current');
      expect(await readFile(join(dir, 'log', 'lazy-forwarder.log'), 'utf8')).toContain('its options changed');
      // New connections go through the new forwarder...
      expect(await (await fetch(`http://${SECOND_LOOPBACK_HOST}:${daemon.port}/`, { headers: { connection: 'close' } })).text()).toBe('daemon-ok');
      // ...and the one opened before the restart still works.
      held.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      for (let i = 0; i < 50 && !reply.includes('daemon-ok'); i++) await Bun.sleep(50);
      expect(reply).toContain('daemon-ok');
    } finally {
      held?.end();
      const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
      try {
        if (pid > 0) process.kill(pid);
      } catch {
        // Already gone: this cleanup only exists for a forwarder still running.
      }
      daemon.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('daemon image bun version', () => {
  // INVARIANT: the daemon image compiles lazy with the SAME bun the repo pins
  // (.bun-version), which is the bun every test runs on. The image pinned
  // 1.2.21 while tests ran 1.3.x; that bun's WebSocket client appended the
  // caller's handshake headers after its own, so every Teams daemon sent the
  // app `Host` and `Sec-WebSocket-Version` twice and ActionCable refused the
  // socket — a bug no test could see, because no test ran that bun.
  test('BUN_VERSION matches .bun-version', async () => {
    const root = resolve(import.meta.dir, '../..');
    const pinned = (await readFile(join(root, '.bun-version'), 'utf-8')).trim();
    const dockerfile = await readFile(join(root, 'lazy-teams/deploy/daemon-image/Dockerfile'), 'utf-8');
    const arg = dockerfile.match(/^ARG BUN_VERSION=(\S+)$/m);
    expect(arg?.[1]).toBe(pinned);
  });
});
