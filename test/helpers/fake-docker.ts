/**
 * Fake `docker` binary — the e2e seam for lazy's IMAGE logic.
 *
 * WHY THIS EXISTS
 * ---------------
 * `test/mocks/claude.ts` replaces `ensureImage`/`resolveImageName` wholesale, so
 * no test using that seam can ever reach the code that decides WHICH image ref
 * to run or WHETHER to build it. That is exactly the code that let a host serve
 * a months-old `lazy-runner:latest` forever, so it needs a seam of its own.
 *
 * This one sits below lazy: a scriptable `docker` executable that lazy is
 * pointed at directly (as its `binary` argument). Everything in
 * `src/capture/claude.ts` runs unmocked — tag composition, the hash-label check,
 * the build invocation — and the only fake thing is the container runtime.
 *
 * The fake keeps its whole world in a state directory: one file per image ref
 * (line 1 = the `lazy.dockerfile.hash` label, line 2 = the image ID, line 3 =
 * the created timestamp that backs the age-based freshness check) plus an
 * `images.tsv` that backs `docker images --format`. Every invocation is appended
 * to `invocations.log`, so tests assert on the argv lazy actually passed.
 */

import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
mkdir -p "\$STATE/images"
printf '%s\\n' "\$*" >> "\$STATE/invocations.log"

reffile() { printf '%s/images/%s' "\$STATE" "\$(printf '%s' "\$1" | tr ':/' '__')"; }

case "\${1:-}" in
  info)
    exit 0
    ;;
  image)
    if [ "\${2:-}" = "inspect" ]; then
      file="\$(reffile "\${3:-}")"
      [ -f "\$file" ] || exit 1
      case "\${5:-}" in
        *Labels*)  sed -n 1p "\$file" ;;
        *Created*) sed -n 3p "\$file" ;;
        *)         sed -n 2p "\$file" ;;
      esac
      exit 0
    fi
    exit 1
    ;;
  images)
    cat "\$STATE/images.tsv" 2>/dev/null
    exit 0
    ;;
  run)
    # Throwaway probe containers (e.g. \`docker run --rm <image> which <bin>\`).
    # Succeed by default; a test flips the fail-run flag to simulate a probe
    # that finds the binary missing.
    if [ -f "\$STATE/fail-run" ]; then
      exit 1
    fi
    exit 0
    ;;
  build)
    shift
    tags=()
    hash=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -t) tags+=("\$2"); shift 2 ;;
        --label) hash="\${2#lazy.dockerfile.hash=}"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -f "\$STATE/fail-build" ]; then
      echo "fake docker: build failed on purpose" >&2
      exit 1
    fi
    n=\$(cat "\$STATE/build-count" 2>/dev/null || echo 0)
    n=\$((n + 1))
    echo "\$n" > "\$STATE/build-count"
    id="sha256:fakeimage\$n"
    # A build always produces a freshly-created image — that is precisely what
    # the age check reads, and what makes a rebuild reset the freshness clock.
    created="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for t in "\${tags[@]}"; do
      printf '%s\\n%s\\n%s\\n' "\$hash" "\$id" "\$created" > "\$(reffile "\$t")"
      repo="\${t%:*}"
      tag="\${t##*:}"
      if [ -f "\$STATE/images.tsv" ]; then
        awk -F'\\t' -v r="\$repo" -v g="\$tag" '!(\$1 == r && \$2 == g)' "\$STATE/images.tsv" > "\$STATE/images.tsv.new"
        mv "\$STATE/images.tsv.new" "\$STATE/images.tsv"
      fi
      printf '%s\\t%s\\t%s\\t1.2GB\\n' "\$repo" "\$tag" "\$id" >> "\$STATE/images.tsv"
    done
    exit 0
    ;;
esac
exit 0
`;

export interface FakeDocker {
  /**
   * Absolute path to the fake executable. Pass it as the `binary` argument of
   * `ensureImage`/`listLazyImages` — Bun snapshots PATH at process start, so
   * mutating `process.env.PATH` in the test process does NOT affect how spawned
   * binaries are resolved (`Bun.which` returns null for a PATH added later).
   */
  binPath: string;
  /** Directory holding the fake executable. */
  binDir: string;
  /** Directory holding the fake's state. */
  stateDir: string;
  /**
   * Pretend an image already exists on this host. `createdAt` (ISO-8601) backs
   * `docker image inspect --format {{.Created}}` and therefore the age-based
   * freshness check; it defaults to "just built", so a test that says nothing
   * about age gets an image that is trivially fresh.
   */
  seedImage(ref: string, opts?: { dockerfileHash?: string; id?: string; size?: string; createdAt?: Date | string }): Promise<void>;
  /** Every `docker build` invocation so far, as the joined argv string. */
  builds(): Promise<string[]>;
  /** Every invocation so far, as joined argv strings. */
  invocations(): Promise<string[]>;
  /** Make the next build fail (offline-fallback tests). */
  failBuilds(): Promise<void>;
  /** Make `docker run` probes fail (missing-binary preflight tests). */
  failRuns(): Promise<void>;
}

export async function installFakeDocker(baseDir: string): Promise<FakeDocker> {
  const binDir = join(baseDir, 'fake-docker-bin');
  const stateDir = join(baseDir, 'fake-docker-state');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stateDir, 'images'), { recursive: true });

  const scriptPath = join(binDir, 'docker');
  // The state directory is baked into the script rather than passed via env:
  // Bun snapshots the environment for spawned processes at startup, so a
  // variable set later in the test process never reaches the fake.
  await writeFile(scriptPath, SCRIPT.replace('__STATE_DIR__', stateDir));
  await chmod(scriptPath, 0o755);

  async function readLines(file: string): Promise<string[]> {
    try {
      const raw = await readFile(join(stateDir, file), 'utf-8');
      return raw.split('\n').filter(line => line.trim().length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`fake docker: failed to read ${file}: ${(err as Error).message}`);
    }
  }

  return {
    binPath: scriptPath,
    binDir,
    stateDir,
    async seedImage(ref, opts = {}) {
      const id = opts.id ?? `sha256:seeded-${ref.replace(/[^a-z0-9]/gi, '')}`;
      const hash = opts.dockerfileHash ?? 'seeded-hash';
      const size = opts.size ?? '900MB';
      const createdAt = opts.createdAt instanceof Date
        ? opts.createdAt.toISOString()
        : (opts.createdAt ?? new Date().toISOString());
      await writeFile(join(stateDir, 'images', ref.replace(/[:/]/g, '_')), `${hash}\n${id}\n${createdAt}\n`);
      const colon = ref.lastIndexOf(':');
      const repository = ref.slice(0, colon);
      const tag = ref.slice(colon + 1);
      const existing = await readLines('images.tsv');
      const kept = existing.filter(line => {
        const [r, t] = line.split('\t');
        return !(r === repository && t === tag);
      });
      await writeFile(
        join(stateDir, 'images.tsv'),
        [...kept, `${repository}\t${tag}\t${id}\t${size}`].join('\n') + '\n',
      );
    },
    async builds() {
      return (await readLines('invocations.log')).filter(line => line.startsWith('build '));
    },
    async invocations() {
      return readLines('invocations.log');
    },
    async failBuilds() {
      await writeFile(join(stateDir, 'fail-build'), '1');
    },
    async failRuns() {
      await writeFile(join(stateDir, 'fail-run'), '1');
    },
  };
}
