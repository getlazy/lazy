/**
 * E2E: what a daemon-owned builder session leaves behind when it is released.
 *
 * Outside team mode no member credential plan is injected, so the launch mints
 * a JIT placeholder grant for the container. That placeholder is a bearer
 * credential for this project's proxy; a stopped or ended session must leave
 * none of it spendable. The release path used to revoke only the
 * `builder-<id>` label its MCP token shares, which the session's grant was
 * never minted under — so the placeholder outlived the session.
 *
 * Second half: stop/end racing a relaunch. Neither holds the start mutex, so
 * a start landing inside the graceful-stop window can relaunch the session
 * under a new builder id before stop/end writes its final row. The fake
 * docker's stop hook runs that concurrent start deterministically; the tests
 * assert stop/end is refused and the relaunched row, container and
 * placeholder grant all survive.
 *
 * Real daemon, real launch path, scripted docker (test/helpers/fake-docker.ts),
 * and the real credential-grant registry read off disk.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { getProxyTokensPath } from '../../src/daemon/paths';
import {
  IMAGE_TAG,
  calculateImageInputManifest,
  calculateImageInputsHash,
} from '../../src/capture/claude';
import { agentBinaryContentIdOfFile, versionedAgentBinaryName } from '../../src/agent/binary-install';
import type { BuilderSession } from '../../src/storage/types';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Mirror of the private `calculateSourceHash` — see builder-session-start-proof.test.ts. */
function mirrorSourceHash(sourceRoot: string): string {
  const hash = createHash('sha256');
  const packageJson = join(sourceRoot, 'package.json');
  if (existsSync(packageJson)) hash.update(readFileSync(packageJson, 'utf-8'));
  const srcDir = join(sourceRoot, 'src');
  const files = Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir, absolute: true })).sort();
  for (const file of files) hash.update(readFileSync(file, 'utf-8'));
  return hash.digest('hex');
}

/** Seed the dev-mode agent-binary stamp so no source compile runs. */
async function seedAgentBinaryStamp(agentHome: string): Promise<void> {
  const binDir = join(agentHome, '.lazy', 'bin');
  await mkdir(binDir, { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(2048, 0x2a),
    Buffer.from('lazy-agent ok'),
    Buffer.alloc(2048, 0x21),
  ]);
  const seedPath = join(binDir, 'stamp-seed-elf');
  await writeFile(seedPath, bytes);
  const installName = versionedAgentBinaryName(await agentBinaryContentIdOfFile(seedPath));
  await rename(seedPath, join(binDir, installName));
  const stamp = `${mirrorSourceHash(REPO_ROOT)}:${process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'}`;
  await writeFile(join(binDir, 'lazy-agent.hash'), `${stamp}\n${installName}\n`);
}

interface Grant { token: string; role: string; label: string }

describe('daemon-owned builder session: release leaves nothing spendable', () => {
  let ctx: TestContext;
  let target: string;
  let token: string;
  let docker: FakeDocker;
  let proofDir: string;

  async function rpc(command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function builderGrants(): Promise<Grant[]> {
    const path = getProxyTokensPath(ctx.root);
    if (!existsSync(path)) return [];
    const file = JSON.parse(await readFile(path, 'utf-8')) as { grants: Grant[] };
    return file.grants.filter(g => g.role === 'builder');
  }

  /** The placeholder the launch actually handed its container, off the docker argv. */
  async function launchedPlaceholder(): Promise<string> {
    const launches = (await docker.invocations()).filter(l => l.includes('--name lazy-builder-') && l.includes(' -d '));
    expect(launches.length).toBe(1);
    const m = launches[0]!.match(/-e (?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=(\S+)/);
    expect(m, 'launch argv carries no credential env').not.toBeNull();
    return m![1]!;
  }

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-builder-release-'));
    docker = await installFakeDocker(proofDir);
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = join(proofDir, 'builder-homes');
    ctx = await setupTestLazy({ fakeClaude: true });

    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);

    // NOT managed: the laptop path, where no member credential plan is
    // injected and the launch mints its own JIT placeholder.
    await ctx.restartDaemon({
      LAZY_BUILDER_HOMES_BASE_DIR: join(proofDir, 'builder-homes'),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    token = resolvedToken;

    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    if (!ctx.agentHome) throw new Error('fake-agent setup did not expose the daemon HOME');
    await seedAgentBinaryStamp(ctx.agentHome);
  });

  afterEach(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  // INVARIANT: once a daemon-owned builder session is stopped or ended, no
  // credential grant minted for that launch remains. The placeholder is a
  // bearer credential for the project's proxy; one that outlives its session
  // is spendable by anything that captured it, until cap eviction.
  for (const verb of ['stopBuilderSession', 'endBuilderSession'] as const) {
    test(`${verb} revokes the launch's placeholder grant`, async () => {
      const started = await rpc('startBuilderSession', {}) as BuilderSession;
      expect(started.state).toBe('running');

      const placeholder = await launchedPlaceholder();
      // The launch really minted a grant for that placeholder — otherwise the
      // absence below would prove nothing.
      expect((await builderGrants()).map(g => g.token)).toContain(placeholder);

      await rpc(verb, { id: started.id });

      expect((await builderGrants()).filter(g => g.token === placeholder)).toEqual([]);
    }, 180_000);
  }

  // INVARIANT: stop and end never overwrite a session a concurrent start has
  // relaunched. Neither holds the start mutex, and the graceful stop is a
  // ten-second window; a start that finds the container dead in it recovers
  // the row and relaunches it back to 'running' under a new launch. Writing
  // 'ended'/'stopped' with no container over that leaves a running container,
  // with a live MCP token, that no row names.
  for (const verb of ['stopBuilderSession', 'endBuilderSession'] as const) {
    test(`${verb} racing a relaunch is refused and the relaunched row keeps its container`, async () => {
      const first = await rpc('startBuilderSession', {}) as BuilderSession;
      expect(first.state).toBe('running');

      // The race, every time: inside the graceful-stop window the container
      // dies (removed outright: the fake's `ps` still lists an exited
      // container) and a real concurrent start runs to completion.
      const startScript = join(proofDir, 'start-during-stop.ts');
      const relaunched = join(proofDir, 'relaunched.json');
      await writeFile(startScript, `
import { DaemonClient } from ${JSON.stringify(join(REPO_ROOT, 'src/daemon/client.ts'))};
const row = await DaemonClient.fromTarget(${JSON.stringify(target)}, ${JSON.stringify(token)})
  .rpc('startBuilderSession', ${JSON.stringify(ctx.root)}, {});
await Bun.write(${JSON.stringify(relaunched)}, JSON.stringify(row));
`);
      const once = join(proofDir, 'start-fired');
      await docker.onStop(
        `[ -f ${JSON.stringify(once)} ] && exit 0; touch ${JSON.stringify(once)}; ` +
        `${JSON.stringify(join(docker.binDir, 'docker'))} rm -f "$1"; ` +
        `${JSON.stringify(process.execPath)} run ${JSON.stringify(startScript)}`,
      );

      let status = 200;
      try {
        await rpc(verb, { id: first.id });
      } catch (err) {
        status = (err as { status?: number }).status ?? -1;
      }

      expect(existsSync(relaunched)).toBe(true);
      const second = JSON.parse(await readFile(relaunched, 'utf-8')) as BuilderSession;
      expect(second.id).toBe(first.id);
      expect(second.state).toBe('running');
      expect(second.containerName).not.toBe(first.containerName);

      expect(status).toBe(409);
      const after = await rpc('storage', { method: 'getBuilderSession', args: { id: first.id } }) as BuilderSession;
      expect(after.state).toBe('running');
      expect(after.containerName).toBe(second.containerName);
      expect(await docker.containers()).toContain(second.containerName!);
      // `containers()` also lists exited ones — prove nothing stopped it.
      expect((await docker.invocations()).filter(l => l.startsWith('stop ') && l.includes(second.containerName!)))
        .toEqual([]);

      // The relaunch's own placeholder is still spendable: the refused
      // stop/end released only the launch it read. A per-member grant label
      // would fail here — the old launch's release would revoke the grant the
      // relaunch had just been handed.
      const launches = (await docker.invocations()).filter(l => l.includes('--name lazy-builder-') && l.includes(' -d '));
      expect(launches.length).toBe(2);
      const m = launches[1]!.match(/-e (?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=(\S+)/);
      expect(m, 'relaunch argv carries no credential env').not.toBeNull();
      expect((await builderGrants()).map(g => g.token)).toContain(m![1]!);
    }, 180_000);
  }
});
