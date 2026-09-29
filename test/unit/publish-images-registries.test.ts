/**
 * Both container images publish to both registries, symmetrically.
 *
 * lazy-daemon and lazy-teams each go to ghcr.io/getlazy AND docker.io/getlazy
 * from ONE buildx pass carrying the identical tag set, so either registry is a
 * complete source of either image. The Teams image once went to GHCR only; this
 * keeps that asymmetry from coming back silently — in the scripts (which decide
 * the -t list) and in the workflow (which must log in to both registries in
 * both jobs, or the push fails).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const REPO = join(import.meta.dir, '..', '..');
const REGISTRIES = ['docker.io/getlazy', 'ghcr.io/getlazy'];
const IMAGES = ['lazy-daemon', 'lazy-teams'];

type Step = { name?: string; uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

/** registry → sorted tag list, read off the dry-run buildx command. */
function publishedTags(image: string): Map<string, string[]> {
  const result = spawnSyncUnsupervised(
    ['bash', join(REPO, 'scripts', `publish-${image}-image.sh`), '--dry-run', '--platform', 'linux/arm64,linux/amd64', '--push'],
    { cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
  );
  expect(result.exitCode).toBe(0);
  const build = result.stdout.toString().split('\n').find((l) => l.includes('buildx build'));
  expect(build).toBeDefined();
  const byRegistry = new Map<string, string[]>();
  for (const [, ref] of build!.matchAll(/ -t (\S+)/g)) {
    const at = ref.lastIndexOf(':');
    const repo = ref.slice(0, at);
    expect(repo.endsWith(`/${image}`)).toBe(true);
    const registry = repo.slice(0, -(image.length + 1));
    byRegistry.set(registry, [...(byRegistry.get(registry) ?? []), ref.slice(at + 1)].sort());
  }
  return byRegistry;
}

describe('container images publish to both registries', () => {
  // INVARIANT: every image is pushed to GHCR AND Docker Hub with the identical
  // tag set from one build. Either registry must be a complete source of either
  // image; a registry missing an image or a tag breaks whoever pulls from it.
  for (const image of IMAGES) {
    test(`${image}: one buildx pass, both registries, same tags`, () => {
      const tags = publishedTags(image);
      expect([...tags.keys()].sort()).toEqual(REGISTRIES);
      const [a, b] = REGISTRIES.map((r) => tags.get(r)!);
      expect(a.length).toBeGreaterThanOrEqual(3);
      expect(a).toContain('latest');
      expect(b).toEqual(a);
    }, 60_000);
  }

  // INVARIANT: the workflow runs each publish script with its default
  // registries — no --registry flag and no *_REGISTRY env — so CI cannot
  // quietly narrow an image back to one registry while the script stays symmetric.
  test('the workflow never narrows a publish script to one registry', () => {
    const wf = Bun.YAML.parse(readFileSync(join(REPO, '.github', 'workflows', 'publish-images.yml'), 'utf-8')) as {
      jobs: Record<string, { env?: Record<string, unknown>; steps?: (Step & { run?: string; env?: Record<string, unknown> })[] }>;
    };
    for (const image of IMAGES) for (const jobName of [`${image}-build`, image]) {
      const job = wf.jobs[jobName];
      const step = (job.steps ?? []).find((s) => s.run?.includes(`scripts/publish-${image}-image.sh`));
      expect(step).toBeDefined();
      expect(step!.run).not.toContain('--registry');
      for (const env of [job.env, step!.env]) {
        expect(Object.keys(env ?? {}).filter((k) => k.endsWith('_REGISTRY'))).toEqual([]);
      }
    }
  });

  // INVARIANT: each publish job logs in to both registries before it pushes,
  // with the existing secrets — a missing Docker Hub login fails the push.
  test('each publish job logs in to GHCR and Docker Hub', () => {
    const wf = Bun.YAML.parse(readFileSync(join(REPO, '.github', 'workflows', 'publish-images.yml'), 'utf-8')) as Workflow;
    for (const image of IMAGES) for (const jobName of [`${image}-build`, image]) {
      const logins = (wf.jobs[jobName].steps ?? []).filter((s) => s.uses?.startsWith('docker/login-action'));
      const ghcr = logins.find((s) => s.with?.registry === 'ghcr.io');
      const hub = logins.find((s) => s.with?.registry === undefined);
      expect(ghcr?.with?.password).toBe('${{ secrets.GHCR_TOKEN }}');
      expect(hub?.with?.username).toBe('${{ secrets.DOCKERHUB_USERNAME }}');
      expect(hub?.with?.password).toBe('${{ secrets.DOCKERHUB_TOKEN }}');
    }
  });
});

type FullWorkflow = {
  on: Record<string, { inputs?: Record<string, { default?: unknown; options?: string[] }> }>;
  jobs: Record<string, {
    'runs-on'?: string; needs?: string | string[]; if?: string;
    strategy?: { matrix?: { include?: unknown } };
    steps?: (Step & { run?: string; if?: string })[];
  }>;
};
const loadWorkflow = () =>
  Bun.YAML.parse(readFileSync(join(REPO, '.github', 'workflows', 'publish-images.yml'), 'utf-8')) as FullWorkflow;

/** Run the plan job's script for these inputs; returns its outputs. */
function plan(platforms: string, armRunner: string): { matrix: Record<string, unknown>[]; merge: string } {
  const dir = mkdtempSync(join(tmpdir(), 'publish-plan-'));
  try {
    const out = join(dir, 'out');
    const result = spawnSyncUnsupervised(['bash', '-e', '-c', loadWorkflow().jobs.plan.steps![0].run!], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      env: { ...process.env, PLATFORMS: platforms, ARM_RUNNER: armRunner, GITHUB_OUTPUT: out },
    });
    expect(result.exitCode).toBe(0);
    const kv = Object.fromEntries(readFileSync(out, 'utf-8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { matrix: JSON.parse(kv.matrix), merge: kv.merge };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dryRun(image: string, args: string[]): string[] {
  const result = spawnSyncUnsupervised(['bash', join(REPO, 'scripts', `publish-${image}-image.sh`), '--dry-run', ...args], {
    cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split('\n').filter((l) => l.startsWith('[dry-run] docker'));
}

describe('image publish: layer cache and native per-platform builds', () => {
  // INVARIANT: both images build through the same job shape — a per-platform
  // matrix from the plan job, a per-arch registry layer cache, and a merge job
  // that tags one manifest list. The images are published symmetrically; a
  // speed-up applied to one of them only is the asymmetry this guards against.
  test('both images use the same cache and matrix shape', () => {
    const wf = loadWorkflow();
    for (const image of IMAGES) {
      const build = wf.jobs[`${image}-build`];
      expect(build['runs-on']).toBe('${{ matrix.runner }}');
      expect(build.strategy?.matrix?.include).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
      const run = build.steps!.find((s) => s.name === 'Build and push')!.run!;
      expect(run).toContain(`--cache-ref "ghcr.io/getlazy/${image}:buildcache-$ARCH"`);
      expect(run).toContain('--push-by-digest');
      expect(build.steps!.find((s) => s.uses?.startsWith('docker/setup-qemu-action'))?.if).toBe('matrix.qemu');
      const merge = wf.jobs[image];
      expect(merge.if).toContain("needs.plan.outputs.merge == 'true'");
      expect(merge.steps!.find((s) => s.name === 'Merge and tag')!.run).toContain(`scripts/publish-${image}-image.sh --merge-digests`);
    }
  });

  // INVARIANT: a Teams image can never be published ahead of the daemon image
  // of its own commit. The daemon image is a BUILD INPUT of the Teams image
  // (its lazy checkout), so the Teams jobs wait on the daemon jobs, and a
  // Teams-only run is refused by the publish script itself when that tag is
  // not on a registry. This replaced a workflow-only guard step, which covered
  // CI and nothing else.
  test('the Teams build runs after the daemon build it takes lazy from', () => {
    const needs = loadWorkflow().jobs['lazy-teams-build'].needs;
    expect(needs).toContain('lazy-daemon-build');
    expect(needs).toContain('lazy-daemon');
  });

  // INVARIANT: the Teams image takes lazy from the daemon image published from
  // the SAME commit — its exact version tag, never `latest` or the minor line —
  // on every build path. Two images of one release must not disagree on lazy.
  test('every Teams build pins the daemon image of its own version tag', () => {
    for (const args of [[], ['--platform', 'linux/arm64,linux/amd64', '--push'], ['--platform', 'linux/arm64', '--push-by-digest', '/tmp/d']]) {
      const [build] = dryRun('lazy-teams', args).filter((l) => / build /.test(l));
      const version = build!.match(/LAZY_TEAMS_VERSION=(v\d+\.\d+\.\d+)/)![1];
      expect(build).toContain(`--build-arg LAZY_DAEMON_IMAGE=ghcr.io/getlazy/lazy-daemon:${version}`);
    }
  });

  test('--daemon-image points a local build at a locally built daemon image', () => {
    const [build] = dryRun('lazy-teams', ['--daemon-image', 'lazy-daemon:local']).filter((l) => / build /.test(l));
    expect(build).toContain('--build-arg LAZY_DAEMON_IMAGE=lazy-daemon:local');
  });

  // INVARIANT: a Teams build whose daemon image exists nowhere fails loudly
  // BEFORE building, naming the image and the fix — never a bare pull error.
  test('a missing daemon image refuses the Teams build before docker build runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-no-daemon-'));
    try {
      const log = join(dir, 'docker.log');
      // A docker that knows no image locally or on any registry, and logs every call.
      const fake = join(dir, 'docker');
      writeFileSync(fake, `#!/usr/bin/env bash\necho "$*" >> "${log}"\ncase "$1 $2" in "image inspect"|"buildx imagetools") exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
      const result = spawnSyncUnsupervised(['bash', join(REPO, 'scripts', 'publish-lazy-teams-image.sh')], {
        cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(result.exitCode).toBe(1);
      const stderr = result.stderr.toString();
      expect(stderr).toMatch(/ERROR: ghcr\.io\/getlazy\/lazy-daemon:v\d+\.\d+\.\d+ does not exist/);
      expect(stderr).toContain('images=both');
      expect(stderr).toContain('--daemon-image');
      expect(readFileSync(log, 'utf-8')).not.toMatch(/^build /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  // INVARIANT: arm_runner exists on both triggers, defaults to native, and
  // emulated is the documented cost fallback.
  test('arm_runner input exists with default native', () => {
    const on = loadWorkflow().on;
    expect(on.workflow_dispatch.inputs!.arm_runner.default).toBe('native');
    expect(on.workflow_dispatch.inputs!.arm_runner.options).toEqual(['native', 'emulated']);
    expect(on.workflow_call.inputs!.arm_runner.default).toBe('native');
  });

  test('two platforms, native: one runner per architecture, by digest, then a merge', () => {
    const { matrix, merge } = plan('linux/arm64,linux/amd64', 'native');
    expect(merge).toBe('true');
    expect(matrix).toEqual([
      { platforms: 'linux/arm64', arch: 'arm64', runner: 'ubuntu-24.04-arm', qemu: false, by_digest: true },
      { platforms: 'linux/amd64', arch: 'amd64', runner: 'ubuntu-latest', qemu: false, by_digest: true },
    ]);
  });

  // INVARIANT: a single platform builds and tags directly — no merge step.
  test('a single platform has no merge step', () => {
    for (const arm of ['native', 'emulated']) {
      for (const platform of ['linux/arm64', 'linux/amd64']) {
        const { matrix, merge } = plan(platform, arm);
        expect(merge).toBe('false');
        expect(matrix).toHaveLength(1);
        expect(matrix[0].by_digest).toBe(false);
      }
    }
    expect(plan('linux/arm64', 'native').matrix[0].runner).toBe('ubuntu-24.04-arm');
    expect(plan('linux/arm64', 'emulated').matrix[0]).toMatchObject({ runner: 'ubuntu-latest', qemu: true });
  });

  test('emulated: one QEMU job builds every platform, as before this change', () => {
    const { matrix, merge } = plan('linux/arm64,linux/amd64', 'emulated');
    expect(merge).toBe('false');
    expect(matrix).toEqual([{ platforms: 'linux/arm64,linux/amd64', arch: 'multi', runner: 'ubuntu-latest', qemu: true, by_digest: false }]);
  });

  for (const image of IMAGES) {
    test(`${image}: --cache-ref adds registry cache; by-digest pushes untagged; merge tags both registries`, () => {
      const cache = `ghcr.io/getlazy/${image}:buildcache-arm64`;
      const [build] = dryRun(image, ['--platform', 'linux/arm64', '--push-by-digest', '/tmp/digest', '--cache-ref', cache]);
      expect(build).toContain(`--cache-from type=registry,ref=${cache} --cache-to type=registry,ref=${cache},mode=max`);
      expect(build).toContain(`"name=ghcr.io/getlazy/${image},docker.io/getlazy/${image}",push-by-digest=true`);
      expect(build).not.toContain(' -t ');

      const merges = dryRun(image, ['--merge-digests', 'sha256:aa,sha256:bb']);
      expect(merges).toHaveLength(2);
      const tagsOf = (l: string) => [...l.matchAll(/ -t \S+:(\S+)/g)].map((m) => m[1]).sort();
      expect(tagsOf(merges[0])).toEqual(publishedTags(image).get('ghcr.io/getlazy')!);
      expect(tagsOf(merges[1])).toEqual(tagsOf(merges[0]));
      expect(merges[1]).toContain(`docker.io/getlazy/${image}@sha256:bb`);

      // Local builds stay registry-free: no cache flags unless asked for.
      const [plain] = dryRun(image, ['--platform', 'linux/amd64', '--push']);
      expect(plain).not.toContain('--cache-');
    }, 60_000);
  }
});

describe('image publish: revision guards', () => {
  // INVARIANT: every image job checks out one fixed commit (the release tag or
  // github.sha, never github.ref). The per-platform builds and the merge that
  // tags them run as separate jobs; a branch ref would let a mid-run push mix
  // commits inside one manifest.
  test('every image-job checkout is pinned to a commit', () => {
    const wf = loadWorkflow();
    for (const image of IMAGES) for (const jobName of [`${image}-build`, image]) {
      const co = wf.jobs[jobName].steps!.find((s) => s.uses?.startsWith('actions/checkout'))!;
      expect(String(co.with?.ref)).toEndWith('|| github.sha }}');
    }
  });

  test('plan trims whitespace and refuses a duplicate platform', () => {
    expect(plan('linux/arm64, linux/amd64', 'native').matrix.map((m) => m.platforms)).toEqual(['linux/arm64', 'linux/amd64']);
    const dir = mkdtempSync(join(tmpdir(), 'publish-plan-'));
    try {
      const r = spawnSyncUnsupervised(['bash', '-e', '-c', loadWorkflow().jobs.plan.steps![0].run!], {
        cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        env: { ...process.env, PLATFORMS: 'linux/amd64,linux/amd64', ARM_RUNNER: 'native', GITHUB_OUTPUT: join(dir, 'out') },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain('listed twice');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const image of IMAGES) {
    // The non-dry by-digest path is what every native CI leg runs; exercise it
    // against a fake docker that writes buildx's metadata file.
    test(`${image}: --push-by-digest writes the digest buildx reported`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'publish-digest-'));
      try {
        const bin = join(dir, 'bin');
        require('node:fs').mkdirSync(bin);
        const shim = join(bin, 'docker');
        require('node:fs').writeFileSync(shim, `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
prev=""
for a in "$@"; do
  if [[ "$prev" == "--metadata-file" ]]; then printf '{"containerimage.digest":"sha256:abc123"}' > "$a"; fi
  prev="$a"
done
exit 0
`, { mode: 0o755 });
        const out = join(dir, 'amd64');
        const r = spawnSyncUnsupervised(['bash', join(REPO, 'scripts', `publish-${image}-image.sh`), '--platform', 'linux/amd64', '--push-by-digest', out], {
          cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        expect(r.exitCode).toBe(0);
        expect(readFileSync(out, 'utf-8').trim()).toBe('sha256:abc123');
        expect(require('node:fs').existsSync(`${out}.metadata.json`)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test(`${image}: a local build without --cache-ref passes no empty argument`, () => {
      const [plain] = dryRun(image, ['--platform', 'linux/amd64']);
      expect(plain).not.toContain('  ');
    }, 60_000);
  }
});
