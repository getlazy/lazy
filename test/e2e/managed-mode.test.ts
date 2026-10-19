/**
 * Managed mode, end to end through the real CLI.
 *
 * test/unit/managed-config-policy.test.ts covers the classification and the
 * loader in-process. This suite covers the part a unit test cannot: that a real
 * `lazy` invocation, run under exactly the environment the fleet supervisor
 * sets (lazy-teams/app/clients/local_supervisor.rb `daemon_env`), honours the
 * fleet's store and keeps a hostile config's refused settings UNUSED without
 * refusing to run — a repository's refused settings are kept unused and
 * reported (`lazy init`, `lazy doctor`), never a start refusal (engineer,
 * 2026-10-08).
 *
 * The `managed config refused:` marker that `ProvisioningDiagnosis` matches is
 * now reachable only through the loader's backstop; these tests assert it does
 * NOT appear for a hostile repository config.
 *
 * INVARIANT, and the reason for the last block: with managed mode OFF, every
 * one of these commands must behave exactly as it always has. Managed mode is a
 * strict no-op for a normal single-user install.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';

const ENTRY_PATH = join(__dirname, '../../src/index.ts');

/** The environment LocalSupervisor#daemon_env composes for a fleet project. */
function fleetEnv(store: string): Record<string, string> {
  return { LAZY_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: store };
}

async function runLazy(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // LAZY_TEST=1 keeps the CLI from auto-starting a daemon: this suite is
    // daemonless by design, and a live daemon would hold `.storage-lock` on the
    // external store for the next invocation. Mirrors test/e2e/init-storage.
    env: { ...process.env, LAZY_TEST: '1', ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
}

/** A lazy.toml a hostile (or merely careless) repository might commit. */
const HOSTILE_CONFIG = [
  '[runner]',
  'type = "docker"',
  '',
  '[[mounts]]',
  'type = "bind"',
  'source = "/usr"',
  'target = "/host"',
  '',
].join('\n');

describe('managed mode (fleet host)', () => {
  let root: string;
  let repo: string;
  let fleetStore: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-managed-e2e-'));
    repo = join(root, 'repo');
    fleetStore = join(root, 'fleet-store');
    await mkdir(repo, { recursive: true });
    await mkdir(fleetStore, { recursive: true });
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** `lazy init` exactly as LocalSupervisor#initialize_lazy runs it. */
  async function fleetInit(store = fleetStore) {
    return runLazy(
      repo,
      ['init', '--non-interactive', '--skip-auth-check', '--external-path', store],
      fleetEnv(store),
    );
  }

  test('a fleet-provisioned project initializes and runs', async () => {
    const init = await fleetInit();
    expect(init.exitCode).toBe(0);

    const list = await runLazy(repo, ['list'], fleetEnv(fleetStore));
    expect(list.exitCode).toBe(0);
  });

  // The whole point of the storage override: a repository that names its own
  // store must not be able to point a fleet daemon at it. Before managed mode
  // this was a one-time substring check at provisioning; now it is applied on
  // every config load, which is what this asserts by running a SECOND command
  // after init.
  test("a repository's own external_path does not decide where work lands", async () => {
    const foreign = join(root, 'somebody-elses-store');
    await mkdir(foreign, { recursive: true });
    await writeFile(
      join(repo, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${foreign}"\n`,
    );

    const init = await fleetInit();
    expect(init.exitCode).toBe(0);

    const create = await runLazy(repo, ['create', '--goal', 'a fleet task'], fleetEnv(fleetStore));
    expect(create.exitCode).toBe(0);

    // The task landed in the fleet's store, and the foreign path was never
    // touched — not created, not written to.
    const inFleet = await runLazy(repo, ['list'], fleetEnv(fleetStore));
    expect(inFleet.stdout).toContain('a fleet task');
    expect(await Bun.file(join(foreign, 'tasks')).exists()).toBe(false);
  });

  // INVARIANT: a repository's refused settings are kept unused and reported,
  // never a start refusal (engineer, 2026-10-08: "Importing must never refuse
  // anything"). A project whose lazy.toml carries a mount still provisions —
  // so the control plane's verbatim import can happen — and `lazy doctor`
  // names the mount as kept but not used.
  test('a hostile lazy.toml still provisions, and doctor names what is not used', async () => {
    await writeFile(join(repo, 'lazy.toml'), HOSTILE_CONFIG);

    const init = await fleetInit();
    expect(init.exitCode).toBe(0);
    expect(init.stdout + init.stderr).not.toContain('managed config refused:');

    const doctor = await runLazy(repo, ['doctor', '--no-resume'], fleetEnv(fleetStore));
    const said = doctor.stdout + doctor.stderr;
    expect(said).toContain("lazy.toml 'mounts'");
    expect(said).toContain('kept in lazy.toml but not used');
  });

  test('a refused setting pushed after provisioning never stops later commands', async () => {
    const init = await fleetInit();
    expect(init.exitCode).toBe(0);

    // Committed AFTER provisioning — the repo can push this at any time.
    await writeFile(join(repo, 'lazy.toml'), HOSTILE_CONFIG);

    const list = await runLazy(repo, ['list'], fleetEnv(fleetStore));
    expect(list.exitCode).toBe(0);
    expect(list.stdout + list.stderr).not.toContain('managed config refused:');
  });

  // Fail closed: armed with no store, the daemon must stop rather than fall
  // back to whatever the repository's config says.
  // INVARIANT: import once. After the control plane has written its own copy
  // of the config (LAZY_MANAGED_CONFIG_PATH, outside the clone), the
  // repository's lazy.toml is never read again — a later push of a hostile file
  // to the repo changes nothing, and the clone stays clean.
  test("once the control plane's config exists, the repository lazy.toml is ignored", async () => {
    const init = await fleetInit();
    expect(init.exitCode).toBe(0);
    const controlPlaneConfig = join(root, 'fleet-config', 'lazy.toml');
    await mkdir(join(root, 'fleet-config'), { recursive: true });
    await writeFile(controlPlaneConfig, '[permissions]\nprotected = ["AGENTS.md"]\n');
    const env = { ...fleetEnv(fleetStore), LAZY_MANAGED_CONFIG_PATH: controlPlaneConfig };

    await writeFile(join(repo, 'lazy.toml'), HOSTILE_CONFIG);
    const list = await runLazy(repo, ['list'], env);
    expect(list.stderr).not.toContain('managed config refused:');
    expect(list.exitCode).toBe(0);

    // Without the control plane's file the same repository still runs: its
    // refused settings are withheld, never a refusal.
    const withheld = await runLazy(repo, ['list'], fleetEnv(fleetStore));
    expect(withheld.exitCode).toBe(0);
  });

  test('managed mode with no storage path refuses to run at all', async () => {
    expect((await fleetInit()).exitCode).toBe(0);

    // Armed, but the fleet forgot to say which store. Falling back to the
    // repository's answer is exactly what managed mode exists to prevent, so
    // the only safe move is to stop.
    const result = await runLazy(repo, ['list'], { LAZY_MANAGED: '1' });

    expect(result.exitCode).not.toBe(0);
    expect((result.stdout + result.stderr).toLowerCase()).toContain('lazy_managed_storage_path');
  });

  // INVARIANT: unmanaged lazy is UNCHANGED. If this test ever needs "fixing",
  // the change that broke it has altered every local single-user install.
  describe('managed mode off', () => {
    test('the same hostile config is honoured verbatim', async () => {
      const ownStore = join(root, 'my-own-store');
      await mkdir(ownStore, { recursive: true });
      const init = await runLazy(repo, [
        'init', '--non-interactive', '--skip-auth-check', '--external-path', ownStore,
      ]);
      expect(init.exitCode).toBe(0);

      await writeFile(join(repo, 'lazy.toml'), HOSTILE_CONFIG + `\n[storage]\nbackend = "external"\nexternal_path = "${ownStore}"\n`);

      // No refusal, no override, no mention of managed mode anywhere.
      const list = await runLazy(repo, ['list']);
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).not.toContain('managed config refused');
      expect((list.stdout + list.stderr).toLowerCase()).not.toContain('managed mode');
    });

    test('doctor says nothing about managed mode', async () => {
      const ownStore = join(root, 'my-own-store');
      await mkdir(ownStore, { recursive: true });
      await runLazy(repo, [
        'init', '--non-interactive', '--skip-auth-check', '--external-path', ownStore,
      ]);

      const doctor = await runLazy(repo, ['doctor']);
      expect((doctor.stdout + doctor.stderr).toLowerCase()).not.toContain('managed mode');
    });

    // INVARIANT: a single-user install is told its committed plugins are not
    // run, by name — repository code never runs in lazy's own process on the
    // host in any mode (engineer, 2026-10-10).
    test('doctor names ignored repository plugins', async () => {
      const ownStore = join(root, 'my-own-store');
      await mkdir(ownStore, { recursive: true });
      await runLazy(repo, [
        'init', '--non-interactive', '--skip-auth-check', '--external-path', ownStore,
      ]);
      await mkdir(join(repo, '.lazy', 'plugins'), { recursive: true });
      await writeFile(join(repo, '.lazy', 'plugins', 'redact.ts'), 'export default {};\n');

      const doctor = await runLazy(repo, ['doctor']);
      const output = doctor.stdout + doctor.stderr;
      expect(output).toContain('Repository plugins (.lazy/plugins) are not run');
      expect(output).toContain('redact.ts');
    });

    // INVARIANT: an unreadable .lazy/plugins (here a regular FILE) is reported,
    // never allowed to break doctor — repository content cannot take it down.
    test('a file at .lazy/plugins does not break doctor', async () => {
      const ownStore = join(root, 'my-own-store');
      await mkdir(ownStore, { recursive: true });
      await runLazy(repo, [
        'init', '--non-interactive', '--skip-auth-check', '--external-path', ownStore,
      ]);
      await mkdir(join(repo, '.lazy'), { recursive: true });
      await writeFile(join(repo, '.lazy', 'plugins'), 'not a directory\n');

      const doctor = await runLazy(repo, ['doctor']);
      expect(doctor.stdout + doctor.stderr).toContain('Repository plugins: could not read');
    });
  });

  // LOUD, NOT SILENT: the single surface that explains an ignored key.
  test('doctor explains every overridden and refused key', async () => {
    await writeFile(
      join(repo, 'lazy.toml'),
      `[runner]\ntype = "dangerously-host-process-without-any-isolation"\n\n[server]\nport = 9999\n`,
    );
    await fleetInit();

    await mkdir(join(repo, '.lazy', 'plugins'), { recursive: true });
    await writeFile(join(repo, '.lazy', 'plugins', 'x.ts'), 'export default {};\n');
    const doctor = await runLazy(repo, ['doctor'], fleetEnv(fleetStore));
    const output = doctor.stdout + doctor.stderr;

    expect(output).toContain('Managed mode');
    // Quotes the ask back and names the effective value, per key.
    expect(output).toContain('runner.type');
    expect(output).toContain('server.port');
    expect(output).toContain('docker');
    // INVARIANT: the owner learns here that repository plugins do not run on a
    // managed host — the daemon never imports them (managed-repo-code.ts).
    expect(output).toContain('Repository plugins (.lazy/plugins) are not run');
  });
});
