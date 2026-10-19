/**
 * `lazy_image_build` — a task agent test-builds its OWN task's Dockerfile.
 *
 * Why it exists: a Lazy Teams project whose Dockerfile.lazy fails to build
 * gets a "create a task to fix it". That task's agent can edit the file but,
 * without this, cannot tell whether its fix builds — the only build path ran
 * after accept. With it, the agent iterates; once a build passes, a project
 * admin adopts the file from the task's branch (src/daemon/image-adoption.ts).
 * Choosing an image stays a human act.
 *
 * THIS IS A DOCUMENTED EXCEPTION to "task worktrees never govern container
 * images" (AGENTS.md): it EXECUTES an agent-written Dockerfile's build steps,
 * and it governs NOTHING. Every rule below is load-bearing:
 *
 * - **microVM only.** Available solely on a managed daemon on the microVM
 *   backend (`imageTryBuildAvailable`), where the dockerd is the project's own
 *   guest dockerd inside its VM — never the Teams host's shared dockerd
 *   (local-docker backend), never a person's machine (solo / unmanaged), never
 *   the host-process runner. Elsewhere the tool is not advertised and the
 *   handler refuses it.
 * - **Task agents only.** The builder has no task of its own to build.
 * - **An ISOLATED builder, never the daemon's** (task-image-design §4, threat
 *   5). Building on the default builder would share its layer CACHE with the
 *   project's real image builds: a layer an agent-controlled `RUN` downloaded
 *   during a try-build would be reused by an accepted production build with
 *   the same instruction, and deleting a tag never deletes cached layers. So
 *   every call creates its own throwaway BuildKit builder
 *   (`docker buildx create --driver docker-container`), whose cache lives only
 *   inside that builder, builds there with `--output type=cacheonly` (no
 *   image is exported, nothing is tagged, nothing enters the image store), and
 *   removes the builder with its state (`docker buildx rm --force`) in a
 *   `finally`. The default builder, its cache and every image tag are never
 *   touched.
 * - **No credentials, no entitlements.** No `--secret`, no `--ssh`, no
 *   `--allow` (so no `network.host` / `security.insecure`), and every docker
 *   client call runs with a minimal environment and an EMPTY `DOCKER_CONFIG`,
 *   so no registry login, credential helper or context the daemon holds is
 *   available — the builder's own state lives in that throwaway config too.
 * - **A daemon-owned context.** The build context is the task branch's
 *   COMMITTED tree, exported with `git archive` into a private scratch dir —
 *   never the live worktree. The Dockerfile itself is the one exception, so
 *   an uncommitted edit can be tested before committing: its bytes are read
 *   once, from a REGULAR file that resolves inside the worktree, into the
 *   scratch dir, and only that copy is built.
 * - **Lazy's own base image.** The isolated builder cannot see the local
 *   image store, so a `FROM lazy-runner…` base is made present locally by lazy
 *   (it is lazy's image, built by lazy) and handed over read-only as an
 *   `oci-layout://` named build context exported with `docker save`.
 * - **Bounded.** One try-build per task at a time, a wall-clock limit on the
 *   build and on every setup/cleanup step; the VM's disk is the limit, and
 *   running it out is an accepted failure mode. Each call first sweeps
 *   builders an earlier call orphaned (a daemon restart mid-build, a failed
 *   `buildx rm`) by their BuildKit container and volume names.
 * - **Known difference from production builds:** `git archive` omits paths
 *   marked `export-ignore` in `.gitattributes`, so a Dockerfile that COPYs one
 *   fails here (and in a ref adoption) while the root build, whose context is
 *   the checkout, succeeds.
 *
 * Design and threat analysis: docs/design/task-image.md §4 (task-image-design),
 * narrowed by the engineer on 2026-10-03 to the microVM backend.
 */
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { MANAGED_BACKEND_ENV, isManagedMode } from '../config/managed-mode';
import { loadConfig } from '../config/loader';
import { CONVENTIONAL_DOCKERFILE, gitInRoot, prepareLazyBaseRefs } from '../capture/claude';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';

/** Wall-clock bound on the build itself. */
export const TRY_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

/** Bound on each setup / cleanup step (builder create, base export, builder rm). */
export const TRY_BUILD_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** The tail of the build output returned to the agent. */
const OUTPUT_TAIL_CHARS = 20_000;

/** The name prefix of a throwaway builder; nothing in lazy uses one otherwise. */
export const TRY_BUILD_BUILDER_PREFIX = 'lazy-trybuild-';

/** Whether this daemon offers `lazy_image_build` at all: managed AND microVM. */
export function imageTryBuildAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return isManagedMode(env) && env[MANAGED_BACKEND_ENV] === 'microvm';
}

export const TRY_BUILD_UNAVAILABLE =
  'lazy_image_build is only available on Lazy Teams projects that run on a microVM, where the build runs ' +
  'inside the project\'s own VM. On this install, commit Dockerfile.lazy and ask a person to build it.';

/** Task id → the builder its in-flight try-build owns. */
const inFlight = new Map<string, string>();

/** The docker container/volume name prefix buildx gives a docker-container builder's node. */
const BUILDKIT_NODE_PREFIX = `buildx_buildkit_${TRY_BUILD_BUILDER_PREFIX}`;

/**
 * Remove try-build builders a previous call left behind. A daemon restart
 * mid-build (every fleet roll restarts it) or a failed `buildx rm` orphans the
 * builder's BuildKit container and its state volume — and since the builder's
 * metadata lived in that call's deleted scratch DOCKER_CONFIG, `buildx rm` can
 * never find it again. So they are found by NAME and removed directly, sparing
 * builders this process has in flight. Failures are logged, never fatal: a
 * leftover costs disk, not correctness.
 */
async function sweepOrphanedBuilders(run: DockerRun, binary: string, env: Record<string, string>): Promise<void> {
  const live = [...inFlight.values()].map((b) => `buildx_buildkit_${b}`);
  const isLive = (name: string) => live.some((prefix) => name.startsWith(prefix));
  const list = async (argv: string[]) => {
    const r = await run(argv, { env, timeoutMs: TRY_BUILD_STEP_TIMEOUT_MS });
    if (r.exitCode !== 0) throw new Error(`${argv.slice(1, 3).join(' ')} failed: ${r.output.trim()}`);
    return r.output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(BUILDKIT_NODE_PREFIX) && !isLive(l));
  };
  try {
    const containers = await list([binary, 'ps', '-a', '--filter', `name=${BUILDKIT_NODE_PREFIX}`, '--format', '{{.Names}}']);
    if (containers.length > 0) {
      await run([binary, 'rm', '-f', ...containers], { env, timeoutMs: TRY_BUILD_STEP_TIMEOUT_MS });
    }
    const volumes = await list([binary, 'volume', 'ls', '-q', '--filter', `name=${BUILDKIT_NODE_PREFIX}`]);
    if (volumes.length > 0) {
      await run([binary, 'volume', 'rm', '-f', ...volumes], { env, timeoutMs: TRY_BUILD_STEP_TIMEOUT_MS });
    }
    if (containers.length + volumes.length > 0) {
      logger.info(`lazy_image_build: removed ${containers.length} orphaned builder container(s) and ${volumes.length} volume(s)`);
    }
  } catch (err) {
    logger.warn(`lazy_image_build: could not sweep orphaned try-build builders: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface TryBuildResult {
  ok: boolean;
  dockerfile: string;
  durationMs: number;
  /** The end of the build output, or of the failure. */
  output: string;
  /** Always true: nothing was exported or tagged, and the builder and its cache were removed. */
  discarded: true;
  /** What the build context was, for the agent's report. */
  context: string;
}

/** Runs one docker client command; replaceable in tests. */
export type DockerRun = (
  argv: string[],
  options: { env: Record<string, string>; cwd?: string; timeoutMs: number },
) => Promise<{ exitCode: number | null; output: string }>;

const defaultRun: DockerRun = async (argv, options) => {
  const proc = spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe', timeout: options.timeoutMs });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
};

export interface TryBuildTask {
  id: string;
  /** Code or short id, for messages. */
  label: string;
  /** The task's branch, whose committed tree is the build context. */
  branch: string;
}

export interface TryBuildDeps {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  run?: DockerRun;
  /** Ensures lazy's base images exist locally; replaceable in tests. */
  prepareBases?: typeof prepareLazyBaseRefs;
  /**
   * Called between the Dockerfile's path checks and its open — a seam for
   * the test that swaps the file for a symlink in exactly that window.
   */
  beforeDockerfileOpen?: () => Promise<void>;
}

/** Largest Dockerfile the try-build reads. */
const MAX_DOCKERFILE_BYTES = 1024 * 1024;

/**
 * Read the worktree Dockerfile ONCE, as the daemon — which can read things the
 * agent cannot — so the read must not be steerable by the agent, who can
 * rewrite the worktree at any moment:
 *
 * - the PARENT directory is resolved with realpath and must lie inside the
 *   worktree (a symlinked `docker/` pointing out is refused);
 * - the file is opened with O_NOFOLLOW (a final-component symlink fails the
 *   open itself — no check-then-read window) and O_NONBLOCK (a FIFO cannot
 *   hang the daemon), and fstat on THAT descriptor must say regular file;
 * - the bytes are read from that same descriptor, size-capped;
 * - afterwards the parent must still resolve to the same directory and the
 *   path must still name the same inode, so a parent swapped mid-read is
 *   refused rather than trusted.
 */
async function readWorktreeDockerfile(
  worktreePath: string,
  rel: string,
  beforeOpen?: () => Promise<void>,
): Promise<string> {
  const notRegular = () => new Error(
    `${rel} in this task's worktree is not a regular file (a symlink, directory or device); lazy only builds a Dockerfile itself.`);
  const missing = () => new Error(
    `There is no ${rel} in this task's worktree to build. Write it first (lazy_recipe task-image explains how).`);
  const outside = () => new Error(`${rel} resolves outside this task's worktree; lazy will not build it.`);

  const realRoot = await realpath(worktreePath);
  const parentRel = dirname(rel);
  const resolveParent = async () => {
    try {
      return await realpath(join(worktreePath, parentRel));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
      throw new Error(`could not resolve ${parentRel} in this task's worktree: ${(err as Error).message}`, { cause: err });
    }
  };
  const realParent = await resolveParent();
  const inside = relative(realRoot, realParent);
  if (inside.startsWith('..') || isAbsolute(inside)) throw outside();
  const leaf = join(realParent, basename(rel));

  await beforeOpen?.();
  let handle;
  try {
    handle = await open(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw missing();
    if (code === 'ELOOP' || code === 'EMLINK') throw notRegular();
    throw new Error(`could not open ${rel} in this task's worktree: ${(err as Error).message}`, { cause: err });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notRegular();
    const tooLarge = () => new Error(`${rel} is larger than ${MAX_DOCKERFILE_BYTES} bytes; lazy will not build it.`);
    if (st.size > MAX_DOCKERFILE_BYTES) throw tooLarge();
    // Bounded by bytes actually READ, not the fstat above: a file the agent
    // keeps growing must not make the daemon buffer without limit.
    const buf = Buffer.alloc(MAX_DOCKERFILE_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_DOCKERFILE_BYTES) throw tooLarge();
    const bytes = buf.subarray(0, filled).toString('utf-8');
    if ((await resolveParent()) !== realParent) throw outside();
    const now = await lstat(leaf).catch(() => null);
    if (!now || now.ino !== st.ino || now.dev !== st.dev) throw notRegular();
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Every docker client call's whole environment: enough to reach the guest dockerd, nothing more. */
export function tryBuildEnv(env: NodeJS.ProcessEnv, dockerConfig: string, home: string): Record<string, string> {
  const out: Record<string, string> = {
    PATH: env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: home,
    // Empty: no registry auths, no credential helpers, no contexts; the
    // throwaway builder's own metadata is written here and removed with it.
    DOCKER_CONFIG: dockerConfig,
  };
  if (env.DOCKER_HOST) out.DOCKER_HOST = env.DOCKER_HOST;
  return out;
}

async function step(run: DockerRun, argv: string[], env: Record<string, string>, what: string, cwd?: string): Promise<string> {
  const r = await run(argv, { env, cwd, timeoutMs: TRY_BUILD_STEP_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}):\n${r.output.trim().slice(-4000)}`);
  return r.output;
}

/**
 * The manifest digest of `ref` in an unpacked `docker save` archive, after
 * proving the archive IS an OCI image layout — what buildx's `oci-layout://`
 * named context reads.
 *
 * `docker save` writes an OCI layout (an `oci-layout` file, `index.json`,
 * `blobs/sha256/...`) from Docker Engine 25 onwards; the Teams microVM guest
 * runs docker-ce 29.x (lazy-teams/deploy/daemon-image/Dockerfile). Its index
 * names each image with the `io.containerd.image.name` annotation (the full
 * reference) and `org.opencontainers.image.ref.name` (the tag). An older
 * engine writes the legacy Docker archive (`manifest.json` only): refused
 * here, by name, rather than handed to buildx to fail obscurely.
 */
export async function ociLayoutDigest(dir: string, ref: string, tag: string): Promise<string> {
  const layout = await readFile(join(dir, 'oci-layout'), 'utf-8').catch(() => null);
  let index: { manifests?: Array<{ digest?: string; annotations?: Record<string, string> }> } | null = null;
  if (layout !== null) {
    try {
      if (typeof JSON.parse(layout).imageLayoutVersion !== 'string') throw new Error('no imageLayoutVersion');
      index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8'));
    } catch (err) {
      throw new Error(`lazy's base image ${ref} was exported as a malformed OCI layout: ${(err as Error).message}`);
    }
  }
  if (!index) {
    throw new Error(
      `lazy's base image ${ref} was exported as a legacy Docker archive, not an OCI image layout; ` +
      `this needs Docker Engine 25 or newer in the project's machine.`,
    );
  }
  const manifests = (index.manifests ?? []).filter((m) => typeof m.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(m.digest));
  const named = manifests.filter((m) => {
    const name = m.annotations?.['io.containerd.image.name'];
    return name === ref || name?.endsWith(`/${ref}`) || m.annotations?.['org.opencontainers.image.ref.name'] === tag;
  });
  const chosen = named.length === 1 ? named[0] : (named.length === 0 && manifests.length === 1 ? manifests[0] : null);
  if (!chosen) {
    throw new Error(`lazy's base image ${ref}: its OCI layout names ${named.length || manifests.length} candidate images, expected one.`);
  }
  return chosen.digest!;
}

/** `--build-context` arguments handing lazy's base images to the isolated builder. */
async function baseContexts(run: DockerRun, binary: string, env: Record<string, string>, refs: string[], scratch: string): Promise<string[]> {
  const args: string[] = [];
  for (const [i, ref] of refs.entries()) {
    const dir = join(scratch, `base-${i}`);
    const tar = `${dir}.tar`;
    await step(run, [binary, 'save', '-o', tar, ref], env, `exporting lazy's base image ${ref}`);
    await mkdir(dir, { recursive: true });
    await step(run, ['tar', '-xf', tar, '-C', dir], env, `unpacking ${ref}`);
    const colon = ref.lastIndexOf(':');
    const repo = colon > 0 ? ref.slice(0, colon) : ref;
    const tag = colon > 0 ? ref.slice(colon + 1) : 'latest';
    // Pinned by DIGEST, read from the layout's own index, rather than by tag.
    const digest = await ociLayoutDigest(dir, ref, tag);
    args.push('--build-context', `${ref}=oci-layout://${dir}@${digest}`);
    // `FROM lazy-runner` names the repository alone; it is the same image.
    if (tag === 'latest') args.push('--build-context', `${repo}=oci-layout://${dir}@${digest}`);
  }
  return args;
}

export async function tryBuildTaskDockerfile(
  projectRoot: string,
  task: TryBuildTask,
  worktreePath: string,
  deps: TryBuildDeps = {},
): Promise<TryBuildResult> {
  const env = deps.env ?? process.env;
  if (!imageTryBuildAvailable(env)) throw new Error(TRY_BUILD_UNAVAILABLE);
  if (!task.id) throw new Error('lazy_image_build builds the calling task\'s own Dockerfile; it is not available in builder mode.');
  if (inFlight.has(task.id)) throw new Error('A lazy_image_build for this task is already running; wait for it to finish.');
  // RESERVED synchronously, before the first await, so two calls for one
  // task cannot both pass the check above; also what the orphan sweep spares.
  const builder = `${TRY_BUILD_BUILDER_PREFIX}${randomBytes(6).toString('hex')}`;
  inFlight.set(task.id, builder);
  try {
    return await runTryBuild(projectRoot, task, worktreePath, deps, env, builder);
  } finally {
    inFlight.delete(task.id);
  }
}

async function runTryBuild(
  projectRoot: string,
  task: TryBuildTask,
  worktreePath: string,
  deps: TryBuildDeps,
  env: NodeJS.ProcessEnv,
  builder: string,
): Promise<TryBuildResult> {
  const config = await loadConfig(projectRoot);
  const rel = (config.docker.dockerfile || CONVENTIONAL_DOCKERFILE).replace(/^\.\//, '');
  const content = await readWorktreeDockerfile(worktreePath, rel, deps.beforeDockerfileOpen);

  const binary = deps.binary ?? 'docker';
  const run = deps.run ?? defaultRun;
  const scratch = await mkdtemp(join(tmpdir(), 'lazy-trybuild-'));
  const dockerConfig = join(scratch, 'docker-config');
  const contextDir = join(scratch, 'context');
  const dockerfileCopy = join(scratch, 'Dockerfile');
  const clientEnv = tryBuildEnv(env, dockerConfig, scratch);
  const contextLabel = `the committed tree of ${task.branch}, with this worktree's ${rel}`;
  await sweepOrphanedBuilders(run, binary, clientEnv);
  const started = Date.now();
  let builderCreated = false;
  const done = (ok: boolean, output: string): TryBuildResult => ({
    ok, dockerfile: rel, durationMs: Date.now() - started, output: output.slice(-OUTPUT_TAIL_CHARS), discarded: true, context: contextLabel,
  });
  try {
    await mkdir(dockerConfig, { mode: 0o700 });
    await mkdir(contextDir);
    await writeFile(dockerfileCopy, content, { mode: 0o600 });

    // The context: the task branch's COMMITTED tree, never the live worktree.
    const tarPath = join(scratch, 'context.tar');
    const archive = await gitInRoot(projectRoot, ['archive', '--format=tar', '-o', tarPath, `refs/heads/${task.branch}`],
      TRY_BUILD_STEP_TIMEOUT_MS);
    if (archive.exitCode !== 0) {
      const why = archive.exitCode === null
        ? `git archive did not finish within ${TRY_BUILD_STEP_TIMEOUT_MS / 60000} minutes`
        : archive.stderr.trim();
      return done(false, `Could not export ${task.branch}'s committed files as the build context: ${why}`);
    }
    await step(run, ['tar', '-xf', tarPath, '-C', contextDir], clientEnv, 'unpacking the build context');

    const bases = await (deps.prepareBases ?? prepareLazyBaseRefs)(projectRoot, content, `${rel} in task ${task.label}`, binary);
    const baseArgs = await baseContexts(run, binary, clientEnv, bases.buildable, scratch);

    await step(run, [binary, 'buildx', 'create', '--name', builder, '--driver', 'docker-container'], clientEnv,
      'creating an isolated builder');
    builderCreated = true;

    const build = await run([
      binary, 'buildx', 'build',
      '--builder', builder,
      '--progress', 'plain',
      // Nothing is exported: no image, no tag, nothing in the image store.
      '--output', 'type=cacheonly',
      '-f', dockerfileCopy,
      ...baseArgs,
      contextDir,
    ], { env: clientEnv, timeoutMs: TRY_BUILD_TIMEOUT_MS });
    return done(build.exitCode === 0, build.exitCode === 0 ? build.output : `Build failed (exit ${build.exitCode}).\n${build.output}`);
  } catch (err) {
    return done(false, err instanceof Error ? err.message : String(err));
  } finally {
    if (builderCreated) {
      // Removes the builder container AND its state volume (the cache).
      await run([binary, 'buildx', 'rm', '--force', builder], { env: clientEnv, timeoutMs: TRY_BUILD_STEP_TIMEOUT_MS })
        .then((r) => {
          if (r.exitCode !== 0) logger.warn(`lazy_image_build: could not remove the isolated builder ${builder}: ${r.output.trim()}`);
        })
        .catch((e) => logger.warn(`lazy_image_build: could not remove the isolated builder ${builder}: ${e instanceof Error ? e.message : String(e)}`));
    }
    await rm(scratch, { recursive: true, force: true }).catch((e) => logger.warn(`lazy_image_build: could not remove ${scratch}: ${e}`));
  }
}
