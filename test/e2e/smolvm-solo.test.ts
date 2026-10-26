/**
 * SOLO LAZY ON SMOLVM, END TO END — on a machine that has smolvm.
 *
 * A real daemon (no module mock) on `[runner] type = "smolvm"` launches real
 * task containers on the project's real smolvm machine. The only fake is the
 * agent: the fake `claude` (test/helpers/fake-claude.ts), compiled into a Linux
 * binary and mounted over `claude` in the task image, so a turn needs no model
 * and no credential. What it proves:
 *
 *  1. a turn completes, and the agent's `lazy_status` MCP call (the server
 *     entry the supervisor wrote into the container's ~/.claude.json) succeeds
 *     over the guest-to-host route;
 *  2. with `[serve] ports`, `lazy url --direct` reaches an HTTP server the
 *     agent started in its container;
 *  3. a STOPPED machine is started again for the next task, never recreated;
 *  4. a new `[[mounts]]` folder makes the next launch refuse with the recreate
 *     commands, while stopping a running task still kills its container.
 *
 * Each test sets its own two-hour timeout, including cold image builds.
 *
 * Hardware only: the pinned smolvm (LAZY_SMOLVM_BINARY), a hypervisor, and the
 * host `docker` command-line client. Opt in on the Mac, from the lazy checkout,
 * after `bun run build` (the containers run this checkout's compiled
 * `lazy-agent`):
 *
 *   bun run build && LAZY_SMOLVM_E2E=1 LAZY_SMOLVM_BINARY="$(cd lazy-teams && bin/vendor-smolvm)" \
 *     bun test test/e2e/smolvm-solo.test.ts
 *
 * `LAZY_SMOLVM_E2E_IMAGE=<tar>` boots a daemon image tar you already have;
 * otherwise the suite builds one with lazy-teams/bin/smolvm-build-daemon-image
 * into ~/.lazy/smolvm-e2e/ once and reuses it on later runs (delete it to
 * rebuild after guest-side changes). The first run also builds the task image
 * inside the new machine (tens of minutes).
 *
 * Cleanup deletes ONLY the machine this suite's temp project created: its name
 * is derived from the temp project's path, and the delete refuses any name
 * that does not carry that temp directory's name.
 * Every failure saves evidence to ~/.lazy/smolvm-e2e/last-failure/ before
 * cleanup. LAZY_SMOLVM_E2E_KEEP=1 also retains the failed project's files and
 * machine (fixture host processes still stop).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { cleanupPinnedDaemonBaseDir, makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { HardwareImageBuild } from '../helpers/smolvm-image-build';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { readTaskStatus, tasksDirFor, storageDirFor } from '../helpers/storage';
import { evidenceFiles, finishSmolvmHardwareTest, saveSmolvmFailureEvidence } from '../helpers/smolvm-failure-evidence';
import { getLogPath } from '../../src/daemon/paths';
import {
  installFakeClaude, setClaudeScenario, sessionStartEvent, resultEvent,
  type ClaudeScenario, type McpCallRecord,
} from '../helpers/fake-claude';
import { applySmolvmRunner } from '../../src/cli/init';
import { setSectionString } from '../../src/config/toml-edit';
import { soloMachineName } from '../../src/vm/smolvm-project-machine';
import { smolvmStateRoot } from '../../src/vm/smolvm-engines';
import { verifySmolvmBinary } from '../../src/vm/smolvm-release';
import { getUserBinDir, IMAGE_TAG } from '../../src/capture/claude';
import { resolveInstalledAgentBinary } from '../../src/agent/binary-install';
import { startDockerRelay, type DialedProcess } from '../../src/vm/docker-relay';
import { SMOLVM_ENV } from '../../src/vm/smolvm-docker-machine';

const SUITE = 'test/e2e/smolvm-solo.test.ts';
const CHECKOUT = resolve(import.meta.dir, '../..');
const SERVICE_PORT = 8765;
const SERVICE_BODY = 'smolvm-solo-e2e-ok';
/** Where the task image puts Claude Code; the fake is mounted over this directory. */
const CONTAINER_AGENT_BIN = '/home/user/.local/bin';

/** What is missing for this suite to run here, or null when it can. */
async function missingPrerequisite(): Promise<string | null> {
  if (process.env.LAZY_SMOLVM_E2E !== '1') return 'LAZY_SMOLVM_E2E=1 is not set';
  const binary = process.env.LAZY_SMOLVM_BINARY?.trim();
  if (!binary) return 'LAZY_SMOLVM_BINARY (the vendored smolvm launcher: lazy-teams/bin/vendor-smolvm) is not set';
  if (!existsSync(binary)) return `LAZY_SMOLVM_BINARY=${binary} does not exist`;
  try { await verifySmolvmBinary(binary); }
  catch (err) { return `LAZY_SMOLVM_BINARY is not the pinned smolvm: ${err instanceof Error ? err.message : String(err)}`; }
  if (process.platform === 'darwin') {
    const hv = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'kern.hv_support'], { env: hardwareTestEnv(), stdout: 'pipe', stderr: 'ignore' });
    if (hv.exitCode !== 0 || hv.stdout.toString().trim() !== '1') return 'no hypervisor (sysctl kern.hv_support is not 1)';
  } else if (process.platform === 'linux') {
    if (!existsSync('/dev/kvm')) return 'no hypervisor (/dev/kvm is missing)';
  } else {
    return `no smolvm support on ${process.platform}`;
  }
  if (!Bun.which('docker')) return 'no `docker` command-line client on PATH (the smolvm runner drives the machine\'s engine with it)';
  return null;
}

// INVARIANT: a skipped hardware suite is never green-by-omission. One line names
// what is missing, like slowSuiteSkipped() and sandboxSuiteSkipped().
const missing = await missingPrerequisite();
if (missing) console.log(`skipped: ${SUITE} — ${missing}`);

const smolvm = () => process.env.LAZY_SMOLVM_BINARY!.trim();

async function run(argv: string[], opts: { allowFail?: boolean; timeoutMs?: number; stdinEof?: boolean; dockerHost?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: hardwareTestEnv(opts.dockerHost ? {
      DOCKER_HOST: opts.dockerHost, DOCKER_CONTEXT: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined,
    } : {}),
    stdin: opts.stdinEof ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe',
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  if (proc.stdin) proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${argv.join(' ')} exited ${code}:\n${stdout}${stderr}`);
  return { code, stdout, stderr };
}

/** Equivalent to `printf '' | smolvm machine exec -i ...`: output arrives after stdin EOF. */
async function afterStdinEof(machine: string) {
  return run([smolvm(), 'machine', 'exec', '-i', '--name', machine, '--',
    'sh', '-c', 'sleep 1; echo after-eof'], { allowFail: true, timeoutMs: 30_000, stdinEof: true });
}

/** The same self-check through the HOST Docker CLI and the production relay. */
async function relaySelfcheck(machine: string, args: string[]) {
  const dir = await mkdtemp('/tmp/lazy-svdiag-');
  const children: DialedProcess[] = [];
  try {
    const relay = await startDockerRelay({
      socketPath: join(dir, 'd.sock'), ensureServing: async () => {},
      dial: () => {
        const child = Bun.spawn([smolvm(), 'machine', 'exec', '-i', '--name', machine, '--', 'docker', 'system', 'dial-stdio'], {
          env: hardwareTestEnv(SMOLVM_ENV), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        }) as unknown as DialedProcess;
        children.push(child);
        return child;
      },
    });
    try {
      return await run(['docker', ...args], {
        dockerHost: `unix://${relay.socketPath}`, allowFail: true, timeoutMs: 30_000,
      });
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
      await relay.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The daemon image tar the machine boots: given, cached from an earlier run, or built once now. */
let imageBuild: HardwareImageBuild | undefined;

async function daemonImageTar(): Promise<string> {
  const given = process.env.LAZY_SMOLVM_E2E_IMAGE?.trim();
  if (given) {
    if (!existsSync(given)) throw new Error(`LAZY_SMOLVM_E2E_IMAGE=${given} does not exist`);
    return given;
  }
  const cache = join(homedir(), '.lazy', 'smolvm-e2e');
  const tar = join(cache, `lazy-daemon-${process.arch}.tar`);
  if (existsSync(tar) && existsSync(`${tar}.source-id`)) {
    const sourceId = (await readFile(`${tar}.source-id`, 'utf8')).trim();
    console.log(`${SUITE}: booting the cached daemon image ${tar} (lazy source ${sourceId}; delete it to rebuild)`);
    return tar;
  }
  await mkdir(cache, { recursive: true });
  console.log(`${SUITE}: building the daemon image into ${tar} (once; reused by later runs)`);
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  imageBuild = new HardwareImageBuild(smolvm(), tar);
  const code = await imageBuild.runManaged([join(CHECKOUT, 'lazy-teams/bin/smolvm-build-daemon-image'),
    '--smolvm', smolvm(), '--platform', platform, '--fleet-root', cache, tar]);
  if (code !== 0) throw new Error('lazy-teams/bin/smolvm-build-daemon-image failed (output above)');
  return tar;
}

/** The containers bind-mount this checkout's compiled lazy-agent; a placeholder cannot run a turn. */
async function assertAgentBinaryBuilt(): Promise<void> {
  const path = join(CHECKOUT, 'lazy-agent');
  const head = existsSync(path) ? (await readFile(path)).subarray(0, 4) : Buffer.alloc(0);
  if (!(head[0] === 0x7f && head.subarray(1).toString() === 'ELF')) {
    throw new Error(`${path} is not a compiled Linux binary. Run \`bun run build\` in ${CHECKOUT} first.`);
  }
}

/**
 * The fake `claude`, compiled for the guest's Linux. Its state directory is
 * shared into the machine and mounted into every task container at the same
 * path, so scenarios, invocations and MCP records cross in both directions.
 * Every headless invocation also starts a detached HTTP server on
 * SERVICE_PORT (a second one fails to bind and exits), standing in for the
 * service an agent would start.
 */
async function installContainerFakeClaude(): Promise<{ stateDir: string }> {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-smolvm-e2e-agent-')));
  const host = await installFakeClaude(join(stateDir, 'host'));
  const script = (await readFile(join(host.binDir, 'claude'), 'utf8')).replace(/^#!.*\n/, '');
  const anchored = script.replace("path.resolve(__dirname, '..')", JSON.stringify(stateDir));
  if (anchored === script) throw new Error('fake claude source no longer derives stateDir from __dirname; update this suite');
  const source = [
    "if (process.argv.includes('__lazy_e2e_serve')) {",
    `  require('node:http').createServer((q, r) => r.end(${JSON.stringify(SERVICE_BODY + '\n')})).listen(${SERVICE_PORT}, '0.0.0.0');`,
    '} else {',
    "  if (process.argv.includes('-p')) {",
    "    require('node:child_process').spawn(process.execPath, ['__lazy_e2e_serve'], { detached: true, stdio: 'ignore' }).unref();",
    '  }',
    anchored,
    '}',
  ].join('\n');
  const src = join(stateDir, 'fake-claude.js');
  await writeFile(src, source);
  await mkdir(join(stateDir, 'bin'), { recursive: true });
  await run(['bun', 'build', '--compile', `--target=bun-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    src, '--outfile', join(stateDir, 'bin', 'claude')]);
  // The container runs as its own uid: everything here must be writable by it.
  await chmod(stateDir, 0o777);
  return { stateDir };
}

function mcpScenario(recordFile: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent('smolvm-e2e') },
      { kind: 'mcp-call', recordFile, configFile: 'home', calls: [{ tool: 'lazy_status' }], timeoutMs: 120_000 },
      { kind: 'emit', event: resultEvent({ result: 'smolvm e2e turn done', sessionId: 'smolvm-e2e' }) },
    ],
  };
}

async function startAndWait(ctx: TestContext, goal: string): Promise<string> {
  const id = await createTask(ctx, goal, `${goal} (smolvm e2e)`);
  const started = await ctx.lazy(['start', id, '--yes']);
  if (started.exitCode !== 0) {
    throw new Error(`lazy start ${id} failed:\n${started.stdout}${started.stderr}`);
  }
  const waited = await ctx.lazy(['wait', id]);
  if (waited.exitCode !== 0) throw new Error(`lazy wait ${id} failed:\n${waited.stdout}${waited.stderr}`);
  return id;
}

async function failureEvidence(ctx: TestContext | undefined, stateDir: string | undefined, phase: string): Promise<string> {
  const destination = join(homedir(), '.lazy', 'smolvm-e2e', 'last-failure');
  let machine: string | null = null;
  let taskIds: string[] = [];
  const probes: Record<string, () => Promise<unknown>> = {
    context: async () => ({ phase, root: ctx?.root, protocolBase: ctx?.protocolBase, machine,
      store: ctx ? storageDirFor(ctx.root) : undefined, stateDir,
      keep: process.env.LAZY_SMOLVM_E2E_KEEP === '1' }),
  };
  if (imageBuild) probes.imageBuild = () => imageBuild!.capture();
  if (ctx) {
    try { machine = await projectMachine(ctx.root); }
    catch (err) { probes.machineDiscovery = async () => ({ diagnosticError: String(err) }); }
    try { taskIds = (await readdir(tasksDirFor(ctx.root))).filter(id => /^[a-f0-9-]{36}$/.test(id)); }
    catch (err) { probes.taskDiscovery = async () => ({ diagnosticError: String(err) }); }
  }
  if (ctx) {
    probes.tasks = () => evidenceFiles(tasksDirFor(ctx.root), name => name.endsWith('.json'));
    probes.protocol = () => evidenceFiles(ctx.protocolBase, name => /\.(json|log|pid|started)$/.test(name));
    probes.smolvmProtocol = () => evidenceFiles(`${ctx.protocolBase.replace(/\/+$/, '')}-smolvm`, name => /\.(json|log|pid|started)$/.test(name));
    probes.daemon = async () => (await readFile(getLogPath(ctx.root), 'utf8')).split('\n').slice(-500).join('\n');
    probes.launch = () => launchDiagnostics(ctx.root);
    for (const id of taskIds) {
      probes[`${id}-mailbox`] = async () => Object.fromEntries(await Promise.all(
        ['status.json', 'response.json', 'supervisor.log'].map(async file => {
          const path = join(ctx.protocolBase, id, file);
          try { return [file, await readFile(path, 'utf8')]; }
          catch (err) { return [file, { diagnosticError: String(err) }]; }
        }),
      ));
    }
  }
  if (stateDir) probes.agent = () => evidenceFiles(stateDir, name => /\.(json|jsonl)$/.test(name));
  if (machine) {
    // Ask independently through the host relay and directly in the guest.
    // State includes Running, ExitCode, OOMKilled, Error and FinishedAt.
    for (const id of taskIds) {
      const container = `lazy-${id.slice(0, 8)}`;
      for (const [key, args] of Object.entries({
        state: ['inspect', '--format', '{{json .State}}', container],
        logs: ['logs', '--timestamps', '--tail', '500', container],
        live: ['ps', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'],
        mcpAccess: ['exec', container, 'sh', '-c',
          'id; stat -c "%a %u:%g %n" "$LAZY_DAEMON_CONFIG"; test -r "$LAZY_DAEMON_CONFIG"'],
      })) {
        const name = machine;
        probes[`${container}-relay-${key}`] = () => relaySelfcheck(name, args);
        probes[`${container}-guest-${key}`] = () => run([smolvm(), 'machine', 'exec', '--name', name, '--', 'docker', ...args], {
          allowFail: true, timeoutMs: 30_000,
        });
      }
    }
    const name = machine;
    probes.guestRelays = () => run([smolvm(), 'machine', 'exec', '--name', name, '--', 'sh', '-c',
      'ss -ltnp; for p in /run/lazy-solo/*.log; do echo "$p"; tail -n 100 "$p"; done'], { allowFail: true, timeoutMs: 30_000 });
  }
  return saveSmolvmFailureEvidence(destination, probes);
}

/**
 * Preserve the hardware evidence BEFORE afterEach deletes this test's machine.
 * A host-verified binary and a successful exit with no stdout do not distinguish
 * a missing share, failed exec, or lost output on the machine-exec relay.
 */
async function launchDiagnostics(root: string): Promise<string> {
  const results: Record<string, unknown> = {};
  try {
    const machine = await projectMachine(root);
    if (!machine) return 'smolvm launch diagnostics: no project machine was recorded';
    const record = await machineRecord(machine);
    results.machine = record;
    results.afterStdinEof = await afterStdinEof(machine);
    const guest = async (key: string, argv: string[]) => {
      results[key] = await run([smolvm(), 'machine', 'exec', '--name', machine, '--', ...argv], {
        allowFail: true, timeoutMs: 30_000,
      });
    };
    await guest('sharedPaths', ['sh', '-c',
      'for p do stat -c "%F %a %u:%g %n" "$p"; done', 'shares', ...(record.shares as string[])]);
    const binary = await resolveInstalledAgentBinary(getUserBinDir());
    results.hostAgent = binary;
    if (binary) {
      await guest('guestAgent', ['sh', '-c',
        'stat -c "%F %s bytes %a %u:%g %n" "$1"; sha256sum "$1"', 'agent', binary]);
      const selfcheckArgs = ['run', '--rm', '--network', 'none',
        '--mount', `type=bind,source=${binary},target=/usr/local/bin/lazy-agent,readonly`,
        '--entrypoint', '/usr/local/bin/lazy-agent', `lazy-runner:${IMAGE_TAG}`, 'selfcheck'];
      await guest('mountedSelfcheck', ['docker', ...selfcheckArgs]);
      results.relaySelfcheck = await relaySelfcheck(machine, selfcheckArgs);
    }
    await guest('imageOutput', ['docker', 'run', '--rm', '--network', 'none',
      '--entrypoint', '/bin/echo', `lazy-runner:${IMAGE_TAG}`, 'smolvm-image-output-ok']);
  } catch (err) {
    // Diagnostics must preserve the original launch error, including every
    // probe collected before a broken machine prevents the remaining probes.
    results.diagnosticError = err instanceof Error ? err.message : String(err);
  }
  return `smolvm launch diagnostics (mountedSelfcheck: direct guest; relaySelfcheck: host Docker relay):\n${JSON.stringify(results, null, 2)}`;
}

async function readMcpRecord(stateDir: string, file: string): Promise<McpCallRecord> {
  return JSON.parse(await readFile(join(stateDir, file), 'utf8')) as McpCallRecord;
}

/** The machine this project got, under either spelling of the temp path (macOS /var vs /private/var). */
async function projectMachine(root: string): Promise<string | null> {
  const names = new Set([soloMachineName(root), soloMachineName(await realpath(root).catch(() => root))]);
  const recorded = await readdir(smolvmStateRoot()).catch(() => [] as string[]);
  return [...names].find((n) => recorded.includes(n)) ?? null;
}

async function machineRecord(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(smolvmStateRoot(), name, 'machine.json'), 'utf8'));
}

async function machineRow(name: string): Promise<Record<string, unknown> | null> {
  const { stdout } = await run([smolvm(), 'machine', 'ls', '--json']);
  const parsed = JSON.parse(stdout.trim() || '[]');
  const rows: unknown[] = Array.isArray(parsed) ? parsed : (parsed.machines ?? parsed.items ?? []);
  return (rows.find((r) => (r as Record<string, unknown>)?.name === name) as Record<string, unknown>) ?? null;
}

function rowRunning(row: Record<string, unknown>): boolean {
  return String(row.state ?? row.status ?? '').toLowerCase().includes('run');
}

async function stopMachine(name: string): Promise<void> {
  await run([smolvm(), 'machine', 'exec', '--name', name, '--', 'lazy-guest-init', '--stop-docker'], { allowFail: true });
  await run([smolvm(), 'machine', 'stop', '--name', name]);
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

describe.skipIf(missing !== null)('solo lazy on a smolvm machine', () => {
  let ctx: TestContext | undefined;
  let stateDir: string | undefined;
  let extraMount: string | undefined;
  let daemonBase: string | undefined;
  let unpinDaemonBase: (() => void) | undefined;
  let succeeded = false;
  let phase = 'setup';

  afterEach(async () => {
    try {
      // INVARIANT: evidence precedes teardown on EVERY failed phase, including
      // an assertion or Bun timeout, which bypasses the test callback's catch.
      await finishSmolvmHardwareTest({
        succeeded, keepOnFailure: process.env.LAZY_SMOLVM_E2E_KEEP === '1',
        capture: () => failureEvidence(ctx, stateDir, phase),
        cleanup: async keep => {
          await cleanupPinnedDaemonBaseDir(keep ? undefined : daemonBase, unpinDaemonBase, async () => {
            try {
              await imageBuild?.cleanup({ preserveFiles: keep });
            } finally {
              const root = ctx?.root;
              const protocolBase = ctx?.protocolBase;
              let machine: string | null = null;
              try {
                try {
                  machine = root ? await projectMachine(root) : null;
                } finally {
                  await ctx?.cleanup({ preserveFiles: keep });
                }
              } finally {
                if (keep) {
                  console.log(`${SUITE}: kept failed fixture: project=${root}, machine=${machine}, protocol=${protocolBase}, agent=${stateDir}, daemon=${daemonBase}`);
                } else {
                  if (root && machine) {
                    // Only ever the machine this suite's temp project created.
                    const tempName = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
                    if (!machine.startsWith('lazy-solo-') || !machine.includes(tempName)) {
                      throw new Error(`refusing to delete smolvm machine ${machine}: it does not carry this suite's temp project name (${tempName})`);
                    }
                    // A failed create leaves a state dir and no machine: nothing to delete then.
                    if (await machineRow(machine).catch(() => null)) {
                      await stopMachine(machine).catch((err) => console.log(`${SUITE}: stopping ${machine}: ${err.message}`));
                      await run([smolvm(), 'machine', 'delete', '--name', machine, '--force']);
                    }
                    await rm(join(smolvmStateRoot(), machine), { recursive: true, force: true });
                  }
                  if (protocolBase) await rm(`${protocolBase.replace(/\/+$/, '')}-smolvm`, { recursive: true, force: true });
                  if (stateDir) await rm(stateDir, { recursive: true, force: true });
                  if (extraMount) await rm(extraMount, { recursive: true, force: true });
                }
              }
            }
          });
        },
      });
    } finally {
      imageBuild = undefined;
      daemonBase = undefined; unpinDaemonBase = undefined;
      ctx = undefined; stateDir = undefined; extraMount = undefined;
      succeeded = false; phase = 'setup';
    }
  }, 300_000);

  test('a turn, a service URL, machine reuse after stop, and a refused launch after a mounts change', async () => {
    await assertAgentBinaryBuilt();
    const image = await daemonImageTar();
    ({ stateDir } = await installContainerFakeClaude());
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    ctx = await setupTestLazy({
      realRunner: true,
      inheritedEnv: hardwareTestEnv({ LAZY_DAEMON_BASE_DIR: daemonBase }),
      daemonEnv: { LAZY_SMOLVM_BINARY: smolvm(), LAZY_DAEMON_BASE_DIR: daemonBase },
    });
    const fake = { dir: stateDir, binDir: join(stateDir, 'bin'), binaryName: 'claude' };

    // --- The project on the smolvm runner, with the fake agent mounted in. ---
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf8');
    let toml = setSectionString(applySmolvmRunner(before).content, 'smolvm', 'image', image);
    expect(toml).toContain('type = "smolvm"');
    expect(toml).not.toMatch(/^\[serve\]/m);
    expect(toml).not.toMatch(/^\[\[mounts\]\]/m);
    toml += `\n[serve]\nports = [${SERVICE_PORT}]\n` +
      `\n[[mounts]]\nsource = ${JSON.stringify(stateDir)}\ntarget = ${JSON.stringify(stateDir)}\n` +
      `\n[[mounts]]\nsource = ${JSON.stringify(join(stateDir, 'bin'))}\ntarget = "${CONTAINER_AGENT_BIN}"\nreadonly = true\n`;
    await writeFile(configPath, toml);
    await ctx.restartDaemon();

    // --- 1. A turn completes, and its MCP call reaches the host daemon. ---
    phase = '1/4 first task turn';
    console.log(`${SUITE}: [1/4] first task turn (creates the machine)`);
    await setClaudeScenario(fake, mcpScenario('mcp-first.json'));
    const first = await startAndWait(ctx, 'smolvm first turn');
    expect(readTaskStatus(ctx.root, first)).toBe('blocked');
    const mcp = await readMcpRecord(stateDir, 'mcp-first.json');
    expect(mcp.tools).toContain('lazy_status');
    expect(mcp.results).toHaveLength(1);
    expect(mcp.results[0].isError).toBe(false);
    expect(mcp.results[0].text).toContain(first);

    const machine = await projectMachine(ctx.root);
    expect(machine).not.toBeNull();
    const created = await machineRecord(machine!);
    // INVARIANT: stdin EOF must not discard later guest stdout. The Docker
    // relay needs half-closes for commands such as `docker exec -i ... cat`.
    const eofProbe = await afterStdinEof(machine!);
    expect(eofProbe.code).toBe(0);
    expect(eofProbe.stdout).toContain('after-eof');
    // INVARIANT: the selfcheck and task container use the same binary share.
    // Inspect its actual guest contents too; a recorded share alone is no proof
    // that a host file arrived in the VM.
    expect(created.shares).toContain(getUserBinDir());
    const binary = await resolveInstalledAgentBinary(getUserBinDir());
    expect(binary).not.toBeNull();
    const guestBinary = await run([smolvm(), 'machine', 'exec', '--name', machine!, '--', 'test', '-f', binary!]);
    expect(guestBinary.code).toBe(0);
    const createdRow = await machineRow(machine!);

    // --- 2. `lazy url --direct` reaches the service in the container. ---
    phase = '2/4 task service';
    console.log(`${SUITE}: [2/4] lazy url --direct to the task's service`);
    const url = await ctx.lazy(['url', first, String(SERVICE_PORT), '--direct']);
    expect(url.exitCode).toBe(0);
    const direct = url.stdout.trim();
    expect(direct).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    await waitFor(`${direct} to answer`, async () => {
      const body = await fetch(direct, { signal: AbortSignal.timeout(5_000) }).then((r) => r.text()).catch(() => '');
      return body.includes(SERVICE_BODY);
    }, 60_000);

    // --- 3. A stopped machine is started again, not recreated. ---
    phase = '3/4 machine reuse';
    console.log(`${SUITE}: [3/4] stop ${machine}, then a second task`);
    await stopMachine(machine!);
    const stoppedRow = await machineRow(machine!);
    expect(stoppedRow).not.toBeNull();
    expect(rowRunning(stoppedRow!)).toBe(false);
    // No wait: a launch re-asks smolvm, so a stop made moments after the
    // previous launch is seen and the machine is started again.
    await setClaudeScenario(fake, mcpScenario('mcp-second.json'));
    const second = await startAndWait(ctx, 'smolvm after stop');
    expect(readTaskStatus(ctx.root, second)).toBe('blocked');
    expect((await readMcpRecord(stateDir, 'mcp-second.json')).results[0].isError).toBe(false);
    const after = await machineRecord(machine!);
    expect(after.createdAt).toBe(created.createdAt);
    expect(after.routes).toEqual(created.routes);
    const afterRow = await machineRow(machine!);
    expect(afterRow).not.toBeNull();
    expect(rowRunning(afterRow!)).toBe(true);
    for (const key of ['id', 'created', 'created_at', 'createdAt'] as const) {
      if (createdRow && key in createdRow) expect(afterRow![key]).toEqual(createdRow[key]);
    }

    // --- 4. A new [[mounts]] folder refuses the next launch; stop still works. ---
    phase = '4/4 changed mounts';
    console.log(`${SUITE}: [4/4] a running task, then a new [[mounts]] folder`);
    const hold = join(stateDir, 'hold');
    const holding = join(stateDir, 'holding');
    await writeFile(hold, '');
    await chmod(hold, 0o666);
    await setClaudeScenario(fake, {
      steps: [
        { kind: 'emit', event: sessionStartEvent('smolvm-e2e-hold') },
        { kind: 'write-file', path: holding, content: 'yes' },
        { kind: 'hold-while-file', path: hold, maxMs: 900_000 },
        { kind: 'emit', event: resultEvent({ result: 'held turn released', sessionId: 'smolvm-e2e-hold' }) },
      ],
    });
    const running = await createTask(ctx, 'smolvm running task', 'hold the turn open');
    expect((await ctx.lazy(['start', running, '--yes'])).exitCode).toBe(0);
    await waitFor('the held turn to be running', async () => existsSync(holding), 600_000);
    expect(readTaskStatus(ctx.root, running)).toBe('working');
    const container = `lazy-${running.slice(0, 8)}`;
    const containerUp = async () => (await run([smolvm(), 'machine', 'exec', '--name', machine!, '--',
      'docker', 'ps', '-q', '--filter', `name=^/${container}$`])).stdout.trim().length > 0;
    expect(await containerUp()).toBe(true);

    extraMount = await realpath(await mkdtemp(join(tmpdir(), 'lazy-smolvm-e2e-mount-')));
    await appendFile(configPath, `\n[[mounts]]\nsource = ${JSON.stringify(extraMount)}\ntarget = "/mnt/smolvm-e2e-extra"\n`);

    const refused = await createTask(ctx, 'smolvm refused launch', 'should never run');
    const start = await ctx.lazy(['start', refused, '--yes']);
    let said = start.stdout + start.stderr;
    if (start.exitCode === 0) {
      // The refusal may land after the CLI returned: the launch fails in the daemon.
      await waitFor('the refused launch to park', async () => readTaskStatus(ctx!.root, refused) !== 'working', 300_000);
      said += (await ctx.lazy(['show', refused, '--json'])).stdout;
    }
    expect(said).toContain(`machine delete --name ${machine} --force`);
    expect(said).toContain(extraMount);
    await ctx.lazy(['stop', refused, '--yes']);

    const stopped = await ctx.lazy(['stop', running, '--yes', '--reason', 'smolvm e2e: stop under a refused config']);
    expect(stopped.exitCode).toBe(0);
    await waitFor('the running task to stop', async () => readTaskStatus(ctx!.root, running) !== 'working', 120_000);
    await waitFor(`${container} to be gone from the machine`, async () => !(await containerUp()), 120_000);
    // The record is untouched: lazy never recreates a machine by itself.
    expect((await machineRecord(machine!)).createdAt).toBe(created.createdAt);
    await rm(hold, { force: true });
    succeeded = true;
  }, 7_200_000);
});
