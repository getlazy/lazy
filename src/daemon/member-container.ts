/**
 * A member's OWN terminal container, on a shared daemon.
 *
 * A member's Shell, Pair and Chat (reached through Teams on
 * `/rpc/sessions/:id/attach/ws`) never run inside the task's container. They
 * run in a container created for that member when their first terminal opens,
 * and removed when their session ends (src/server/member-terminals.ts). It is
 * built from the task's image and has the task's worktree mounted, and it
 * shares NOTHING else with the containers the task's turns run in:
 *
 *   - its own PID, IPC and mount namespaces, its own /tmp and its own $HOME, so
 *     no process a turn left running (a dev server, a `nohup`, anything a
 *     prompt-injected agent planted) can see it, and it sees none of theirs;
 *   - its own NETWORK: every member container joins {@link MEMBER_NETWORK}, a
 *     bridge of its own with inter-container traffic off, never the default
 *     bridge the task containers share. A port a turn listens on is
 *     unreachable from a member's terminal, a port a member's dev server
 *     listens on is unreachable from any turn, and member containers cannot
 *     reach each other. The proxy stays reachable: `host-gateway` names the
 *     host's docker0 address whichever network a container joins
 *     (src/daemon/bind-hosts.ts), and traffic to the host itself is not
 *     traffic between bridges;
 *   - exactly one credential: a placeholder bound to the member, minted for this
 *     container and revoked when it is removed (../server/member-exec-credential.ts);
 *   - NO task MCP config or token, NO protocol dir (the supervisor's command
 *     channel), NO published `[serve]` ports, and NONE of the task's `lazy env`
 *     variables: whoever can set one could make the member's shell, editor,
 *     runtime or git run something next to their credential, and no list of
 *     such variables can be trusted to be complete.
 *
 * WHAT IS SHARED is files, which is the point of pairing: the worktree, the
 * worktree's own git dir and the object store (the split git mount the turns
 * get — refs, config and hooks stay read-only). Anything a member leaves there
 * the next turn sees, exactly as if a person had edited the checkout. Of the
 * project's `[[mounts]]` (and mounts in `[docker] run_args`), a SHARED one —
 * a host path or a named volume — is mounted here only when it is read-only
 * for every task container (`readonly = true`; `:ro` in run_args): turns of
 * OTHER tasks keep running while a member works, and a mount they can write
 * would let them plant a program the member's terminal runs next to the
 * member's credential (../capture/mounts.ts, buildMemberMountArgs).
 *
 * THE HOME IS NOT SHARED. The agent's home config lives in the worktree's
 * `.lazy-task-sandbox/`, which a turn can write — a hook in its
 * `.claude/settings.json`, an MCP server in its `.claude.json`, a `core.fsmonitor`
 * in its `.gitconfig` — and anything there would run inside the member's
 * container, next to the member's credential. So the member's container gets a
 * home lazy builds for it ({@link prepareMemberHome}): lazy-written settings (no
 * hooks, no MCP servers), the UI preferences only, the git config lazy
 * generated at launch, and the one conversation transcript Pair resumes —
 * data, never configuration. Pair and Chat also start Claude Code with the
 * options that ignore the worktree's own settings and any MCP server lazy did
 * not write (src/supervisor/pair.ts, MEMBER_SESSION_CLAUDE_ARGS). What is left
 * is inherent, and documented: a member who RUNS the task's own scripts in
 * Shell runs code a turn may have written.
 *
 * Named `lazymember-…`, deliberately NOT `lazy-…`: every sweep that treats a
 * `^lazy-` container as a task supervisor (shutdown, restart reaping, upgrade)
 * must never mistake one for a turn's. Found by label instead
 * ({@link MEMBER_CONTAINER_LABEL} plus the project label).
 */

import { createHash, randomBytes } from 'crypto';
import { join, resolve } from 'path';
import { mkdir, readdir, readFile, rm, rmdir, chmod, lstat } from 'fs/promises';
import { basename, dirname } from 'path';
import { getDaemonBaseDir, projectSlug } from './paths';
import { getHome } from '../utils/home';
import { readRegularFileUnder, writeRegularFileUnder, FileTooLargeError } from './link-safe-files';
import { extractClaudePreferenceSeed } from '../task/claude-home';
import { encodeProjectPath } from '../import/claude-code-logs';
import type { Storage } from '../storage';
import type { Task, Session } from '../types';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import { loadConfig } from '../config/loader';
import type { MountConfigEntry } from '../config/types';
import { profileNameForAgent } from '../config/agent-profiles';
import { getWorktreePath } from '../task/identity';
import { pathExists } from '../utils/fs';
import { SANDBOX_DIR } from '../utils/sandbox';
import { buildMemberMountArgs, turnWritableIndex, turnWritableMountStorage, type SharedStorage } from '../capture/mounts';
import { buildGitMountArgs } from '../capture/git-mounts';
import { validateMemberGitLayout, memberGitPointerMounts, writeMemberGitPointerCopies, GitLayoutRefusedError, type MemberGitLayout } from './member-git-layout';
import { ensureImage, ensureAgentBinary, isContainerRunning } from '../capture/claude';
import { pinnedCustomImage } from '../docker/worktree-image';
import { PROJECT_LABEL } from '../runner/docker-runner';
import {
  planMemberContainerCredential,
  MEMBER_EXEC_CREDENTIAL_KEYS,
  type MemberContainerCredential,
} from '../server/member-exec-credential';

/** Label every member container carries; its value is the task id. */
export const MEMBER_CONTAINER_LABEL = 'lazy.member-terminal';

/** The Docker network every member container joins — see the header. */
export const MEMBER_NETWORK = 'lazy-members';
/** Its host-side bridge interface — named, so an operator can find it. */
export const MEMBER_BRIDGE_INTERFACE = 'lzmember0';

/**
 * The network argv, pure for tests. `enable_icc=false` drops traffic between
 * containers on it — two members' containers cannot reach each other either.
 * Docker keeps separate bridges apart on its own (its isolation chains), which
 * is what separates members from the task containers on docker0.
 */
export function memberNetworkCreateArgs(binary: string): string[] {
  return [
    binary, 'network', 'create', '--driver', 'bridge',
    '--opt', `com.docker.network.bridge.name=${MEMBER_BRIDGE_INTERFACE}`,
    '--opt', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'lazy.member-network=1',
    MEMBER_NETWORK,
  ];
}

export interface NetworkDeps {
  run?: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function runCaptured(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { exitCode: exitCode ?? 1, stdout, stderr };
}

/**
 * What a network must be to serve as {@link MEMBER_NETWORK}: exactly what
 * {@link memberNetworkCreateArgs} creates. The NAME proves nothing — anyone
 * with the runtime can create a `lazy-members` network first, with
 * inter-container traffic on, and member containers would join it.
 */
const MEMBER_NETWORK_REQUIRED: ReadonlyArray<{ what: string; read: (n: InspectedNetwork) => unknown; want: string }> = [
  { what: 'driver', read: (n) => n.Driver, want: 'bridge' },
  { what: 'option com.docker.network.bridge.enable_icc', read: (n) => n.Options?.['com.docker.network.bridge.enable_icc'], want: 'false' },
  { what: 'option com.docker.network.bridge.name', read: (n) => n.Options?.['com.docker.network.bridge.name'], want: MEMBER_BRIDGE_INTERFACE },
  { what: 'label lazy.member-network', read: (n) => n.Labels?.['lazy.member-network'], want: '1' },
];
interface InspectedNetwork {
  Driver?: string;
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
}

/** Why an existing network is not the member network lazy creates, or null. */
function memberNetworkMismatch(inspectStdout: string): string | null {
  let net: InspectedNetwork;
  try {
    net = JSON.parse(inspectStdout) as InspectedNetwork;
  } catch (err) {
    return `its description could not be read (${err instanceof Error ? err.message : String(err)})`;
  }
  const wrong = MEMBER_NETWORK_REQUIRED
    .map((r) => ({ ...r, got: r.read(net) }))
    .filter((r) => r.got !== r.want)
    .map((r) => `${r.what} is ${r.got === undefined || r.got === null ? 'not set' : JSON.stringify(r.got)}, not "${r.want}"`);
  return wrong.length > 0 ? wrong.join('; ') : null;
}

/**
 * Make sure {@link MEMBER_NETWORK} exists AS LAZY CREATES IT. Idempotent.
 * Throws, naming the runtime's own words, when it cannot be created — and,
 * naming what differs, when a network of that name exists but is not the one
 * lazy creates (wrong driver, inter-container traffic on, another bridge, not
 * labelled as lazy's). A member container never joins a network it cannot
 * vouch for, nor falls back to the default bridge it would share with the task
 * containers. Docker only: podman's networks do not isolate the same way, so
 * member terminals are refused there (see launchMemberContainer).
 */
export async function ensureMemberNetwork(binary: string, deps: NetworkDeps = {}): Promise<void> {
  const run = deps.run ?? runCaptured;
  const inspect = () => run([binary, 'network', 'inspect', '--format', '{{json .}}', MEMBER_NETWORK]);
  const verify = (stdout: string) => {
    const mismatch = memberNetworkMismatch(stdout.trim());
    if (mismatch) {
      throw new Error(
        `a network named ${MEMBER_NETWORK} already exists on this host but is not the one lazy creates for terminals (${mismatch}). ` +
        `Remove it (${binary} network rm ${MEMBER_NETWORK}) so lazy can create its own.`,
      );
    }
  };
  const existing = await inspect();
  if (existing.exitCode === 0 && existing.stdout.trim() !== '') {
    verify(existing.stdout);
    return;
  }
  const created = await run(memberNetworkCreateArgs(binary));
  if (created.exitCode === 0) return;
  if (!/already exists/i.test(created.stderr)) {
    throw new Error(`could not create the ${MEMBER_NETWORK} network: ${created.stderr.trim() || `exit ${created.exitCode}`}`);
  }
  // Created concurrently (another project's daemon on this host) — or by
  // somebody else: held to the same check as one found up front.
  const raced = await inspect();
  if (raced.exitCode !== 0) {
    throw new Error(`could not inspect the ${MEMBER_NETWORK} network: ${raced.stderr.trim() || `exit ${raced.exitCode}`}`);
  }
  verify(raced.stdout);
}

/** Name prefix of every member container — never `lazy-` (see the header). */
export const MEMBER_CONTAINER_PREFIX = 'lazymember-';

export function memberContainerName(taskId: string): string {
  return `${MEMBER_CONTAINER_PREFIX}${taskId.substring(0, 8)}-${randomBytes(6).toString('hex')}`;
}

/** A running member container, and how to get rid of it. */
export interface MemberContainer {
  name: string;
  binary: string;
  /** Remove the container (killing everything in it) and revoke its credential. */
  remove: () => Promise<void>;
}

/**
 * `docker run` flags that would let one container see or reach another's
 * processes or the host's. A member container never carries one of its own;
 * if the project's `[docker] run_args` gives one to every TURN container, a
 * turn could read the member's environment through it, so member terminals are
 * refused instead.
 */
const NAMESPACE_SHARING_FLAG = /^--(pid|ipc|privileged|volumes-from|userns|cgroupns|uts)(=|$)/;

/** A namespace flag's value that joins the host's or another container's. */
function joinsForeignNamespace(value: string): boolean {
  return value === 'host' || value.startsWith('container:');
}

/**
 * Where container runtimes keep their API sockets on this kind of host:
 * rootful Docker, Podman and containerd; Docker Desktop, Colima, OrbStack and
 * Rancher Desktop under the user's home. (Rootless runtimes live under
 * /run/user/<uid>/, which {@link exposesRuntimeSocket} refuses whole.)
 */
export function knownRuntimeSocketPaths(home: string = getHome()): string[] {
  return [
    '/var/run/docker.sock', '/run/docker.sock', '/var/run/docker', '/run/docker',
    '/var/run/podman/podman.sock', '/run/podman/podman.sock',
    '/var/run/containerd/containerd.sock', '/run/containerd/containerd.sock',
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.docker', 'desktop', 'docker.sock'),
    join(home, '.docker', 'desktop', 'docker-cli.sock'),
    join(home, '.colima', 'default', 'docker.sock'),
    join(home, '.orbstack', 'run', 'docker.sock'),
    join(home, '.rd', 'docker.sock'),
  ];
}

/** The unix socket a runtime endpoint (`unix:///path`) names, or null. */
function unixSocketOf(endpoint: string | undefined): string | null {
  const m = /^unix:\/\/(\/.+)$/.exec((endpoint ?? '').trim());
  return m ? m[1]! : null;
}

let activeSocketsCache: { at: number; binary: string; sockets: string[] } | null = null;

/**
 * The socket this daemon's runtime actually answers on: DOCKER_HOST when it
 * names a unix socket, and the current `docker context`'s endpoint. Cached
 * for a minute (the context query is a process spawn). Never throws — an
 * unanswerable question adds nothing, and the known locations still apply.
 */
/**
 * Why a member's own container cannot be started on this container runtime,
 * or null when it can. One sentence shared by the launch that enforces it and
 * the attach preflight that says it on the button before anyone clicks.
 */
export function memberRuntimeRefusal(binary: string): string | null {
  if (binary === 'docker') return null;
  return `Terminals of your own need the docker runtime; this project runs on ${binary}, whose networks cannot keep a terminal apart from the agent's.`;
}

export async function activeRuntimeSockets(binary: string): Promise<string[]> {
  if (activeSocketsCache && activeSocketsCache.binary === binary && Date.now() - activeSocketsCache.at < 60_000) {
    return activeSocketsCache.sockets;
  }
  const sockets = new Set<string>();
  const fromEnv = unixSocketOf(process.env.DOCKER_HOST);
  if (fromEnv) sockets.add(fromEnv);
  if (binary === 'docker' && Bun.which(binary)) {
    try {
      const proc = spawn([binary, 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const fromContext = code === 0 ? unixSocketOf(out) : null;
      if (fromContext) sockets.add(fromContext);
    } catch (err) {
      logger.debug(`Could not read the docker context's endpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  activeSocketsCache = { at: Date.now(), binary, sockets: [...sockets] };
  return activeSocketsCache.sockets;
}

/**
 * A mount SOURCE that hands a container the container runtime itself: a
 * runtime socket, or any directory CONTAINING one (`sockets`: the known
 * locations plus the active one). With it a turn runs `docker inspect
 * lazymember-…` or `docker exec` into it and reads the member's placeholder
 * out of the container's environment — which the address pin would not stop,
 * since the request would then come from the member's container itself. Any
 * `docker`/`podman`/`containerd` socket by name, and anything under
 * /run/user (rootless runtimes' sockets), are refused too.
 */
export function exposesRuntimeSocket(source: string, sockets: readonly string[] = knownRuntimeSocketPaths()): boolean {
  const s = resolve(source);
  if (/(^|\/)(docker|podman|containerd)(-cli)?\.sock$/.test(s)) return true;
  if (s === '/run/user' || s.startsWith('/run/user/')) return true;
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
  return sockets.some((sock) => inside(s, resolve(sock)));
}

/** Every mount SOURCE named in run_args (`-v`, `--volume`, `--mount`). */
function runArgMountSources(runArgs: string[]): string[] {
  const sources: string[] = [];
  const value = (i: number, flag: string) => {
    const arg = runArgs[i]!;
    if (arg === flag) return runArgs[i + 1] ?? '';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    return null;
  };
  for (let i = 0; i < runArgs.length; i++) {
    const arg = runArgs[i]!;
    const bind = value(i, '-v') ?? value(i, '--volume') ?? (arg.startsWith('-v') && arg.length > 2 && !arg.startsWith('-v=') ? arg.slice(2) : null);
    if (bind !== null) {
      sources.push(bind.split(':')[0] ?? '');
      continue;
    }
    const mount = value(i, '--mount');
    if (mount !== null) {
      const src = /(?:^|,)(?:source|src)=([^,]+)/.exec(mount)?.[1];
      if (src) sources.push(src);
    }
  }
  return sources;
}

/** Environment keys lazy sets for a member's container and nothing else may. */
export const MEMBER_RESERVED_ENV_KEYS: readonly string[] = [...MEMBER_EXEC_CREDENTIAL_KEYS, 'ANTHROPIC_BASE_URL'];

/**
 * Why the project's container settings rule out a member terminal, or null:
 * anything that would let a TURN's container reach into the member's — a
 * namespace shared with the host or another container (`--pid`, `--ipc`,
 * `--uts`, `--cgroupns`, `--userns`, `--network host` /
 * `container:`, `--privileged`, `--volumes-from`), or the container runtime's
 * own socket mounted in (`[[mounts]]` or run_args), or a `DOCKER_HOST` handed
 * to it — and anything that would set the member's credential or where it is
 * spent (one of {@link MEMBER_RESERVED_ENV_KEYS} in `-e`, or an `--env-file`
 * lazy cannot read), or a short-flag cluster publishing every port (`-dP`).
 * Network, name-resolution and port flags are not refused: they are stripped
 * from the member's argv ({@link memberRunArgs}).
 */
export function memberContainerSettingsRefusal(
  runArgs: string[],
  mounts: ReadonlyArray<Partial<MountConfigEntry>> = [],
  /** Runtime sockets to refuse any mount of (see {@link exposesRuntimeSocket}). */
  sockets: readonly string[] = knownRuntimeSocketPaths(),
): string | null {
  const offending: string[] = [];
  runArgs.forEach((arg, i) => {
    const next = runArgs[i + 1] ?? '';
    if (NAMESPACE_SHARING_FLAG.test(arg)) {
      offending.push(arg.includes('=') || arg === '--privileged' ? arg : `${arg} ${next}`);
      return;
    }
    const net = /^--net(?:work)?=(.+)$/.exec(arg)?.[1] ?? ((arg === '--network' || arg === '--net') ? next : null);
    if (net !== null && joinsForeignNamespace(net)) offending.push(arg.includes('=') ? arg : `${arg} ${next}`);
    // A cluster of short flags publishing every port (`-dP`) — see memberRunArgs.
    if (/^-[A-Za-z]*P[A-Za-z]*$/.test(arg) && arg !== '-P' && !arg.startsWith('--')) offending.push(arg);
    // An env FILE is unreadable here, so it could set anything — refused.
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      offending.push(arg.includes('=') ? arg : `${arg} ${next}`);
      return;
    }
    const env = /^(?:-e|--env)(?:=(.*)|(.+))?$/.exec(arg);
    const envValue = env ? (env[1] ?? env[2] ?? next) : null;
    const envKey = envValue?.split('=')[0] ?? '';
    if (envValue && envKey === 'DOCKER_HOST') offending.push(`-e ${envValue}`);
    // The member's credential and where it is spent are lazy's to set; the
    // project's run_args must not name them at all.
    if (envValue && MEMBER_RESERVED_ENV_KEYS.includes(envKey)) offending.push(`-e ${envKey}`);
  });
  for (const src of runArgMountSources(runArgs)) {
    if (exposesRuntimeSocket(src, sockets)) offending.push(`a mount of ${src}`);
  }
  for (const m of mounts) {
    if ((m.type ?? 'bind') === 'bind' && m.source && exposesRuntimeSocket(m.source, sockets)) {
      offending.push(`[[mounts]] source ${m.source}`);
    }
  }
  if (offending.length === 0) return null;
  return (
    `This project's container settings (${[...new Set(offending)].join(', ')}) let a task's containers reach ` +
    `into other containers, or set your terminal's own credential, so a terminal of your own cannot be kept ` +
    `apart from the agent's. Ask a project ` +
    `admin to remove that setting to use terminals here.`
  );
}

/**
 * `run_args` flags that decide which networks a container joins, what name
 * resolution it gets, and which of its ports the host publishes. A member's
 * container is on {@link MEMBER_NETWORK} and nothing else: a second
 * `--network` would ATTACH it to that network too (docker connects every one
 * named), putting it beside the task's containers again, and a published port
 * or a planted `--add-host`/`--dns` answer is a way in or a way to redirect
 * what it talks to. The value-taking ones consume their next argument when
 * not written `--flag=value`.
 */
const MEMBER_STRIPPED_VALUE_FLAGS = new Set([
  '--network', '--net', '--network-alias', '--net-alias', '--link', '--ip', '--ip6', '--link-local-ip', '--mac-address',
  '-p', '--publish', '--expose',
  '--add-host', '--dns', '--dns-search', '--dns-option', '--dns-opt',
]);
const MEMBER_STRIPPED_BOOLEAN_FLAGS = new Set(['-P', '--publish-all']);

/**
 * The project's `run_args` as they apply to a member's container: every
 * network, name-resolution and port flag removed (see above), the rest kept —
 * resource limits, mounts, and so on still apply. `dropped` lists what was
 * removed, for the log. A short-flag CLUSTER that includes `-P` (`-dP`)
 * cannot be taken apart safely and is refused by
 * {@link memberContainerSettingsRefusal} instead.
 */
export function memberRunArgs(
  runArgs: string[],
  /** Read-only mounts to leave out too: their storage is writable to turns elsewhere (see {@link runArgMounts}). */
  omitMountSpecs: ReadonlySet<string> = new Set(),
): { args: string[]; dropped: string[]; droppedMounts: string[] } {
  const args: string[] = [];
  const dropped: string[] = [];
  const droppedMounts: string[] = [];
  for (let i = 0; i < runArgs.length; i++) {
    const arg = runArgs[i]!;
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    // A read-write SHARED mount given in run_args: every turn gets run_args
    // verbatim, so it is read-write for them, and the member's container
    // leaves it out (see buildMemberMountArgs, ../capture/mounts.ts, for why).
    const mount = runArgMount(runArgs, i);
    if (mount) {
      if (mount.sharedReadWrite || omitMountSpecs.has(mount.spec)) {
        droppedMounts.push(mount.spec);
        i += mount.consumed - 1;
        continue;
      }
    }
    if (MEMBER_STRIPPED_BOOLEAN_FLAGS.has(arg)) {
      dropped.push(arg);
      continue;
    }
    if (MEMBER_STRIPPED_VALUE_FLAGS.has(flag)) {
      if (flag === arg) {
        dropped.push(`${arg} ${runArgs[i + 1] ?? ''}`.trim());
        i += 1;
      } else {
        dropped.push(arg);
      }
      continue;
    }
    // `-p8080:80`: the short publish flag with its value attached.
    if (/^-p./.test(arg)) {
      dropped.push(arg);
      continue;
    }
    args.push(arg);
  }
  return { args, dropped, droppedMounts };
}

/**
 * A `-v`/`--volume`/`--mount` at `runArgs[i]`: its spec, how many argv
 * entries it spans, and whether it is a SHARED mount (a host path or a named
 * volume) that is not read-only. Anonymous volumes and tmpfs are not shared.
 */
interface RunArgMount {
  spec: string;
  consumed: number;
  /** The shared storage it mounts, or null (anonymous volume, tmpfs). */
  storage: SharedStorage | null;
  sharedReadWrite: boolean;
}

/** Every `-v`/`--volume`/`--mount` in `run_args` that mounts shared storage. */
export function runArgMounts(runArgs: string[]): Array<{ spec: string; storage: SharedStorage; readOnly: boolean }> {
  const out: Array<{ spec: string; storage: SharedStorage; readOnly: boolean }> = [];
  for (let i = 0; i < runArgs.length; i++) {
    const m = runArgMount(runArgs, i);
    if (!m) continue;
    if (m.storage) out.push({ spec: m.spec, storage: m.storage, readOnly: !m.sharedReadWrite });
    i += m.consumed - 1;
  }
  return out;
}

function runArgMount(runArgs: string[], i: number): RunArgMount | null {
  const arg = runArgs[i]!;
  let kind: 'volume' | 'mount';
  let spec: string;
  let consumed = 1;
  if (arg === '-v' || arg === '--volume' || arg === '--mount') {
    kind = arg === '--mount' ? 'mount' : 'volume';
    spec = runArgs[i + 1] ?? '';
    consumed = 2;
  } else if (arg.startsWith('--volume=') || arg.startsWith('--mount=')) {
    kind = arg.startsWith('--mount=') ? 'mount' : 'volume';
    spec = arg.slice(arg.indexOf('=') + 1);
  } else if (/^-v./.test(arg)) {
    kind = 'volume';
    spec = arg.slice(2);
  } else {
    return null;
  }
  if (kind === 'volume') {
    const parts = spec.split(':');
    if (parts.length < 2) return { spec, consumed, storage: null, sharedReadWrite: false }; // anonymous
    const opts = (parts[2] ?? '').split(',');
    // docker: a source that is a path is a bind mount, anything else a named volume.
    const storage: SharedStorage = parts[0]!.startsWith('/') ? { kind: 'path', path: parts[0]! } : { kind: 'volume', name: parts[0]! };
    return { spec, consumed, storage, sharedReadWrite: !opts.includes('ro') && !opts.includes('readonly') };
  }
  const fields = new Map(spec.split(',').map((kv) => {
    const at = kv.indexOf('=');
    return at < 0 ? [kv.trim(), 'true'] as const : [kv.slice(0, at).trim(), kv.slice(at + 1).trim()] as const;
  }));
  const type = fields.get('type') ?? 'volume';
  const source = fields.get('source') ?? fields.get('src');
  if (type === 'tmpfs' || (type === 'volume' && !source)) return { spec, consumed, storage: null, sharedReadWrite: false };
  const ro = fields.get('readonly') ?? fields.get('ro');
  const readOnly = ro !== undefined && ro !== 'false' && ro !== '0';
  const storage: SharedStorage = type === 'bind' ? { kind: 'path', path: source ?? '' } : { kind: 'volume', name: source! };
  return { spec, consumed, storage, sharedReadWrite: !readOnly };
}

/** A home lazy built for one member container, and what to do when it ends. */
export interface MemberHome {
  /** Host directory holding `.claude/`, `.claude.json` and `.gitconfig`. */
  dir: string;
  /** Hand the member's conversation back to the agent's sandbox, then delete the home. */
  close: () => Promise<void>;
}

/** Largest transcript carried between the sandbox and a member home. */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
/** Largest sandbox .claude.json read for its UI preferences. */
const MAX_CLAUDE_CONFIG_BYTES = 1024 * 1024;

/**
 * Whether the agent's transcript for `sessionId` is too large to carry into a
 * member's home (over {@link MAX_TRANSCRIPT_BYTES}). Pair and Chat resume that
 * conversation, so they are refused; a plain Shell is not. A size check only
 * (`lstat`, never a read): a link or a missing file answers false, and the
 * home's link-safe read deals with it.
 */
export async function agentTranscriptTooLarge(worktreePath: string, sessionId: string | null | undefined): Promise<boolean> {
  if (!isSessionFileId(sessionId)) return false;
  try {
    const st = await lstat(join(worktreePath, SANDBOX_DIR, transcriptRel(worktreePath, sessionId)));
    return st.isFile() && st.size > MAX_TRANSCRIPT_BYTES;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw err;
  }
}

/** A session id lazy will name a file after — never a path. */
function isSessionFileId(id: string | null | undefined): id is string {
  return !!id && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** The transcript's path relative to a home (sandbox or member). */
function transcriptRel(worktreePath: string, sessionId: string): string {
  return join('.claude', 'projects', encodeProjectPath(worktreePath), `${sessionId}.jsonl`);
}

/**
 * The git config a member's container gets: the daemon's own (the same source
 * setupSandbox copies for turns), gc off, and the paths lazy mounts marked
 * safe. Built here, never copied from the turn-writable sandbox — a
 * `core.fsmonitor` or `core.hooksPath` a turn wrote there would run in the
 * member's container.
 */
async function memberGitconfig(safeDirectories: string[]): Promise<string> {
  let base = '[user]\n\tname = Lazy Agent\n\temail = noreply@getlazy.dev\n';
  try {
    base = await readFile(join(getHome(), '.gitconfig'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return base + '\n[gc]\n\tauto = 0\n\n[safe]\n' + safeDirectories.map((d) => `\tdirectory = ${quote(d)}\n`).join('');
}

/**
 * Where a project's member homes live: `~/.lazy/member-homes/<project slug>/`
 * (beside the daemon base dir, never inside a daemon state dir, never inside
 * the repo or a worktree). Predictable, so a daemon that restarts finds a home
 * its predecessor left and hands the conversation in it back.
 */
export function memberHomesDir(projectRoot: string): string {
  return join(dirname(getDaemonBaseDir()), 'member-homes', projectSlug(projectRoot));
}

/** Written at the top of each home (never mounted): what to hand back where. */
const HOME_META = 'lazy-member-home.json';
interface HomeMeta {
  worktreePath: string;
  agentSessionId: string | null;
  /**
   * The task sandbox's copy of that session's transcript when the home was
   * built ({@link transcriptFingerprint}; null when there was none). The
   * hand-back writes the member's copy over the sandbox's only while the
   * sandbox still holds exactly this — see {@link handBackMemberHome}.
   * Absent on a home built before it was recorded: treated as unknown.
   */
  agentTranscript?: TranscriptFingerprint | null;
  /**
   * The agent's transcript was over {@link MAX_TRANSCRIPT_BYTES} when the home
   * was built, so none was copied in (a Shell does not need one; Pair and Chat
   * are refused, see {@link agentTranscriptTooLarge}). The hand-back then
   * never writes the member's copy over the agent's.
   */
  agentTranscriptTooLarge?: boolean;
}
interface TranscriptFingerprint { size: number; sha256: string }

function transcriptFingerprint(data: Uint8Array | null): TranscriptFingerprint | null {
  if (!data) return null;
  return { size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
}

function sameFingerprint(a: TranscriptFingerprint | null, b: TranscriptFingerprint | null): boolean {
  if (!a || !b) return a === b;
  return a.size === b.size && a.sha256 === b.sha256;
}

/**
 * Build the member container's home from lazy-written config only. See the
 * header: nothing of the turn-writable sandbox home is carried over except
 * the UI preferences (an allowlist of scalar keys) and the one transcript Pair
 * resumes — both READ link-safely (./link-safe-files.ts): the sandbox is
 * turn-writable, and a symlink planted there must not make the daemon read a
 * host file into a member's home, or write one on the way back.
 *
 * Under {@link memberHomesDir}, named after the container. `close` hands the
 * conversation back ({@link handBackMemberHome}) and removes the home only
 * when nothing in it would be lost.
 */
export async function prepareMemberHome(opts: {
  projectRoot: string;
  /** The container this home is for — names the directory. */
  container: string;
  worktreePath: string;
  agentSessionId: string | null;
  /** Paths the member's git must treat as safe (the worktree and its git dirs). */
  safeDirectories: string[];
  /** Where a conversation that cannot be handed back is reported. */
  storage?: Pick<Storage, 'createSystemMessage'>;
}): Promise<MemberHome> {
  const parent = memberHomesDir(opts.projectRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = join(parent, opts.container);
  await mkdir(dir, { mode: 0o700 });
  const sessionId = isSessionFileId(opts.agentSessionId) ? opts.agentSessionId : null;
  try {
    let transcript: Buffer | null = null;
    let transcriptTooLarge = false;
    if (sessionId) {
      try {
        transcript = await readRegularFileUnder(opts.worktreePath, join(SANDBOX_DIR, transcriptRel(opts.worktreePath, sessionId)), MAX_TRANSCRIPT_BYTES);
      } catch (err) {
        // Too large to carry is not a reason to refuse a plain Shell, which
        // never reads it: the home starts without it, and says so.
        if (!(err instanceof FileTooLargeError)) throw err;
        transcriptTooLarge = true;
        logger.warn(`The agent's conversation on this task is too large to carry into a terminal environment (${err.message}); starting without it.`);
      }
    }
    const meta: HomeMeta = {
      worktreePath: opts.worktreePath,
      agentSessionId: sessionId,
      agentTranscript: transcriptFingerprint(transcript),
      ...(transcriptTooLarge ? { agentTranscriptTooLarge: true } : {}),
    };
    await writeRegularFileUnder(dir, HOME_META, JSON.stringify(meta) + '\n', 0o600);
    // Settings as lazy sets them: nothing — no hooks, no permissions granted,
    // no MCP servers, no apiKeyHelper.
    await writeRegularFileUnder(dir, join('.claude', 'settings.json'), '{}\n');
    await mkdir(join(dir, '.claude', 'projects', encodeProjectPath(opts.worktreePath)), { recursive: true, mode: 0o700 });
    // The worktree is the root every sandbox path is checked under — so the
    // sandbox directory itself cannot be a link either.
    const rawConfig = await readRegularFileUnder(opts.worktreePath, join(SANDBOX_DIR, '.claude.json'), MAX_CLAUDE_CONFIG_BYTES);
    let sandboxConfig: Record<string, unknown> = {};
    if (rawConfig) {
      try {
        const parsed = JSON.parse(rawConfig.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sandboxConfig = parsed as Record<string, unknown>;
      } catch (err) {
        logger.warn(`The task's .claude.json is not valid JSON; the terminal environment starts with default preferences: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await writeRegularFileUnder(dir, '.claude.json', JSON.stringify(extractClaudePreferenceSeed(sandboxConfig), null, 2) + '\n');
    await writeRegularFileUnder(dir, '.gitconfig', await memberGitconfig(opts.safeDirectories));
    if (sessionId && transcript) {
      await writeRegularFileUnder(dir, transcriptRel(opts.worktreePath, sessionId), transcript, 0o600);
    }
    // The container user may not be the daemon's (a root daemon on Linux);
    // the container's own command takes ownership (see the argv), but the
    // directory must be enterable first.
    await chmod(dir, 0o755);
  } catch (err) {
    // Nothing of the member's has been written yet: safe to remove.
    await rm(dir, { recursive: true, force: true });
    throw new Error(`could not build the terminal environment's home: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { dir, close: async () => { await handBackMemberHome(opts.projectRoot, dir, opts.storage); } };
}

/**
 * Where a member's transcripts that are not handed back to the task are
 * saved: `<member homes dir>/recovered/<home>/`, beside the homes and OUTSIDE
 * the repository. Never under the repo's own data dir: every task container
 * mounts the repository (read-only), so a transcript kept there could be read
 * by any task's agent — including one another member runs.
 */
export function memberRecoveredDir(projectRoot: string): string {
  return join(memberHomesDir(projectRoot), MEMBER_RECOVERED_SUBDIR);
}
const MEMBER_RECOVERED_SUBDIR = 'recovered';

/**
 * Save a member's transcript that is not handed back to the task. Returns
 * where it was written.
 */
async function recoverMemberTranscript(projectRoot: string, homeDir: string, name: string, transcript: Uint8Array): Promise<string> {
  const rel = join(MEMBER_RECOVERED_SUBDIR, basename(homeDir), name);
  await writeRegularFileUnder(memberHomesDir(projectRoot), rel, transcript, 0o600);
  return join(memberHomesDir(projectRoot), rel);
}

/**
 * Hand a member home's conversation back and delete the home — or, when any
 * of it cannot be handed back, KEEP the home and say where it is. Never loses a
 * member's conversation:
 *
 *   - the transcript of the session lazy knows (the one Pair resumed) goes back
 *     to the task's sandbox, link-safely, where the agent's next turn sees it —
 *     but only while the sandbox's copy is still the one the home started
 *     from; if it has moved on, the member's copy is recovered instead;
 *   - any other transcript in the home (a session the member started) goes to
 *     {@link memberRecoveredDir} — beside the homes, outside the repository;
 *   - if either write fails, or the home's metadata cannot be read, the home is
 *     left in place, the failure logged and a system message filed naming the
 *     path. The next daemon start tries again (removeLeftoverMemberHomes).
 *
 * Returns true when the home was removed.
 */
export async function handBackMemberHome(
  projectRoot: string,
  dir: string,
  storage?: Pick<Storage, 'createSystemMessage'>,
): Promise<boolean> {
  try {
    const rawMeta = await readRegularFileUnder(dir, HOME_META, 64 * 1024);
    if (!rawMeta) throw new Error(`${HOME_META} is missing`);
    const meta = JSON.parse(rawMeta.toString('utf-8')) as HomeMeta;
    if (typeof meta.worktreePath !== 'string') throw new Error(`${HOME_META} names no worktree`);
    const projectsRel = join('.claude', 'projects', encodeProjectPath(meta.worktreePath));
    let names: string[] = [];
    try {
      names = (await readdir(join(dir, projectsRel))).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const recovered: string[] = [];
    let diverged = false;
    for (const name of names) {
      const transcript = await readRegularFileUnder(dir, join(projectsRel, name), MAX_TRANSCRIPT_BYTES);
      if (!transcript) continue;
      if (isSessionFileId(meta.agentSessionId) && name === `${meta.agentSessionId}.jsonl`) {
        // Back over the agent's copy ONLY while the agent's copy is still the
        // one this home started from. It can have moved on: this home may be
        // one a previous daemon left, handed back at a later startup after
        // the agent has run more turns on the same session. Overwriting then
        // would drop those turns from the agent's transcript — so the member's
        // copy is kept beside it instead.
        const sandboxRel = join(SANDBOX_DIR, projectsRel, name);
        let current: TranscriptFingerprint | null | 'too large';
        try {
          current = transcriptFingerprint(await readRegularFileUnder(meta.worktreePath, sandboxRel, MAX_TRANSCRIPT_BYTES));
        } catch (err) {
          if (!(err instanceof FileTooLargeError)) throw err;
          current = 'too large';
        }
        if (
          !meta.agentTranscriptTooLarge && current !== 'too large'
          && meta.agentTranscript !== undefined && sameFingerprint(current, meta.agentTranscript)
        ) {
          await writeRegularFileUnder(meta.worktreePath, sandboxRel, transcript, 0o600);
          continue;
        }
        diverged = true;
      }
      recovered.push(await recoverMemberTranscript(projectRoot, dir, name, transcript));
    }
    if (recovered.length > 0) {
      await storage?.createSystemMessage({
        source: 'member-terminal',
        kind: 'notice',
        title: "A member's terminal conversation was saved for recovery",
        body:
          (diverged
            ? "When a member's terminal environment was closed, the agent's own copy of the conversation they had " +
              'resumed had changed since, so the member\'s copy was not written over it. '
            : "A member's terminal session started a conversation of its own, which the agent does not resume. ") +
          `It is saved, on the machine running lazy, at:\n\n${recovered.map((f) => `- ${f}`).join('\n')}\n\n` +
          'Remove it once you have what you need.',
      }).catch((msgErr: unknown) => {
        logger.error(`Could not file a system message about saved conversations (${recovered.join(', ')}): ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
      });
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    logger.error(`A member's conversation could not be handed back to the task (${why}). It is kept at ${dir}.`);
    await storage?.createSystemMessage({
      source: 'member-terminal',
      kind: 'notice',
      title: "A member's terminal conversation was kept, not handed back",
      body:
        `When a member's terminal environment closed, its conversation could not be handed back to the task: ${why}\n\n` +
        `Nothing was deleted. The conversation is in ${dir} on the machine running lazy; its transcripts are ` +
        `under .claude/projects/. Remove that directory once you have what you need.`,
    }).catch((msgErr: unknown) => {
      logger.error(`Could not file a system message about the kept conversation at ${dir}: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
    });
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  // The per-project directory goes with its last home.
  await rmdir(dirname(dir)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST' && err.code !== 'ENOENT') {
      logger.warn(`Could not remove the empty member homes directory ${dirname(dir)}: ${err.message}`);
    }
  });
  return true;
}

/**
 * Hand back and remove every member home a previous daemon left behind. Run
 * at DAEMON STARTUP after the leftover containers are removed (a container
 * mounts its home): `skip` names containers still running, whose homes are
 * left alone. A home that cannot be handed back is kept (see
 * {@link handBackMemberHome}).
 */
export async function removeLeftoverMemberHomes(
  projectRoot: string,
  skip: ReadonlySet<string>,
  storage?: Pick<Storage, 'createSystemMessage'>,
): Promise<{ removed: number; kept: number }> {
  let entries: string[];
  try {
    entries = await readdir(memberHomesDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, kept: 0 };
    throw err;
  }
  let removed = 0;
  let kept = 0;
  for (const name of entries) {
    if (!name.startsWith(MEMBER_CONTAINER_PREFIX) || skip.has(name)) continue;
    if (await handBackMemberHome(projectRoot, join(memberHomesDir(projectRoot), name), storage)) removed += 1;
    else kept += 1;
  }
  return { removed, kept };
}

export interface MemberContainerArgsParams {
  binary: string;
  name: string;
  imageName: string;
  repoRoot: string;
  taskId: string;
  worktreePath: string;
  /** The lazy-built home ({@link prepareMemberHome}) — never the task sandbox. */
  homeDir: string;
  agentBinaryPath: string;
  /** Built with `buildGitMountArgs` — the same split mount a turn gets. */
  gitMountArgs: string[];
  /** Built with `buildMemberMountArgs` from the project's `[[mounts]]`: only shared entries marked readonly. */
  customMountArgs: string[];
  /**
   * The project root's `[docker] run_args`, checked by
   * {@link memberContainerSettingsRefusal} and passed through {@link memberRunArgs}.
   */
  runArgs: string[];
  /** The member's credential environment — the ONLY credential the container gets. */
  credentialEnv: Array<{ key: string; value: string }>;
}

/**
 * The member container's argv. Pure, so the isolation it promises is
 * inspectable without Docker (test/unit/member-container.test.ts): no namespace
 * shared with anything, only {@link MEMBER_NETWORK}, no mount of the protocol
 * dir, the daemon state dir or the turn-writable sandbox home, the git pointer
 * files as read-only copies, and no environment but lazy's fixed
 * `GIT_SSH_COMMAND` and the member's credential — last, so nothing before it
 * can replace it. `runArgs` must already be {@link memberRunArgs}' output.
 */
export function buildMemberContainerDockerArgs(p: MemberContainerArgsParams): string[] {
  return [
    p.binary, 'run', '-d', '--init',
    '--name', p.name,
    '--label', `${PROJECT_LABEL}=${p.repoRoot}`,
    '--label', `${MEMBER_CONTAINER_LABEL}=${p.taskId}`,
    // A network of its own — never the task containers' default bridge.
    '--network', MEMBER_NETWORK,
    // The proxy the member's placeholder is spent through.
    '--add-host=host.docker.internal:host-gateway',
    // The same file view a turn has: repo read-only, worktree read-write on top.
    '-v', `${p.repoRoot}:${p.repoRoot}:ro`,
    '-v', `${p.worktreePath}:${p.worktreePath}`,
    ...p.gitMountArgs,
    '-w', p.worktreePath,
    // The home lazy built for this container — never the turn-writable
    // sandbox home (see the header).
    '-v', `${p.homeDir}/.claude:/home/user/.claude`,
    '-v', `${p.homeDir}/.claude.json:/home/user/.claude.json`,
    '-v', `${p.homeDir}/.gitconfig:/home/user/.gitconfig:ro`,
    '-v', `${p.agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    // NONE of the task's variables (`lazy env set`): whoever can set one
    // could otherwise make the member's shell, editor, runtime or git run
    // something next to their credential, and the set of variables that do
    // is open-ended (LD_PRELOAD, BASH_ENV, VIMINIT, LUA_INIT, OPENSSL_CONF,
    // PSQLRC, …) — no list of names can be trusted to be complete.
    //
    // This one is lazy's own, set identically in every container lazy runs
    // (turns, one-shots, the runner's): git over ssh accepts a host key it
    // has not seen before instead of stopping at an interactive prompt, which
    // a terminal relayed through a browser would hang on. Fixed text, never
    // a task's value.
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    ...p.customMountArgs,
    ...p.runArgs,
    // LAST before the image: docker takes the last -e for a key, so nothing
    // above — the task's variables, the project's run_args — can replace the
    // member's credential or where it is spent.
    ...p.credentialEnv.flatMap((v) => ['-e', `${v.key}=${v.value}`]),
    p.imageName,
    // Nothing of lazy's runs in here: the container only has to stay up while
    // the member's terminals exec into it. First it takes ownership of its
    // home when the daemon's user is not the container's (a root daemon on
    // Linux), exactly as the supervisor's wrapper does for its mounts.
    'sh', '-c', MEMBER_CONTAINER_COMMAND,
  ];
}

/** The member container's command: adopt the lazy-built home, then idle. */
export const MEMBER_CONTAINER_COMMAND =
  'for p in /home/user/.claude /home/user/.claude.json; do ' +
  '[ -w "$p" ] || sudo -n chown -R "$(id -u):$(id -g)" "$p" 2>/dev/null || true; done; exec sleep infinity';

export interface LaunchMemberContainerDeps {
  planCredential?: typeof planMemberContainerCredential;
  ensureImage?: (binary: string, opts: { agentId?: string; pinnedImage?: string }) => Promise<string>;
  ensureAgentBinary?: () => Promise<string>;
  gitPaths?: (worktreePath: string) => Promise<MemberGitLayout>;
  run?: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>;
  remove?: (binary: string, name: string) => Promise<void>;
  prepareHome?: typeof prepareMemberHome;
  ensureNetwork?: (binary: string) => Promise<void>;
  containerAddress?: (binary: string, name: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  /** Seam for tests; defaults to {@link activeRuntimeSockets}. */
  activeSockets?: (binary: string) => Promise<string[]>;
}

/**
 * Create a member's container for a task. Refuses (with the sentence the route
 * answers) rather than throws for anything the member can act on.
 */
export async function launchMemberContainer(opts: {
  projectRoot: string;
  storage: Storage;
  task: Task;
  session: Session;
  memberEmail: string;
  binary: string;
  deps?: LaunchMemberContainerDeps;
}): Promise<{ ok: true; container: MemberContainer } | { ok: false; status: number; message: string }> {
  const { projectRoot, storage, task, session, memberEmail, binary } = opts;
  const deps = opts.deps ?? {};
  const worktreePath = getWorktreePath(projectRoot, task);
  if (!(await pathExists(worktreePath))) {
    return { ok: false, status: 409, message: `This task has no worktree at ${worktreePath}. Start it, then open the terminal.` };
  }
  // The PROJECT ROOT's config, like every launch (loadConfig is root-anchored).
  const config = await loadConfig(projectRoot);
  const refusal = memberContainerSettingsRefusal(
    config.docker.run_args, config.mounts,
    [...knownRuntimeSocketPaths(), ...(await (deps.activeSockets ?? activeRuntimeSockets)(binary))],
  );
  if (refusal) return { ok: false, status: 409, message: refusal };
  // Everything turns can WRITE, so that no member mount reaches the same
  // storage read-only while turns write it through another door: read-write
  // [[mounts]] and run_args mounts, and lazy's own read-write mounts — every
  // task's worktree (all under the worktrees directory), the object store and
  // the worktrees' gitdirs (../capture/git-mounts.ts).
  const mountPaths = { worktreePath, repoRoot: projectRoot };
  const runArgShared = runArgMounts(config.docker.run_args);
  const isTurnWritable = await turnWritableIndex([
    ...turnWritableMountStorage(config.mounts, mountPaths),
    ...runArgShared.filter((m) => !m.readOnly).map((m) => m.storage),
    { kind: 'path', path: dirname(worktreePath) },
    { kind: 'path', path: join(projectRoot, '.git', 'objects') },
    { kind: 'path', path: join(projectRoot, '.git', 'worktrees') },
  ]);
  const writableElsewhere = new Set<string>();
  for (const m of runArgShared) if (m.readOnly && (await isTurnWritable(m.storage))) writableElsewhere.add(m.spec);
  const { args: runArgs, dropped: droppedRunArgs, droppedMounts: droppedRunArgMounts } = memberRunArgs(config.docker.run_args, writableElsewhere);
  if (droppedRunArgs.length > 0) {
    logger.info(
      `[${task.id.substring(0, 8)}] Not applying these [docker] run_args to ${memberEmail}'s terminal environment, ` +
      `which is on its own network only: ${droppedRunArgs.join(', ')}.`,
    );
  }
  const memberMounts = await buildMemberMountArgs(config.mounts, mountPaths, isTurnWritable);
  const omittedMounts = [...memberMounts.omitted, ...droppedRunArgMounts];
  if (omittedMounts.length > 0) {
    logger.info(
      `[${task.id.substring(0, 8)}] Not mounting these into ${memberEmail}'s terminal environment, because other tasks' agents ` +
      `can write them — through this entry or another that reaches the same storage (share one with members by making every ` +
      `way turns reach it read-only): ${omittedMounts.join(', ')}.`,
    );
  }
  const runtimeRefusal = memberRuntimeRefusal(binary);
  if (runtimeRefusal) return { ok: false, status: 409, message: runtimeRefusal };
  try {
    await (deps.ensureNetwork ?? ensureMemberNetwork)(binary);
  } catch (err) {
    return { ok: false, status: 500, message: `Could not prepare your terminal environment's network: ${err instanceof Error ? err.message : String(err)}` };
  }

  const name = memberContainerName(task.id);
  const planned = await (deps.planCredential ?? planMemberContainerCredential)({
    root: projectRoot, taskId: task.id, sessionId: session.id, memberEmail, container: name,
  });
  if (!planned.ok) return planned;
  const credential: MemberContainerCredential = planned.credential;

  const remove = deps.remove ?? removeMemberContainer;
  let home: MemberHome | null = null;
  try {
    // Checked on the host by reading files, never by running git: a turn can
    // rewrite the worktree's git pointers, and host git would follow them
    // (./member-git-layout.ts). The member then sees daemon-written COPIES of
    // the checked text, read-only — never the originals.
    const gitPaths = await (deps.gitPaths ?? ((w: string) => validateMemberGitLayout(projectRoot, w)))(worktreePath);
    // Nothing is set up in, or copied from, the sandbox's home: the member's
    // home is built fresh and only reads the sandbox link-safely.
    home = await (deps.prepareHome ?? prepareMemberHome)({
      projectRoot,
      container: name,
      worktreePath,
      agentSessionId: session.agent_session_id ?? null,
      safeDirectories: [worktreePath, gitPaths.worktreeGitDir, gitPaths.commonDir],
      storage,
    });
    const pointerCopies = await writeMemberGitPointerCopies(home.dir, gitPaths);
    const gitMountArgs = [...buildGitMountArgs(gitPaths), ...memberGitPointerMounts(pointerCopies)];
    const [imageName, agentBinaryPath] = await Promise.all([
      (deps.ensureImage ?? ensureImage)(binary, {
        agentId: profileNameForAgent(task.agent_id),
        pinnedImage: pinnedCustomImage(task),
      }),
      (deps.ensureAgentBinary ?? ensureAgentBinary)(),
    ]);
    const argv = buildMemberContainerDockerArgs({
      binary,
      name,
      imageName,
      repoRoot: projectRoot,
      taskId: task.id,
      worktreePath,
      homeDir: home.dir,
      agentBinaryPath,
      gitMountArgs,
      customMountArgs: memberMounts.args,
      runArgs,
      credentialEnv: credential.env,
    });
    const ran = await (deps.run ?? runDetached)(argv);
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.trim() || `${binary} run exited ${ran.exitCode}`);
    }
    // Pin the member's placeholder to this container's address before any
    // terminal can exec into it: a value that leaks out of the container is
    // then refused by the proxy (src/daemon/turn-credentials.ts). Linux only —
    // there the proxy sees a container's own bridge address; Docker Desktop
    // (macOS, Windows) relays container traffic through its VM, so every
    // container arrives from the same address and a pin would refuse the
    // member's own requests. The lazy-built home is the defence there.
    if ((deps.platform ?? process.platform) === 'linux') {
      const address = await (deps.containerAddress ?? memberContainerAddress)(binary, name);
      if (!address) throw new Error(`${name} has no address on the ${MEMBER_NETWORK} network, so its credential cannot be pinned to it`);
      await credential.pinOrigin(address);
    } else {
      logger.warn(
        `[${task.id.substring(0, 8)}] ${memberEmail}'s terminal credential is not pinned to its container's address: ` +
        `this platform's container runtime does not show the proxy where a request came from.`,
      );
    }
  } catch (err) {
    // Nothing of a half-made container may outlive the refusal: not the
    // container (a `run` that failed after creating it), not the credential.
    await remove(binary, name).catch((rmErr) => {
      logger.warn(`Could not remove the half-created terminal container ${name}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
    });
    await credential.release();
    await home?.close();
    // A git layout a turn changed is the member's to hear about as it is.
    if (err instanceof GitLayoutRefusedError) return { ok: false, status: 409, message: err.message };
    return {
      ok: false,
      status: 500,
      message: `Could not start your terminal environment for this task: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  logger.info(`[${task.id.substring(0, 8)}] Started ${memberEmail}'s own terminal environment (${name}).`);

  let removed = false;
  return {
    ok: true,
    container: {
      name,
      binary,
      remove: async () => {
        if (removed) return;
        try {
          await remove(binary, name);
        } finally {
          // Revoked even when the removal failed: the credential must not
          // outlive the member's session whatever became of the container.
          await credential.release();
        }
        removed = true;
        // Only once the container is gone: it mounts the home.
        await home?.close();
      },
    },
  };
}

async function runDetached(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
  // Bounded: an image is already resolved by now, so this is `docker run -d`.
  const proc = spawn(argv, { stdout: 'ignore', stderr: 'pipe', timeout: 120_000 });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode: exitCode ?? 1, stderr };
}

/** The container's address on {@link MEMBER_NETWORK}, or null. */
export async function memberContainerAddress(binary: string, name: string): Promise<string | null> {
  const proc = spawn(
    [binary, 'inspect', '--format', `{{with index .NetworkSettings.Networks "${MEMBER_NETWORK}"}}{{.IPAddress}}{{end}}`, name],
    { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

/** `rm -f` a member container. "No such container" is success. */
export async function removeMemberContainer(binary: string, name: string): Promise<void> {
  const proc = spawn([binary, 'rm', '-f', name], { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !/no such container/i.test(stderr)) {
    throw new Error(`could not remove terminal container ${name}: ${stderr.trim() || `exit ${code}`}`);
  }
}

/** Whether a member container is still up — a reused one may have died. */
export async function memberContainerRunning(binary: string, name: string): Promise<boolean> {
  return isContainerRunning(name, binary);
}

/**
 * Remove every member container this project's previous daemon left behind.
 * Run at DAEMON STARTUP, before the reconcile loop: no member terminal survives
 * a restart (its socket dies with the process), and a leftover container would
 * keep running whatever the member left in it with nobody to end it. One it
 * cannot remove is reported (with the task its label names) so the caller can
 * hold that task until it is gone.
 */
export async function removeLeftoverMemberContainers(
  projectRoot: string,
  binary: string,
  deps: { remove?: (binary: string, name: string) => Promise<void>; list?: () => Promise<string> } = {},
): Promise<{ removed: number; failed: Array<{ taskId: string; name: string; error: string }> }> {
  // No runtime installed, no containers to remove — every daemon on a host
  // without Docker starts through here.
  if (!deps.list && !Bun.which(binary)) return { removed: 0, failed: [] };
  const stdout = await (deps.list ?? (async () => {
    const proc = spawn(
      [binary, 'ps', '-a',
        '--filter', `name=^${MEMBER_CONTAINER_PREFIX}`,
        '--filter', `label=${MEMBER_CONTAINER_LABEL}`,
        '--filter', `label=${PROJECT_LABEL}=${projectRoot}`,
        '--format', `{{.Names}}\t{{.Label "${MEMBER_CONTAINER_LABEL}"}}`],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    );
    const [out, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(`could not list terminal containers: ${stderr.trim() || `exit ${code}`}`);
    return out;
  }))();
  let removed = 0;
  const failed: Array<{ taskId: string; name: string; error: string }> = [];
  for (const line of stdout.split('\n')) {
    const [name, taskId] = line.trim().split('\t');
    if (!name?.startsWith(MEMBER_CONTAINER_PREFIX)) continue;
    try {
      await (deps.remove ?? removeMemberContainer)(binary, name);
      removed += 1;
    } catch (err) {
      failed.push({ taskId: taskId ?? '', name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}
