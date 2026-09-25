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
 * the created timestamp that backs the age-based freshness check, line 4 = the
 * `lazy.image.inputs` manifest label, empty on pre-build_inputs images) plus an
 * `images.tsv` that backs `docker images --format`. Containers live the same way
 * in `containers.tsv` (name, state, `lazy.project` label, id), backing `ps -a`
 * and `rm -f`. A test seeds them directly, and a DETACHED `run -d` registers its
 * own — so a daemon-owned builder session's container is really "running" until
 * a `stop` moves it to `exited`, which is what makes the SIGTERM window its
 * resume-intent handshake happens in reachable at all. Every invocation is
 * appended to `invocations.log`, so tests assert on the argv lazy actually passed.
 *
 * Builds additionally record their CONTEXT — the cwd and the tree found there.
 * Argv alone cannot show it (lazy always passes `.`), and "which tree did this
 * build see" is exactly what the worktree-image flow gets wrong when it
 * regresses.
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
    # A test flips fail-info to get the state \`which\` cannot see: the binary is
    # installed, its daemon is not running. Every listing path fails OPEN there
    # (\`docker images\` and \`docker ps\` exit non-zero and lazy reads that as an
    # empty list), so anything that reports "nothing found" has to probe first.
    if [ -f "\$STATE/fail-info" ]; then
      echo "fake docker: Cannot connect to the Docker daemon" >&2
      exit 1
    fi
    exit 0
    ;;
  image)
    if [ "\${2:-}" = "inspect" ]; then
      file="\$(reffile "\${3:-}")"
      [ -f "\$file" ] || exit 1
      case "\${5:-}" in
        *lazy.image.inputs*) sed -n 4p "\$file" ;;
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
  inspect)
    # inspect --format '{{... .IPAddress ...}}' <container>: a member terminal
    # container's address on its own network, which lazy pins the member's
    # credential to. A fixed address stands in for Docker's IPAM; a test can
    # override it by writing container-ip.
    case "\$*" in
      *IPAddress*)
        if [ -f "\$STATE/container-ip" ]; then cat "\$STATE/container-ip"; else echo "172.30.0.2"; fi
        ;;
    esac
    exit 0
    ;;
  ps)
    # Two real shapes reach this: the project-wide
    # \`ps -a --filter name=^lazy- --format {{.Names}}<tab>{{.State}}<tab>{{.Label …}}\`
    # and \`containerExists\`'s single-name \`--filter name=^/<n>$ --format {{.ID}}\`.
    # Anchors are stripped and the remainder matched as a PREFIX — exact for both
    # queries over the names a test seeds. Without \`-a\` only RUNNING containers
    # are listed, as docker does: that is \`isContainerRunning\`'s probe.
    filter=""
    format=""
    all=""
    shift
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -a|--all) all=1; shift ;;
        --filter) filter="\$2"; shift 2 ;;
        --format) format="\$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    pattern="\$(printf '%s' "\$filter" | sed 's/^name=//' | tr -d '^\$/')"
    [ -f "\$STATE/containers.tsv" ] || exit 0
    # A tab IS an IFS whitespace character, so bash COLLAPSES a run of them and
    # an empty column would shift every later field left. Hence the \`-\`
    # sentinel for "no label" in the state file, translated back to the empty
    # string docker actually prints.
    while IFS=\$'\\t' read -r cname cstate clabel cid; do
      [ -n "\$cname" ] || continue
      case "\$cname" in
        "\$pattern"*) ;;
        *) continue ;;
      esac
      [ -n "\$all" ] || [ "\$cstate" = "running" ] || continue
      case "\$format" in
        *ID*) printf '%s\\n' "\$cid" ;;
        *)
          [ "\$clabel" = "-" ] && clabel=""
          printf '%s\\t%s\\t%s\\n' "\$cname" "\$cstate" "\$clabel"
          ;;
      esac
    done < "\$STATE/containers.tsv"
    exit 0
    ;;
  rm)
    # \`rm -f <name>\`, the runner's container removal. A test flips fail-rm to get
    # a runtime that REFUSES: \`removeContainer\` only LOGS a non-zero exit and
    # returns normally, so a caller that treats a clean return as proof the
    # container is gone reports a false success.
    shift
    target=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -*) shift ;;
        *) target="\$1"; shift ;;
      esac
    done
    if [ -f "\$STATE/fail-rm" ]; then
      echo "fake docker: refusing to remove \$target" >&2
      exit 1
    fi
    # A test scripts what happens DURING a removal with \`onRm\` (the hook gets the
    # container name), which is how a race that lands inside a caller's window
    # is made deterministic rather than hoped for.
    if [ -f "\$STATE/rm-hook" ]; then
      bash "\$STATE/rm-hook" "\$target"
    fi
    if [ -f "\$STATE/containers.tsv" ]; then
      awk -F'\\t' -v n="\$target" '\$1 != n' "\$STATE/containers.tsv" > "\$STATE/containers.tsv.new"
      mv "\$STATE/containers.tsv.new" "\$STATE/containers.tsv"
    fi
    exit 0
    ;;
  run)
    # Throwaway probe containers (e.g. \`docker run --rm <image> which <bin>\`).
    # Succeed by default; a test flips the fail-run flag to simulate a probe
    # that finds the binary missing.
    if [ -f "\$STATE/fail-run" ]; then
      exit 1
    fi
    # Machine one-shot containers carry lazy.oneshot=1, and a \`runClaude\`
    # prompt run (the pair summary) carries \`claude -p\` — both parse stdout as
    # an agent answer, so emit a minimal JSON result for either without a real
    # agent image. Image probes (\`docker run --rm <image> which <bin>\`) match
    # neither and stay silent.
    if printf '%s' "\$*" | grep -q 'lazy.oneshot=1' || printf '%s' "\$*" | grep -q -- ' claude -p '; then
      if [ -f "\$STATE/oneshot-response" ]; then
        result="\$(cat "\$STATE/oneshot-response")"
      else
        result='fake one-shot answer'
      fi
      # session_id is REQUIRED by the claude-code parser (requireResponseFields:
      # result AND session_id) — a real claude result event always carries it, so
      # a canned response without one made every oneshot parse throw and the
      # caller fall back deterministically (accept-oneshot-cwd has failed on this
      # since session_id became required in release-v020).
      printf '{"type":"result","result":"%s","session_id":"fake-oneshot-sess"}\\n' "\$result"
      exit 0
    fi
    # A DETACHED run (\`-d\`) stands in for a long-lived builder container: hold
    # the launch so the test can observe the 'starting' row the handler wrote
    # BEFORE the container launch finished (claim-before-launch). Probes and
    # one-shot runs carry no \`-d\` and fall through immediately.
    if [ -f "\$STATE/run-delay" ]; then
      case "\$*" in
        *" -d "*) sleep "\$(cat "\$STATE/run-delay")" ;;
      esac
    fi
    # A detached run REGISTERS its container, so \`ps\` reports it running and a
    # later \`stop\` is a real state change. Without this a detached launch left
    # no container behind at all: \`isRunning\` answered false the instant the
    # launch returned, so every stop took the "already gone" branch and nothing
    # downstream of a LIVE container — the SIGTERM window the resume-intent
    # handshake happens in — was reachable from a test.
    case "\$*" in
      *" -d "*)
        dname=""
        set -- \$*
        while [ \$# -gt 0 ]; do
          case "\$1" in
            --name) dname="\$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [ -n "\$dname" ]; then
          if [ -f "\$STATE/containers.tsv" ]; then
            awk -F'\\t' -v n="\$dname" '\$1 != n' "\$STATE/containers.tsv" > "\$STATE/containers.tsv.new"
            mv "\$STATE/containers.tsv.new" "\$STATE/containers.tsv"
          fi
          printf '%s\\trunning\\t-\\tsha256:container-%s\\n' "\$dname" "\$dname" >> "\$STATE/containers.tsv"
        fi
        ;;
    esac
    exit 0
    ;;
  stop|kill)
    # \`stop --time <n> <name>\`: the graceful SIGTERM window a daemon-owned
    # builder session's end runs through; \`kill <name>\` is the runner's default
    # stop. A test flips fail-stop for a runtime that refuses (see
    # builder-session-stop-failure).
    shift
    target=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        --time) shift 2 ;;
        -*) shift ;;
        *) target="\$1"; shift ;;
      esac
    done
    if [ -f "\$STATE/fail-stop" ]; then
      echo "fake docker: refusing to stop \$target" >&2
      exit 1
    fi
    # The container's own exit handler is what stamps the resume intent during
    # this window. A test scripts it with \`onStop\`, which receives the stopped
    # container's name — the stand-in for the in-container supervisor's SIGTERM
    # handler, which no fake \`docker\` can run for real.
    if [ -f "\$STATE/stop-hook" ]; then
      bash "\$STATE/stop-hook" "\$target"
    fi
    if [ -f "\$STATE/containers.tsv" ]; then
      awk -F'\\t' -v OFS='\\t' -v n="\$target" '\$1 == n { \$2 = "exited" } { print }' "\$STATE/containers.tsv" > "\$STATE/containers.tsv.new"
      mv "\$STATE/containers.tsv.new" "\$STATE/containers.tsv"
    fi
    exit 0
    ;;
  exec)
    # In-container pairing is \`docker exec … lazy-agent pair …\` (and the
    # reach-in stop is \`docker exec … sh -c kill …\`). A test whose subject is
    # what happens AFTER the session — the post-pairing capture — needs the
    # session to leave something behind, so it scripts the exec: the hook runs
    # with the exec's own argv (everything after \`exec\`), which carries
    # \`--worktree <path>\` for the sandbox to write into.
    if [ -f "\$STATE/exec-hook" ]; then
      shift
      bash "\$STATE/exec-hook" "\$@"
      exit \$?
    fi
    exit 0
    ;;
  build)
    shift
    tags=()
    dockerfile=""
    hash=""
    inputs=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -t) tags+=("\$2"); shift 2 ;;
        --label)
          case "\$2" in
            lazy.dockerfile.hash=*) hash="\${2#lazy.dockerfile.hash=}" ;;
            lazy.image.inputs=*)    inputs="\${2#lazy.image.inputs=}" ;;
          esac
          shift 2
          ;;
        -f) dockerfile="\$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    # Record the BUILD CONTEXT (cwd + the tree docker would have seen). Recorded
    # before the fail check so a failing build is still inspectable, and one
    # record per build attempt so indices line up with builds().
    mkdir -p "\$STATE/contexts"
    c=\$(cat "\$STATE/context-count" 2>/dev/null || echo 0)
    c=\$((c + 1))
    echo "\$c" > "\$STATE/context-count"
    printf '%s\\n' "\$PWD" >> "\$STATE/build-cwds.log"
    (cd "\$PWD" && find . -mindepth 1 | sed 's|^\\./||' | LC_ALL=C sort) > "\$STATE/contexts/\$c.files" 2>/dev/null
    # Keep the one file whose CONTENT decides a build: the Dockerfile \`-f\`
    # named. It is a temp copy of the consented bytes that lazy deletes the
    # moment the build returns, so a test cannot read it afterwards — copy it
    # while it exists. The file, not the tree: the root-Dockerfile path builds
    # with the whole project as its context, and copying that every build would
    # be absurd.
    mkdir -p "\$STATE/contexts/\$c.content"
    [ -n "\$dockerfile" ] && [ -f "\$dockerfile" ] && cp "\$dockerfile" "\$STATE/contexts/\$c.content/dockerfile" 2>/dev/null
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
    # A real \`docker build\` is not instantaneous, and the per-image build lock is
    # only observable if a concurrent caller can actually overlap this window.
    if [ -f "\$STATE/build-delay" ]; then sleep "\$(cat "\$STATE/build-delay")"; fi
    for t in "\${tags[@]}"; do
      printf '%s\\n%s\\n%s\\n%s\\n' "\$hash" "\$id" "\$created" "\$inputs" > "\$(reffile "\$t")"
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
  seedImage(ref: string, opts?: {
    dockerfileHash?: string;
    id?: string;
    size?: string;
    createdAt?: Date | string;
    /** `lazy.image.inputs` label. Omitted → absent, as on pre-build_inputs images. */
    inputs?: Record<string, string>;
  }): Promise<void>;
  /**
   * Pretend a container exists on this host, for `docker ps -a` and the
   * single-name existence probe. `project` backs the `lazy.project` label;
   * omitting it means an UNLABELED container, which is what every container
   * built before that label existed looks like.
   */
  seedContainer(name: string, opts?: {
    /** The runtime's own one-word `{{.State}}`. Defaults to `exited`. */
    state?: string;
    project?: string;
    id?: string;
  }): Promise<void>;
  /** Names of the containers the fake still has, in seeded order. */
  containers(): Promise<string[]>;
  /** Every `docker build` invocation so far, as the joined argv string. */
  builds(): Promise<string[]>;
  /**
   * The cwd of each build attempt, in order — i.e. the docker BUILD CONTEXT
   * directory, which `builds()` cannot show because lazy always passes `.`.
   */
  buildCwds(): Promise<string[]>;
  /**
   * Paths (relative, sorted) the build context of attempt `index` contained.
   * Same 0-based ordering as `builds()` / `buildCwds()`.
   */
  buildContextFiles(index: number): Promise<string[]>;
  /**
   * Content of the Dockerfile `-f` named for attempt `index`; null when that
   * build named none. Snapshotted at build time, because lazy builds from a
   * temp copy it deletes the moment the build returns.
   */
  buildContextContent(index: number, which: 'dockerfile'): Promise<string | null>;
  /** Every invocation so far, as joined argv strings. */
  invocations(): Promise<string[]>;
  /** Make the next build fail (offline-fallback tests). */
  failBuilds(): Promise<void>;
  /**
   * Make `docker info` fail: installed, but its daemon is not running. Every
   * lazy listing path reads that as an EMPTY list rather than an error, so it is
   * the state anything reporting "nothing to clean up" has to rule out first.
   */
  failInfo(): Promise<void>;
  /**
   * Make `docker rm -f` fail. `removeContainer` only logs a non-zero exit, so
   * this is how a test reaches the false-success path.
   */
  failRemovals(): Promise<void>;
  /**
   * Make every build take `seconds`, so concurrent callers genuinely overlap.
   * Without it a "one build across N parallel starts" assertion can pass by
   * accident: the first build finishes before the second caller even inspects.
   */
  slowBuilds(seconds: number): Promise<void>;
  /**
   * Hold DETACHED `docker run` launches for `seconds` (a detached builder
   * session stand-in). Probe runs (`--rm`) and one-shot/prompt runs are never
   * held — only the detached argv carries `-d`. This is how a test observes a
   * claim that was written BEFORE the container launch finished: the
   * `startBuilderSession` handler is parked in the launch while the test polls
   * the storage row.
   */
  slowDetachedRuns(seconds: number): Promise<void>;
  /** Make `docker run` probes fail (missing-binary preflight tests). */
  failRuns(): Promise<void>;
  /**
   * Make `docker stop` fail: a runtime that refuses, which is how a caller
   * reaches the "the stop did not happen" branch it must not report as success.
   */
  failStops(): Promise<void>;
  /**
   * Run `script` (bash) on every `docker stop`, with the stopped container's
   * name as its only argument — the stand-in for the in-container supervisor's
   * SIGTERM handler, which is the half of the resume-intent handshake that
   * runs inside a container no fake runtime can host.
   */
  onStop(script: string): Promise<void>;
  /**
   * Run `script` (bash) on every `docker rm`, before the removal, with the
   * container name as its only argument. For races that must land inside a
   * caller's window, deterministically.
   */
  onRm(script: string): Promise<void>;
  /**
   * JSON `result` field returned by the next one-shot container run — a
   * labelled machine one-shot, or a `claude -p` prompt run such as the pair
   * summary.
   */
  setOneshotResponse(text: string): Promise<void>;
  /**
   * Run `script` (bash) on every `docker exec`, with the exec's own argv as
   * its arguments — everything after `exec`, so `--worktree <path>` and
   * `--agent <harness>` are readable. This is how a test stands in for an
   * in-container pairing session: the script writes whatever the "session"
   * would have left in the sandbox, and its exit code is the exec's.
   */
  onExec(script: string): Promise<void>;
  /** Every `docker exec` invocation so far, as joined argv strings. */
  execs(): Promise<string[]>;
}

export async function installFakeDocker(
  baseDir: string,
  options: {
    /**
     * Executable name to install under. `podman` is the second runtime lazy
     * supports and is passed as the `binary` argument exactly like docker, so a
     * suite covering both installs one fake per name (each with its own state).
     */
    name?: string;
  } = {},
): Promise<FakeDocker> {
  const name = options.name ?? 'docker';
  const binDir = join(baseDir, `fake-${name}-bin`);
  const stateDir = join(baseDir, `fake-${name}-state`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stateDir, 'images'), { recursive: true });

  const scriptPath = join(binDir, name);
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
      const inputs = opts.inputs ? JSON.stringify(opts.inputs) : '';
      await writeFile(join(stateDir, 'images', ref.replace(/[:/]/g, '_')), `${hash}\n${id}\n${createdAt}\n${inputs}\n`);
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
    async seedContainer(name, opts = {}) {
      const state = opts.state ?? 'exited';
      // `-` means "no label": see the IFS note in the ps case — an empty column
      // would shift every field after it.
      const project = opts.project ?? '-';
      const id = opts.id ?? `sha256:container-${name.replace(/[^a-z0-9]/gi, '')}`;
      const existing = (await readLines('containers.tsv')).filter(line => line.split('\t')[0] !== name);
      await writeFile(
        join(stateDir, 'containers.tsv'),
        [...existing, `${name}\t${state}\t${project}\t${id}`].join('\n') + '\n',
      );
    },
    async containers() {
      return (await readLines('containers.tsv')).map(line => line.split('\t')[0] ?? '');
    },
    async builds() {
      return (await readLines('invocations.log')).filter(line => line.startsWith('build '));
    },
    async buildCwds() {
      return readLines('build-cwds.log');
    },
    async buildContextFiles(index) {
      return readLines(join('contexts', `${index + 1}.files`));
    },
    async buildContextContent(index, which) {
      try {
        return await readFile(join(stateDir, 'contexts', `${index + 1}.content`, which), 'utf-8');
      } catch {
        // Absent from that build's context — a real answer, not a failure.
        return null;
      }
    },
    async invocations() {
      return readLines('invocations.log');
    },
    async failBuilds() {
      await writeFile(join(stateDir, 'fail-build'), '1');
    },
    async failInfo() {
      await writeFile(join(stateDir, 'fail-info'), '1');
    },
    async failRemovals() {
      await writeFile(join(stateDir, 'fail-rm'), '1');
    },
    async slowBuilds(seconds) {
      await writeFile(join(stateDir, 'build-delay'), String(seconds));
    },
    async slowDetachedRuns(seconds) {
      await writeFile(join(stateDir, 'run-delay'), String(seconds));
    },
    async failRuns() {
      await writeFile(join(stateDir, 'fail-run'), '1');
    },
    async failStops() {
      await writeFile(join(stateDir, 'fail-stop'), '1');
    },
    async onStop(script: string) {
      await writeFile(join(stateDir, 'stop-hook'), script);
    },
    async onRm(script: string) {
      await writeFile(join(stateDir, 'rm-hook'), script);
    },
    async setOneshotResponse(text: string) {
      await writeFile(join(stateDir, 'oneshot-response'), text);
    },
    async onExec(script: string) {
      await writeFile(join(stateDir, 'exec-hook'), script);
    },
    async execs() {
      return (await readLines('invocations.log')).filter(line => line.startsWith('exec '));
    },
  };
}
