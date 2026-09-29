/**
 * A builder container must be able to read everything its launch hands it,
 * whatever uid the daemon runs as.
 *
 * The field failure (smolvm guest, 2026-09-28): the daemon runs as root with
 * HOME=/root, so a member's launch dir is /root/.lazy/builder-homes/.../launches/<id>/.
 * The prompt file (and the scratch dir, MCP wrapper, daemon MCP config) were
 * bind-mounted at their HOST path, i.e. under /root inside the container — and
 * the runner image's /root is 0700 root. The container user (uid 1000) could
 * not traverse it, and the builder died with EACCES opening
 * builder-prompt-<id>.txt before Claude Code ever started.
 *
 * A 0755 tmpfs over /root did not fix it: runc gives a tmpfs mounted over an
 * existing dir the IMAGE dir's mode. The contract now is that a detached
 * builder's launch files are mounted at fixed container paths the image does
 * not have (BUILDER_CONTAINER_DIR), and every path handed to the builder
 * process is one of those mount destinations.
 *
 * Pure argv + filesystem tests, no Docker.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, writeFile, stat, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBuilderDockerArgs,
  builderAdoptScript,
  builderProjectsProbeArgs,
  setBuilderLaunchModes,
  BUILDER_CONTAINER_DIR,
  BUILDER_CONTAINER_PATHS,
} from '../../src/runner/docker-runner';

const IMAGE = 'lazy-agent:latest';

function argsForHome(daemonHome: string, extra: { detached?: boolean; headlessClaudeArgs?: string[] } = {}): string[] {
  const launch = `${daemonHome}/.lazy/builder-homes/repo-15f96bbe/745f176aa313e470/launches/75716854`;
  return buildBuilderDockerArgs({
    binary: 'docker',
    builderId: '75716854',
    lazyRoot: '/lazy/projects/lazy-dev-2/repo',
    dataDir: '/lazy/projects/lazy-dev-2/repo/.lazy',
    scratchDir: `${daemonHome}/.lazy/scratch/repo-15f96bbe`,
    containerConfigFile: `${launch}/builder-container-75716854.json`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    home: `${daemonHome}/.lazy/builder-homes/repo-15f96bbe/745f176aa313e470`,
    neutralCredentialStore: `${launch}/builder-credentials-75716854.json`,
    mergedConfigFile: `${launch}/builder-claude-75716854.json`,
    mcpWrapperPath: `${launch}/lazy-mcp-wrapper-75716854.sh`,
    authEnvVars: [],
    imageName: IMAGE,
    promptFile: `${launch}/builder-prompt-75716854.txt`,
    daemonConfigPath: `${daemonHome}/.lazy/daemon/daemon-mcp-builder-75716854.json`,
    claudeExtraArgs: [],
    debug: false,
    detached: true,
    ...extra,
  });
}

/** Container destinations of every bind mount. */
function mountDestinations(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-v') out.push(args[i + 1].split(':')[1]);
  }
  return out;
}

/** Directories the runner image ships closed (0700 root) to its user. */
const CLOSED_IMAGE_DIRS = ['/root'];

describe('builder launch under a root-run daemon (HOME=/root)', () => {
  // INVARIANT: a detached builder mounts nothing at or under a directory the
  // image keeps closed to its user. A root daemon's HOME is /root, the image's
  // /root is 0700, and neither an identity mount nor a tmpfs over /root can
  // make a path there reachable (runc copies the image dir's mode onto the
  // tmpfs) — the builder died with EACCES on its own prompt file.
  test('no mount destination is under /root', () => {
    const dests = mountDestinations(argsForHome('/root'));
    for (const closed of CLOSED_IMAGE_DIRS) {
      expect(dests.filter((d) => d === closed || d.startsWith(`${closed}/`))).toEqual([]);
    }
    expect(argsForHome('/root').join(' ')).not.toContain('type=tmpfs');
  });

  // INVARIANT: every path handed to the builder process (argv and env) is a
  // path that exists in the container as a mount destination — never a host
  // path the container does not have.
  test('every path passed to the builder is a mount destination under the fixed dir', () => {
    const args = argsForHome('/root');
    const dests = new Set(mountDestinations(args));
    const cmd = args.slice(args.indexOf(IMAGE) + 1);
    const handed: string[] = [];
    for (const flag of ['--system-prompt-file', '--builder-config', '--daemon-config']) {
      const i = cmd.indexOf(flag);
      expect(i).toBeGreaterThan(-1);
      handed.push(cmd[i + 1]);
    }
    const scratchEnv = args.find((a) => a.startsWith('LAZY_SCRATCH_DIR='))!;
    handed.push(scratchEnv.slice('LAZY_SCRATCH_DIR='.length));
    for (const p of handed) {
      expect(dests.has(p)).toBe(true);
      expect(p.startsWith(`${BUILDER_CONTAINER_DIR}/`)).toBe(true);
    }
    // The MCP wrapper, named as the command in the merged ~/.claude.json.
    expect(dests.has(BUILDER_CONTAINER_PATHS.mcpWrapper)).toBe(true);
    expect(dests.has(BUILDER_CONTAINER_PATHS.daemonConfig)).toBe(true);
  });

  // INVARIANT: the operator's own `lazy builder` launches keep identity
  // mounts — their scratch path is printed to and read by the human as-is.
  test('interactive launches keep host paths', () => {
    const args = argsForHome('/home/op', { detached: false });
    expect(args).toContain('LAZY_SCRATCH_DIR=/home/op/.lazy/scratch/repo-15f96bbe');
    expect(args.join(' ')).not.toContain(BUILDER_CONTAINER_DIR);
  });

  test('the fixed dir is not one the image ships closed', () => {
    for (const closed of CLOSED_IMAGE_DIRS) {
      expect(BUILDER_CONTAINER_DIR === closed || BUILDER_CONTAINER_DIR.startsWith(`${closed}/`)).toBe(false);
    }
  });

  // INVARIANT: the writable per-member mounts are adopted INSIDE the container
  // (sudo chown to the container user), never widened on the host. A root
  // daemon creates them root-owned; Claude Code must write its transcripts
  // and ~/.claude.json there.
  test('the builder runs behind an entry that adopts only the member home mounts, then execs it', () => {
    const args = argsForHome('/root');
    const cmd = args.slice(args.indexOf(IMAGE) + 1);
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(cmd[2]).toContain('"/home/user/.claude"');
    expect(cmd[2]).toContain('"/home/user/.claude.json"');
    expect(cmd[2]).not.toContain('/lazy/projects');
    expect(cmd.slice(4, 6)).toEqual(['lazy-agent', 'builder']);
    expect(cmd).toContain('--system-prompt-file');
  });

  test('the entry script execs its arguments', async () => {
    const proc = Bun.spawn(['sh', '-c', builderAdoptScript(['/nonexistent-path']), 'entry', 'echo', 'ran'], { stdout: 'pipe' });
    expect((await new Response(proc.stdout).text()).trim()).toBe('ran');
    expect(await proc.exited).toBe(0);
  });
});

describe('builder launch file modes', () => {
  let dir: string | null = null;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

  // INVARIANT: files a container reads through a bind mount are readable by a
  // user other than the daemon's (0644 / 0755), never writable by one; the
  // launch dir holding tokens stays owner-only.
  test('files are readable by others even when written under umask 077', async () => {
    dir = await mkdtemp(join(tmpdir(), 'builder-launch-'));
    const launch = join(dir, 'launches', 'abc');
    const old = process.umask(0o077);
    let prompt: string, wrapper: string;
    try {
      await mkdir(launch, { recursive: true });
      prompt = join(launch, 'builder-prompt-abc.txt');
      wrapper = join(launch, 'lazy-mcp-wrapper-abc.sh');
      await writeFile(prompt, 'p');
      await writeFile(wrapper, '#!/bin/sh\n');
    } finally {
      process.umask(old);
    }
    expect((await stat(prompt)).mode & 0o777).toBe(0o600); // the bug's precondition
    await setBuilderLaunchModes(launch, { files: [prompt], executables: [wrapper] });
    expect((await stat(prompt)).mode & 0o777).toBe(0o644);
    expect((await stat(wrapper)).mode & 0o777).toBe(0o755);
    expect((await stat(launch)).mode & 0o777).toBe(0o700);
  });
});

describe('adoption never touches the operator\'s own ~/.claude', () => {
  // INVARIANT: only a DETACHED launch (whose home is lazy's per-member home)
  // runs the sudo-chown entry. The interactive and headless launches mount the
  // operator's real ~/.claude; adopting it would re-own their host config.
  test('interactive and headless launches have no adopt entry', () => {
    for (const extra of [{ detached: false }, { detached: false, headlessClaudeArgs: ['claude', '-p', 'x'] }]) {
      const args = argsForHome('/home/op', extra);
      const cmd = args.slice(args.indexOf(IMAGE) + 1);
      expect(cmd[0]).not.toBe('sh');
      expect(args.join(' ')).not.toContain('chown');
    }
  });

  test('the detached projects probe adopts first; the interactive one does not', () => {
    const adopt = builderProjectsProbeArgs({ binary: 'docker', hostDir: '/h/p', imageName: IMAGE, adopt: true });
    const cmd = adopt.slice(adopt.indexOf(IMAGE) + 1);
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(cmd[2]).toContain('"/home/user/.claude/projects"');
    expect(cmd.slice(4, 6)).toEqual(['sh', '-c']);
    expect(cmd[6]).toContain('touch /home/user/.claude/projects/.lazy-write-probe');
    const plain = builderProjectsProbeArgs({ binary: 'docker', hostDir: '/h/p', imageName: IMAGE, adopt: false });
    expect(plain.join(' ')).not.toContain('chown');
  });
});
