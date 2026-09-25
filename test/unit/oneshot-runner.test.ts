/**
 * Unit tests: machine one-shots always use the container runner.
 *
 * INVARIANT: createOneshotRunner never returns HostProcessRunner, even when
 * lazy.toml (or the test harness) selects the internal host-process runner for
 * supervised turns. A one-shot that fell back to a host spawn would defeat the
 * isolation and audit guarantees refactor-oneshot-runner added.
 *
 * Deliberately avoids setupTestLazy — that helper imports the daemon barrel,
 * which pulls in the web server (and its mermaid asset import) even though these
 * tests never start a daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir, makeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { createOneshotRunner } from '../../src/oneshot/container-runner';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import {
  lookupCredentialGrant,
  clearCredentialGrantCache,
  revokeTaskCredentialGrants,
} from '../../src/proxy/credential-broker';
import { findLazyRoot } from '../../src/project-paths';
import type { RoleTarget } from '../../src/config/types';

enableInProcessTestMode();

const HOST_PROCESS_RUNNER = 'dangerously-host-process-without-any-isolation';

async function writeMinimalLazyToml(root: string, runnerType: string): Promise<void> {
  await writeFile(
    join(root, 'lazy.toml'),
    [
      '[project]',
      'name = "oneshot-runner-test"',
      '',
      '[runner]',
      `type = "${runnerType}"`,
      '',
      '[agent]',
      'agent_id = "claude-code"',
      '',
      '[docker]',
      'dockerfile = "Dockerfile.lazy"',
    ].join('\n'),
  );
}

describe('createOneshotRunner', () => {
  let root: string;
  let priorAllow: string | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    priorAllow = process.env.LAZY_ALLOW_HOST_RUNNER;
    process.env.LAZY_ALLOW_HOST_RUNNER = '1';

    root = await mkdtemp(join(tmpdir(), 'lazy-oneshot-runner-'));
    await writeMinimalLazyToml(root, HOST_PROCESS_RUNNER);
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    if (priorAllow === undefined) delete process.env.LAZY_ALLOW_HOST_RUNNER;
    else process.env.LAZY_ALLOW_HOST_RUNNER = priorAllow;
    undoConfig?.();
    await rm(root, { recursive: true, force: true });
  });

  test('returns a container runner even when lazy.toml selects host-process', async () => {
    const runner = await createOneshotRunner(root);
    expect(runner.type).toBe('docker');
  });

  test('HostProcessRunner.runOneshot refuses — no silent host fallback', async () => {
    const { HostProcessRunner } = await import('../../src/runner/host-process-runner');
    const runner = new HostProcessRunner(root);
    await expect(runner.runOneshot({ prompt: 'x', effort: 'low' })).rejects.toThrow(/Docker/i);
  });
});

describe('one-shot container isolation argv', () => {
  const common = {
    binary: 'docker',
    containerName: 'lazy-oneshot-test-1',
    lazyRoot: '/projects/demo',
    agentStateHome: '/home-store/demo/.claude',
    imageName: 'lazy-runner:test',
    authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://host.docker.internal:9999' }],
    harness: 'claude-code',
    prompt: 'summarize',
    model: 'some-model',
  };

  test('repoAccess none mounts no repository at all', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const args = buildOneshotDockerArgs({ ...common, repoAccess: 'none' });
    const mounts = args.filter((a, i) => args[i - 1] === '-v');
    expect(mounts.some(m => m.includes(common.lazyRoot))).toBe(false);
    expect(args).not.toContain('-w');
  });

  test('repoAccess read-only mounts the project read-only and never writable', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const args = buildOneshotDockerArgs({ ...common, repoAccess: 'read-only' });
    expect(args).toContain(`${common.lazyRoot}:${common.lazyRoot}:ro`);
    expect(args.join(' ')).not.toContain(`${common.lazyRoot}:${common.lazyRoot}:rw`);
    expect(args[args.indexOf('-w') + 1]).toBe(common.lazyRoot);
  });

  test('the Claude home is the lazy-owned one, and the credential env is passed through', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const args = buildOneshotDockerArgs({ ...common, repoAccess: 'none' });
    expect(args).toContain(`${common.agentStateHome}:/home/user/.claude`);
    expect(args).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:9999');
    expect(args).toContain('--rm');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    expect(args).toContain('lazy.oneshot=1');
  });

  test('cursor agent mounts lazy-owned .cursor state instead of .claude', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const args = buildOneshotDockerArgs({
      ...common,
      harness: 'cursor',
      agentStateHome: '/home-store/demo/.cursor',
      repoAccess: 'none',
    });
    expect(args).toContain('/home-store/demo/.cursor:/home/user/.cursor');
    expect(args.join(' ')).not.toContain('/home/user/.claude');
  });
});

/**
 * The credential a one-shot container is launched with.
 *
 * A one-shot used to be the ONE launch path that put the human's real API
 * credential straight into `docker run` argv: it resolved auth with no
 * LaunchIdentity, and `resolveAuthEnvFromDaemon` reads the absence of an
 * identity as "this launch is not proxied — hand back the real key". Two
 * consequences, both live for the length of the run: anything that could call
 * `ps` or `docker inspect` could read the key, and the container held a
 * credential usable against the upstream API directly — so the wire allowlist
 * bounded only what it chose to send through the proxy.
 *
 * Its traffic did reach the proxy (`createOneshotRunner` stamps the proxy URL),
 * but with no grant to present: attribution fell back to the self-reported
 * `x-lazy-*` headers, and `routeForProfile` — consulted only for a verified
 * caller — never ran, so a one-shot took the proxy's primary upstream and the
 * primary allowlist tier instead of its own profile's.
 *
 * These tests drive the REAL launch seam (`getLaunchAuthEnvVars`) with the REAL
 * identity the production call site builds (`oneshotLaunchIdentity`) and feed
 * the result into the REAL argv builder, so what they assert about the argv is
 * what `docker run` receives.
 */
describe('one-shot credential posture', () => {
  const REAL_TOKEN = 'sk-ant-oat01-THE-REAL-ONE';
  const PROXY_PORT = 45997;

  const common = {
    binary: 'docker',
    containerName: 'lazy-oneshot-test-1',
    lazyRoot: '/projects/demo',
    agentStateHome: '/home-store/demo/.claude',
    imageName: 'lazy-runner:test',
    harness: 'claude-code',
    prompt: 'summarize',
    model: 'some-model',
    repoAccess: 'none' as const,
  };

  // The launch seam mints against the root it discovers for ITSELF (cwd-walking,
  // as every in-daemon launch does), so the grant lands under this repo's slug.
  // `pinDaemonBaseDir` keeps the registry file in a temp dir all the same.
  const mintRoot = findLazyRoot()!;
  // A USER-DEFINED profile name, not `claude-code`: a hard-coded built-in would
  // be indistinguishable from a correctly resolved one in the assertions below.
  // This stands in for what `builderTarget()` resolves to — a one-shot composes
  // its whole launch from the BUILDER role's target (see the target-selection
  // describe below for what picks it).
  const builderTarget: RoleTarget = {
    profile: 'oneshot-anthropic',
    harness: 'claude-code',
    model: '',
    endpoint: '',
    pinned: false,
    wire: 'anthropic',
    credential: 'anthropic',
    proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
  };

  let baseDir: string;
  let unpin: () => void;
  let savedOauth: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
    savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = REAL_TOKEN;
    // A bound proxy is what makes the swap possible: without one there is
    // nowhere to redeem a placeholder.
    setDaemonContext({ webPort: 0, token: 't', proxyPort: PROXY_PORT });
  });

  afterEach(async () => {
    clearDaemonContext();
    unpin();
    clearCredentialGrantCache();
    if (savedOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    await rm(baseDir, { recursive: true, force: true });
  });

  async function oneshotAuthEnv(taskId?: string | null) {
    const { oneshotLaunchIdentity } = await import('../../src/runner/docker-runner');
    const { getLaunchAuthEnvVars } = await import('../../src/capture/claude');
    return getLaunchAuthEnvVars(
      oneshotLaunchIdentity(common.lazyRoot, builderTarget.profile, taskId),
      builderTarget,
      // BUILDER role, carrying the task id: billed to the builder credential,
      // attributed to the task the one-shot is about.
      { role: 'builder', taskId: taskId ?? undefined },
      'container',
    );
  }

  // INVARIANT (per-user billing): a team-mode one-shot run for a member — the
  // linked-task description — must present THAT member's session placeholder,
  // so the proxy bills their credential, never the builder's. Two halves: the
  // production call site hands `req.ownerCredentialEnv` to the launch seam as
  // its injected creds, and the seam, given them, puts the member's placeholder
  // in the argv unswapped. Drop either half and the run silently bills the
  // builder account again.
  test('runOneshot passes the owner credential env into the launch seam', async () => {
    const src = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'runner', 'docker-runner.ts'),
      'utf-8',
    );
    const start = src.indexOf('async runOneshot(');
    const end = src.indexOf('\n  async ', start + 1);
    const body = src.slice(start, end);
    const open = body.indexOf('getLaunchAuthEnvVars(');
    expect(open).toBeGreaterThan(-1);

    // Balance parens rather than reading one line: the call spans several, and
    // its arguments carry comments and nested calls of their own.
    let depth = 0;
    let close = -1;
    for (let i = open + 'getLaunchAuthEnvVars'.length; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')' && --depth === 0) { close = i; break; }
    }
    expect(close).toBeGreaterThan(open);
    const args = body
      .slice(open + 'getLaunchAuthEnvVars('.length, close)
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, '').trim())
      .join(' ')
      .split(',')
      .map(a => a.trim())
      .filter(Boolean);
    expect(args[args.length - 1]).toBe('req.ownerCredentialEnv');
  });

  test("a member's session placeholder is what the one-shot argv carries", async () => {
    const { oneshotLaunchIdentity, buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const { getLaunchAuthEnvVars } = await import('../../src/capture/claude');
    const { SESSION_TOKEN_PREFIX } = await import('../../src/daemon/session-credentials');
    const memberPlaceholder = `${SESSION_TOKEN_PREFIX}member-alice-link-describe`;

    const authEnvVars = await getLaunchAuthEnvVars(
      oneshotLaunchIdentity(common.lazyRoot, builderTarget.profile, 'task-77'),
      builderTarget,
      { role: 'builder', taskId: 'task-77' },
      'container',
      [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: memberPlaceholder }],
    );
    const args = buildOneshotDockerArgs({ ...common, authEnvVars });

    expect(args).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${memberPlaceholder}`);
    expect(args.join(' ')).not.toContain(REAL_TOKEN);
  });

  // INVARIANT: no real credential value ever reaches a one-shot's argv. This is
  // the whole point of the fix — assert on the argv itself, because that is the
  // string `ps` and `docker inspect` show.
  test('the argv carries a placeholder, never the real credential', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const authEnvVars = await oneshotAuthEnv('task-77');
    const args = buildOneshotDockerArgs({ ...common, authEnvVars });

    expect(args.join(' ')).not.toContain(REAL_TOKEN);

    const token = authEnvVars.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(token).toBeDefined();
    expect(token!.value).not.toBe(REAL_TOKEN);
    // The env var the credential occupies is unchanged — the client picks its
    // auth header from WHICH variable is set — and the placeholder really is
    // what the container gets.
    expect(args).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${token!.value}`);

    // ...and the traffic is pointed at the proxy that can redeem it.
    const baseUrl = authEnvVars.find(v => v.key === 'ANTHROPIC_BASE_URL');
    expect(baseUrl?.value).toContain(String(PROXY_PORT));
  });

  // The placeholder is only useful if the proxy can resolve it back to the
  // launch that got it: that grant is both the authentication and the
  // attribution. The ROLE is what the audit trail records and what the proxy
  // routes on, and it must match the target the argv was composed from — an
  // `agent`-role grant would redeem this placeholder against the TASK agent's
  // upstream while the endpoint and credential in the argv came from the
  // builder's.
  test('the placeholder redeems to a builder grant naming the task', async () => {
    const authEnvVars = await oneshotAuthEnv('task-77');
    const token = authEnvVars.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')!;

    // Both halves are the assertion. The role says which target paid; the task
    // id is what the proxy attributes usage by (it reads the grant, not the
    // request header), so an accept-time fidelity summary still bills the task
    // it summarizes even though it runs on the builder's credential.
    const grant = await lookupCredentialGrant(mintRoot, token.value);
    expect(grant?.role).toBe('builder');
    expect(grant?.taskId).toBe('task-77');
  });

  // INVARIANT: the grant names the profile whose target the launch env was built
  // FROM. The proxy resolves a verified caller's upstream — and therefore the
  // credential that upstream is paid with — from the grant's profile, while the
  // endpoint, wire and credential slot in the argv came from `builderTarget()`.
  // Any other profile here redeems the placeholder against a different upstream
  // than the one this launch was composed and preflighted for.
  test('the grant names the profile the one-shot runs, and routes there', async () => {
    const { routeForProfile } = await import('../../src/proxy/agent-upstreams');
    const authEnvVars = await oneshotAuthEnv('task-77');
    const token = authEnvVars.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')!;

    const grant = await lookupCredentialGrant(mintRoot, token.value);
    expect(grant?.profile).toBe('oneshot-anthropic');

    // What naming it BUYS, through the proxy's own routing function: this
    // profile's configured upstream rather than the primary one.
    const upstreams = {
      'oneshot-anthropic': { upstream: 'https://anthropic.example', wire: 'anthropic' as const },
    };
    expect(routeForProfile(upstreams, grant!)).toEqual({
      upstream: 'https://anthropic.example',
      wire: 'anthropic',
    });
    // And what a profile-less grant costs — the pre-fix one-shot had no grant at
    // all, and a grant minted before profiles existed still has no profile:
    // nothing to route by, so the primary upstream.
    expect(routeForProfile(upstreams, { profile: undefined })).toBeUndefined();
  });

  // INVARIANT: a one-shot's grant is NEVER the task agent's grant, and never
  // another task's. Both halves are load-bearing and both are easy to lose:
  //
  //  - `identityKey` keys an agent grant on `taskId ?? label` but a builder
  //    grant on the LABEL ALONE — the task id is ignored. So the per-task label
  //    (`oneshot:<root>:<taskId>`) is the only thing separating one task's
  //    one-shot from the next one's; a single stable `oneshot:<root>` label
  //    would hand every later task the FIRST task's grant, and the proxy — which
  //    reads the task id off the grant rather than the request header — would
  //    bill all of them to that first task.
  //  - Sharing the TASK's own grant would be worse still: same placeholder,
  //    agent role, so the run would redeem against the task agent's upstream
  //    while its argv was composed and preflighted for the builder's.
  test('a task one-shot gets its own grant, per task and distinct from the agent', async () => {
    const { getLaunchAuthEnvVars } = await import('../../src/capture/claude');

    const forTask77 = await oneshotAuthEnv('task-77');
    const forTask77Again = await oneshotAuthEnv('task-77');
    const forTask88 = await oneshotAuthEnv('task-88');
    const taskOwnAgentLaunch = await getLaunchAuthEnvVars(
      // What the task's OWN supervisor launch mints: agent role, same task, the
      // task's own label and profile (src/capture/claude.ts).
      { role: 'agent', taskId: 'task-77', label: 'lazy-task-77', profile: builderTarget.profile },
      builderTarget,
      { role: 'agent', taskId: 'task-77' },
      'container',
    );

    const tokenOf = (vars: Array<{ key: string; value: string }>) =>
      vars.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')!.value;

    // Repeat one-shots on one task reuse one grant — no pile of live
    // placeholders for a task that gets summarized on every accept.
    expect(tokenOf(forTask77Again)).toBe(tokenOf(forTask77));
    // ...but a different task, and the task's own agent launch, do not.
    expect(tokenOf(forTask88)).not.toBe(tokenOf(forTask77));
    expect(tokenOf(taskOwnAgentLaunch)).not.toBe(tokenOf(forTask77));

    // Attribution really is per task, which is the point of the split label.
    expect((await lookupCredentialGrant(mintRoot, tokenOf(forTask88)))?.taskId).toBe('task-88');

    // And a one-shot grant is revoked with the task despite being builder-role:
    // `revokeTaskCredentialGrants` filters on task id regardless of role, which
    // is what stops these outliving the task as live placeholders. Task 88's is
    // untouched — revocation is per task, not a sweep.
    await revokeTaskCredentialGrants(mintRoot, 'task-77');
    clearCredentialGrantCache();
    expect(await lookupCredentialGrant(mintRoot, tokenOf(forTask77))).toBeNull();
    expect(await lookupCredentialGrant(mintRoot, tokenOf(taskOwnAgentLaunch))).toBeNull();
    expect(await lookupCredentialGrant(mintRoot, tokenOf(forTask88))).not.toBeNull();
  });

  // A one-shot without a task (memory compaction, a conversation ask) is still
  // attributable, and a STABLE label means repeated one-shots reuse one grant.
  // A per-run label (the container name, say) would leave one live placeholder
  // behind for every `lazy report`, with no lifecycle event to revoke it on —
  // and unlike the task-scoped form there is no revocation to clean up after.
  test('a taskless one-shot is attributed to the project and reuses one grant', async () => {
    const first = await oneshotAuthEnv();
    const second = await oneshotAuthEnv();
    const a = first.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')!;
    const b = second.find(v => v.key === 'CLAUDE_CODE_OAUTH_TOKEN')!;

    expect(a.value).toBe(b.value);
    const grant = await lookupCredentialGrant(mintRoot, a.value);
    expect(grant?.role).toBe('builder');
    expect(grant?.taskId).toBeNull();
    expect(grant?.label).toBe(`oneshot:${common.lazyRoot}`);
  });

  // A self-credentialed role (local ollama, the documented escape hatch from the
  // credential gate) is placeholderized over the synthetic stand-in rather than
  // the user's token — the grant is what lets the proxy authenticate the caller
  // and route it to that role's upstream, so skipping the swap would cost the
  // routing, not just the secrecy. It must also never consult the real
  // credential, which such a project legitimately does not have.
  test('a self-credentialed one-shot gets a placeholder over the local stand-in', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { oneshotLaunchIdentity, buildOneshotDockerArgs } =
      await import('../../src/runner/docker-runner');
    const { getLaunchAuthEnvVars } = await import('../../src/capture/claude');

    const localTarget: RoleTarget = {
      ...builderTarget,
      profile: 'oneshot-local',
      model: 'qwen3',
      endpoint: 'http://localhost:11434',
      pinned: true,
      credential: 'none',
    };
    const authEnvVars = await getLaunchAuthEnvVars(
      oneshotLaunchIdentity(common.lazyRoot, localTarget.profile, 'task-88'),
      localTarget,
      { role: 'builder', taskId: 'task-88' },
      'container',
    );

    const token = authEnvVars.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN');
    expect(token).toBeDefined();
    // A placeholder, not the literal stand-in — the proxy needs something to
    // look up, and the container must not be able to spend it elsewhere.
    expect(token!.value).not.toBe('ollama');
    const args = buildOneshotDockerArgs({ ...common, authEnvVars });
    expect(args).not.toContain('ANTHROPIC_AUTH_TOKEN=ollama');

    const grant = await lookupCredentialGrant(mintRoot, token!.value);
    expect(grant?.role).toBe('builder');
    expect(grant?.taskId).toBe('task-88');
    // ...and it still names the profile, which is how the proxy knows to send
    // this one to the local server rather than to Anthropic.
    expect(grant?.profile).toBe('oneshot-local');
  });

  // INVARIANT: the one-shot launch resolves its credential through the LAUNCH
  // seam, never through `resolveAuthEnvFromDaemon`. The tests above prove the
  // seam is correct; this one proves `runOneshot` still uses it.
  //
  // The distinction is not stylistic. A one-shot only ever reaches a Runner
  // where the daemon RPC is bypassed — inside the daemon itself, or under the
  // test harness (src/oneshot/index.ts) — so `resolveAuthEnvFromDaemon` falls
  // through to its daemon-self branch and returns the REAL credential no matter
  // what identity it is handed. Passing an identity to it would look like a fix
  // and change nothing.
  test('runOneshot resolves credentials through the launch seam', async () => {
    const src = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'runner', 'docker-runner.ts'),
      'utf-8',
    );
    const start = src.indexOf('async runOneshot(');
    expect(start).toBeGreaterThan(-1);
    // The method ends at the next method declaration at class-body indent.
    const end = src.indexOf('\n  async ', start + 1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    // A scan that matched nothing would prove nothing: anchor on argv assembly.
    expect(body).toContain('buildOneshotDockerArgs(');
    expect(body).toContain('getLaunchAuthEnvVars(');
    expect(body).not.toContain('resolveAuthEnvFromDaemon(');

    // The profile is READ OFF the same resolved target the env is built from —
    // never a literal, and never a second target lookup that a later edit could
    // point somewhere else. `test/unit/builder-launch-profile-coverage.ts`
    // scans every launch site for the general form; this pins THIS one.
    expect(body).toContain('oneshotLaunchIdentity(lazyRoot, target.profile, req.taskId)');

    // INVARIANT (oneshot-runs-on-builder): the one target the whole launch is
    // composed from is the BUILDER role's. A one-shot strips
    // `--resume`/`--continue` (src/oneshot/args.ts), so a task's model buys it
    // no session and no prompt cache — and a task's model id need not even be
    // valid on the builder profile's harness or upstream. Engineer decision
    // 2026-09-06: a one-shot is a fresh-context call lazy makes on the human's
    // behalf, so it runs the human's builder target, not the task's agent.
    expect(body).toContain('const target = this.builderTarget();');
    expect(body).not.toContain('this.agentTarget()');
    expect(body).toContain("preflightRoleTarget('builder', target)");
  });

  // INVARIANT (oneshot-runs-on-builder), the other half: a one-shot never reads
  // the TASK RECORD. `resolveTaskOneshotModel` used to look a task's persisted
  // model up so a summary would run on it; it is deleted, and this scan is what
  // stops it being reintroduced under another name. `req.taskId` is still passed
  // in — but only as ATTRIBUTION for the grant, never as a lookup key.
  test('runOneshot never resolves a model from the task record', async () => {
    const src = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'runner', 'docker-runner.ts'),
      'utf-8',
    );
    const start = src.indexOf('async runOneshot(');
    const end = src.indexOf('\n  async ', start + 1);
    const body = src.slice(start, end);

    // Anchor: the task id IS present, so a scan that found nothing would prove
    // nothing about whether it is being used as a lookup key.
    expect(body).toContain('req.taskId');
    for (const forbidden of ['getTask', 'resolveTaskOneshotModel', 'getStorage', 'resolveStorage']) {
      expect(body).not.toContain(forbidden);
    }

    // The model is the request's or the builder target's, else a harness default
    // or [models] default when the builder profile names none — never the task's.
    expect(body).toContain('{ harness, model: target.model }, req.model');

    // ...and the deleted helper is gone from the tree, not merely unused here.
    const launchIdentity = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'daemon', 'launch-identity.ts'),
      'utf-8',
    );
    expect(launchIdentity).not.toContain('resolveTaskOneshotModel');
  });
});

/**
 * Which ROLE a one-shot is composed from, driven by a real config.
 *
 * The source scan above pins `runOneshot` to `this.builderTarget()`; this block
 * asks the other question — what the composition root actually puts THERE. The
 * config gives the two roles deliberately different profiles, harnesses,
 * endpoints and models, so every assertion below fails if the agent role leaks
 * back in. With both roles on the same profile (the default single-IC setup)
 * none of this would be observable.
 */
describe('one-shot target selection', () => {
  let root: string;
  let undoConfig: (() => void) | undefined;

  const TASK_PROFILE = [
    '[agents.taskbot]',
    'harness = "claude-code"',
    'model = "task-model-x"',
    'endpoint = "https://task.example"',
  ];
  const BUILDER_PROFILE = [
    '[agents.deskbot]',
    'harness = "claude-code"',
    'model = "builder-model-y"',
    'endpoint = "https://builder.example"',
  ];

  async function writeRoles(agentProfile: string, builderProfile: string, extra: string[] = []) {
    await writeFile(
      join(root, 'lazy.toml'),
      [
        '[project]', 'name = "oneshot-roles-test"', '',
        '[runner]', 'type = "docker"', '',
        '[docker]', 'dockerfile = "Dockerfile.lazy"', '',
        ...TASK_PROFILE, '',
        ...BUILDER_PROFILE, '',
        ...extra, extra.length ? '' : '',
        '[models.roles.agent]', `agent = "${agentProfile}"`, '',
        '[models.roles.builder]', `agent = "${builderProfile}"`,
      ].join('\n'),
    );
  }

  // `agentTarget`/`builderTarget` are `protected` — a compile-time visibility
  // marker, not a runtime one — and the seam this block exists to check. Read
  // them directly rather than inferring the answer from something downstream.
  type RoleSeams = {
    agentTarget(): RoleTarget;
    builderTarget(): RoleTarget;
    _agent?: { id: string };
    _agentProfile?: string;
  };
  const seams = (runner: unknown) => runner as unknown as RoleSeams;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-oneshot-roles-'));
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    undoConfig?.();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT (oneshot-runs-on-builder): endpoint, model, wire and credential
  // all come from `[models.roles.builder]`. Sending the task's model id to the
  // builder's upstream is not a smaller bug than sending it nowhere — the two
  // profiles need not share a single valid model name.
  test('the one-shot target is the builder role, not the agent role', async () => {
    await writeRoles('taskbot', 'deskbot');
    const runner = seams(await createOneshotRunner(root));

    expect(runner.builderTarget().profile).toBe('deskbot');
    expect(runner.builderTarget().model).toBe('builder-model-y');
    expect(runner.builderTarget().endpoint).toBe('https://builder.example');

    // The agent role is still resolved and still different — proof the test
    // config really does distinguish them, so the assertions above mean
    // something.
    expect(runner.agentTarget().profile).toBe('taskbot');
    expect(runner.agentTarget().model).toBe('task-model-x');
  });

  // The HARNESS and the profile name handed to `setAgent` decide which binary
  // the argv invokes and which image is built for it. Taking them from the
  // agent role while the endpoint and credential came from the builder's would
  // launch one profile's binary against another's upstream.
  test('the harness and profile the runner is told to run are the builder role\'s', async () => {
    await writeRoles('taskbot', 'deskbot');
    const runner = seams(await createOneshotRunner(root));

    expect(runner._agentProfile).toBe('deskbot');
    expect(runner._agent?.id).toBe('claude-code');
    // ...and it agrees with the target the launch is composed from, which is
    // what `runOneshot` relies on when it reads `target.profile` for the grant
    // and for `ensureImage`.
    expect(runner._agentProfile).toBe(runner.builderTarget().profile);
  });

  // The same question asked where it is observable WITHOUT reaching past
  // `protected`: a harness that cannot run containerised one-shots is refused,
  // and it is the BUILDER role's harness that decides. `qa-agent` is the
  // internal test harness and the only registered one that answers
  // `supportsContainerRunner()` with false.
  test('a non-container harness is refused via the builder role, and ignored on the agent role', async () => {
    const qa = ['[agents.qabot]', 'harness = "qa-agent"'];

    await writeRoles('taskbot', 'qabot', qa);
    await expect(createOneshotRunner(root)).rejects.toThrow(/models\.roles\.builder/);

    // Swap the roles: the same unusable harness on the AGENT role is none of a
    // one-shot's business, so the runner builds.
    await writeRoles('qabot', 'deskbot', qa);
    const runner = seams(await createOneshotRunner(root));
    expect(runner.builderTarget().profile).toBe('deskbot');
  });
});
