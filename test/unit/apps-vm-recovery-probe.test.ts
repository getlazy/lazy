import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const scripts = join(root, 'scripts/smolvm-probes');
const dirs: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'apps-recovery-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function run(argv: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync(argv, { cwd: root, env: { ...process.env, ...env } });
}
function artifact(manifest: object) {
  const json = Buffer.from(JSON.stringify(manifest));
  const footer = Buffer.alloc(64);
  footer.write('SMOLPACK');
  footer.writeUInt32LE(1, 8);
  footer.writeBigUInt64LE(BigInt(json.length), 44);
  // This footer is enough for our preflight parser. smolvm, not this test,
  // validates CRC and CPU/device payloads; these are never bootable artifacts.
  return Buffer.concat([json, footer]);
}
async function bundle() {
  const dir = await temporary();
  await writeFile(join(dir, 'cold.smolmachine'), artifact({ network: false }));
  await writeFile(join(dir, 'live.checkpoint'), artifact({ network: false, checkpoint: {
    version: 4, network: { enabled: false, ports: [] }, host_mounts: [],
  } }));
  await writeFile(join(dir, 'apps-recovery.sh'), 'fixture\n');
  await writeFile(join(dir, 'capture-inputs.json'), JSON.stringify({
    fixture_image_archive_sha256: '1'.repeat(64), smolvm_binary_sha256: '2'.repeat(64), cold_exact_jobs: 9,
  }));
  const result = inventory('write', dir);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  await writeFile(join(dir, 'inventory.json'), result.stdout);
  return dir;
}
function inventory(action: string, dir: string, arch = 'arm64') {
  return run(['perl', join(scripts, 'recovery-inventory.pl'), action, dir, '1.29.0', arch, '3']);
}

describe('recovery inventory and pre-execution gate', () => {
  test('independent inventory retains image/runtime/config and separate cold acknowledgement', async () => {
    const dir = await bundle();
    const doc = JSON.parse(await readFile(join(dir, 'inventory.json'), 'utf8'));
    expect(doc.capture_inputs.fixture_image_archive_sha256).toBe('1'.repeat(64));
    expect(doc.capture_inputs.smolvm_binary_sha256).toBe('2'.repeat(64));
    expect(doc.artifact_manifests['live.checkpoint'].checkpoint.network.enabled).toBe(false);
    expect(inventory('verify-cold', dir).stdout.toString()).toBe('9\n');
    expect(inventory('verify', dir).stdout.toString()).toBe('3\n');
  });
  // INVARIANT: recovery starts only from complete, hash-checked, pre-fenced
  // artifacts. A checksum-only gate could faithfully resume a networked worker.
  test('accepts a complete inventory, rejects corrupt/missing/symlinked files', async () => {
    const dir = await bundle();
    expect(inventory('verify', dir).stdout.toString()).toBe('3\n');
    await writeFile(join(dir, 'apps-recovery.sh'), 'changed');
    expect(inventory('verify', dir).exitCode).not.toBe(0);
    await rm(join(dir, 'apps-recovery.sh'));
    expect(inventory('verify', dir).exitCode).not.toBe(0);
    await writeFile(join(dir, 'elsewhere'), 'fixture\n');
    await symlink(join(dir, 'elsewhere'), join(dir, 'apps-recovery.sh'));
    expect(inventory('verify', dir).exitCode).not.toBe(0);
  });

  test('refuses incompatible inventory without treating it as runtime evidence', async () => {
    const dir = await bundle();
    expect(inventory('verify', dir, 'x86_64').exitCode).not.toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'inventory.json'), 'utf8'));
    doc.smolvm = 'future';
    await writeFile(join(dir, 'inventory.json'), JSON.stringify(doc));
    expect(inventory('verify', dir).exitCode).not.toBe(0);
  });

  test('refuses correctly hashed network-enabled and externally dependent checkpoints', async () => {
    const dir = await bundle();
    for (const change of [
      { network: { enabled: true, ports: [] } },
      { network: { enabled: false, backend: 'tsi', ports: [] } },
      { network: { enabled: false, ports: [{ host: 9000, guest: 80 }] } },
      { host_mounts: [{ host_path: '/real/data' }] },
      { packed_layers: { artifact_sha256: 'cached-only' } },
      { cache_disk: { base_sha256: 'uncaptured' } },
      { unknown_dependency: { path: 'outside' } },
      { base: { artifact_sha256: 'uncaptured' } },
      { host_image: { reference: 'registry-only' } },
      { version: 99 },
    ]) {
      await writeFile(join(dir, 'live.checkpoint'), artifact({ network: false, checkpoint: {
        version: 4, network: { enabled: false, ports: [] }, host_mounts: [], ...change,
      } }));
      expect(inventory('write', dir).exitCode).not.toBe(0);
    }
  });

  test('cold-only bundle remains usable when live export was refused', async () => {
    const dir = await bundle();
    await rm(join(dir, 'live.checkpoint'));
    const result = inventory('write', dir);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    await writeFile(join(dir, 'inventory.json'), result.stdout);
    expect(inventory('verify-cold', dir).stdout.toString()).toBe('9\n');
    await rm(join(dir, 'cold.smolmachine'));
    expect(inventory('verify', dir).exitCode).not.toBe(0);
    expect(inventory('write', dir).exitCode).not.toBe(0);
  });

});

describe('host orchestration guards', () => {
  // INVARIANT: cold startup verifies persisted data before relaunching a writer.
  // Otherwise new transactions could hide an incomplete recovery point.
  test('same-machine restart stops before worker relaunch when data verification fails', async () => {
    const dir = await temporary();
    const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
now_ms() { echo 0; }
sm() { echo "$*" >>"$CALLS"; }
capture() { return 0; }
vm_exec() { echo "$2" >>"$CALLS"; return 1; }
apps_restart_source owned-vm 9`], { SCRIPTS: scripts, SMOLVM: 'unused-fake', CALLS: join(dir, 'calls') });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(dir, 'calls'), 'utf8')).toBe(
      'machine start --name owned-vm --branchable\nsh /apps-fixture.sh verify 9 exact\n',
    );
  });

  test('measurement waits for completion and preserves command failure', async () => {
    const dir = await temporary();
    const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time()*1000'; }
metric() { echo "$*" >>"$RESULTS_DIR/metrics"; }
capture() { shift; "$@"; }
apps_measure sample sh -c 'echo deliberately-failed; exit 7'`], {
      SCRIPTS: scripts, TMP_DIR: dir, RESULTS_DIR: dir,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString()).toContain('deliberately-failed');
    expect(await readFile(join(dir, 'metrics'), 'utf8')).toContain('sample_elapsed_ms');
  });

  test('dry-run is available without a binary and never manufactures results', () => {
    const r = run(['bash', join(scripts, 'apps-recovery-cycle.sh'), '--dry-run']);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain('[DRY-RUN] S25');
    expect(out).toContain('[DRY-RUN] S26');
    expect(out).toContain('[DRY-RUN] S23');
    expect(out).toContain('PASS IFF: cold pack');
    expect(out).not.toMatch(/\[PASS\] S2[56]/);
    expect(out).toContain('Nothing was executed. Nothing here is a result.');
  });

  // INVARIANT: only names reserved by this invocation enter cleanup. A failed
  // listing or existing name must never grant ownership of a VM.
  test('registration refuses existing names and listing failure', async () => {
    const dir = await temporary();
    const shell = `source "$SCRIPTS/apps-recovery.sh"
say() { :; }
sm() { if [ "$MODE" = error ]; then return 1; fi; echo existing-vm; }
apps_register "$NAME"`;
    for (const [mode, name] of [['ok', 'existing-vm'], ['error', 'fresh-vm']]) {
      const result = run(['bash', '-uc', shell], { SCRIPTS: scripts, MODE: mode, NAME: name, STATE_VMS: join(dir, 'owned') });
      expect(result.exitCode).not.toBe(0);
      expect(await Bun.file(join(dir, 'owned')).exists()).toBe(false);
    }
    const result = run(['bash', '-uc', shell], { SCRIPTS: scripts, MODE: 'ok', NAME: 'new-vm', STATE_VMS: join(dir, 'owned') });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(dir, 'owned'), 'utf8')).toBe('new-vm\n');
  });

  test('recovery invokes no start after create refuses', async () => {
    const dir = await temporary();
    const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
apps_register() { return 0; }
now_ms() { echo 0; }
sm() { echo "$*" >>"$CALLS"; return 1; }
apps_restore live "$BUNDLE" 3 fresh-vm`], { SCRIPTS: scripts, CALLS: join(dir, 'calls'), BUNDLE: dir });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(dir, 'calls'), 'utf8')).toBe(`machine create --name fresh-vm --from ${dir}/live.checkpoint\n`);
  });
});

test('cold verifier rejects both lost and extra transactions; live uses a minimum', async () => {
  const dir = await temporary();
  // Use the real verifier; a small sqlite stand-in supplies its read-only queries.
  const sqlite = join(dir, 'sqlite3');
  await writeFile(sqlite, `#!/bin/sh
case "$4" in
  *integrity_check*) echo ok;;
  *total=*) echo 1;;
  *count*) echo 9;;
esac
`, { mode: 0o755 });
  await writeFile(join(dir, 'release'), 'apps-recovery-v1\n');
  await writeFile(join(dir, 'app.sqlite'), 'stand-in database\n');
  await writeFile(join(dir, 'upload'), 'data');
  const hash = run(['sh', '-c', 'cd "$FIXTURE" && sha256sum upload'], { FIXTURE: dir });
  await writeFile(join(dir, 'uploads.sha256'), hash.stdout);
  const verify = (count: string, mode: string) => run(['sh', join(scripts, 'guest/apps-recovery.sh'), 'verify-data', count, mode], {
    PATH: `${dir}:${process.env.PATH}`, APPS_FIXTURE_ROOT: dir, APPS_FIXTURE_DATA: dir,
  });
  expect(verify('9', 'exact').exitCode).toBe(0);
  expect(verify('8', 'exact').exitCode).not.toBe(0);
  expect(verify('10', 'exact').exitCode).not.toBe(0);
  expect(verify('8', 'minimum').exitCode).toBe(0);
});

// INVARIANT: a pack-backed source must prove restored data before any writer
// starts. Re-seeding it would conceal the recovery failure observed on macOS.
test('pack startup verifies the restored seed and diagnoses failure without re-seeding', async () => {
  for (const mode of ['intact', 'missing']) {
    const dir = await temporary();
    const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
apps_vm_disk_path() { echo unused; }; apps_register() { :; }
sm() { echo "$*" >>"$CALLS"; }
capture() { :; }; say() { echo "$*"; }
vm_exec() {
  echo "$2" >>"$CALLS"
  case "$2" in *verify-data*) [ "$MODE" = intact ];; *) return 0;; esac
}
apps_create owned-pack
rc=$?
echo "rc=$rc seed_failed=$APPS_SEED_FAILED"`], {
      SCRIPTS: scripts, TMP_DIR: dir, APPS_PACK: '/retained/source.smolmachine',
      SMOLVM: 'pinned', GUEST_DIR: join(scripts, 'guest'), CALLS: join(dir, 'calls'), MODE: mode,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const calls = await readFile(join(dir, 'calls'), 'utf8');
    expect(calls).toContain('sh /apps-fixture.sh verify-data 0 exact');
    expect(calls).not.toContain('/apps-fixture.sh seed');
    expect(calls).not.toContain('/apps-fixture.sh worker');
    expect(calls.includes('/apps-fixture.sh diagnose')).toBe(mode === 'missing');
    expect(result.stdout.toString()).toContain(mode === 'intact' ? 'rc=0 seed_failed=0' : 'rc=1 seed_failed=1');
  }
});

test('missing database fails verification before sqlite can create an empty replacement', async () => {
  const dir = await temporary();
  await writeFile(join(dir, 'release'), 'apps-recovery-v1\n');
  await writeFile(join(dir, 'sqlite3'), '#!/bin/sh\necho invoked >"$SQLITE_MARKER"\n', { mode: 0o755 });
  const result = run(['sh', join(scripts, 'guest/apps-recovery.sh'), 'verify-data', '0', 'exact'], {
    PATH: `${dir}:${process.env.PATH}`, APPS_FIXTURE_ROOT: dir, APPS_FIXTURE_DATA: dir,
    SQLITE_MARKER: join(dir, 'sqlite-invoked'),
  });
  expect(result.exitCode).not.toBe(0);
  expect(await Bun.file(join(dir, 'sqlite-invoked')).exists()).toBe(false);
});

test('S25 records a failed seed round trip before launching its worker', async () => {
  const dir = await temporary();
  const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
criterion() { :; }; apps_image() { :; }
apps_prepare_pack() { APPS_PACK="$RESULTS_DIR/seed"; echo seed >"$APPS_PACK"; }
apps_create() { APPS_SEED_FAILED=1; return 1; }
apps_worker() { echo unexpected-worker; }
record() { echo "$*"; }
probe_S25`], {
    SCRIPTS: scripts, SCRIPT_DIR: scripts, RESULTS_DIR: dir, DRY_RUN: '0',
    PROBE_PREFIX: 'test-', TS: 'unique',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain('S25 FAIL source pack did not restore fixture data');
  expect(result.stdout.toString()).not.toContain('unexpected-worker');
});

test('S23 distinguishes a failed worker from a network control failure', async () => {
  const dir = await temporary();
  const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
criterion() { :; }; apps_image() { :; }; apps_prepare_pack() { :; }; apps_create() { :; }
free_port() { echo 12345; }; start_host_service() { :; }; sm() { :; }; sleep() { :; }
apps_count() { echo 0; }; record() { echo "$*"; }
probe_S23`], {
    SCRIPTS: scripts, RESULTS_DIR: dir, DRY_RUN: '0', PROBE_PREFIX: 'test-',
    TS: 'unique', GUEST_GATEWAY: '100.96.0.1',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain('source worker did not acknowledge a transaction; network not assessed');
  expect(result.stdout.toString()).not.toContain('could not reach private sink');
});

test('stop barrier waits for stopped, refuses status failure and persistent running', async () => {
  const dir = await temporary();
  const shell = `source "$SCRIPTS/apps-recovery.sh"
sm() { return 0; }
say() { :; }
sleep() { :; }
capture() { echo called >>"$CALLS"; [ "$MODE" != error ] || return 1; printf '{"state":"%s"}' "$MODE"; }
apps_stop_wait owned-vm`;
  for (const mode of ['stopped', 'running', 'error']) {
    const calls = join(dir, mode);
    const result = run(['bash', '-uc', shell], { SCRIPTS: scripts, SMOLVM: 'unused', MODE: mode, CALLS: calls });
    expect(result.exitCode === 0).toBe(mode === 'stopped');
    expect((await readFile(calls, 'utf8')).trim().split('\n').length).toBe(mode === 'running' ? 20 : 1);
  }
});

test('failed Docker build has already registered only its unique cleanup tag', async () => {
  const dir = await temporary();
  const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
command() { return 0; }
capture() { test -s "$TMP_DIR/apps-docker-tags" || exit 99; return 7; }
apps_image`], { SCRIPTS: scripts, TMP_DIR: dir, TS: 'unique', GUEST_DIR: dir });
  expect(result.exitCode).toBe(1);
  expect(await readFile(join(dir, 'apps-docker-tags'), 'utf8')).toMatch(/^lazy-apps-recovery:unique-\d+\n$/);
});

test('live capture refusal still attempts cold leg and records separate outcomes', async () => {
  const dir = await temporary();
  const r = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
criterion() { return 0; }; apps_image() { :; }; apps_create() { :; }; apps_worker() { :; }
apps_headroom() { :; }; sleep() { :; }; apps_count() { echo 3; }; metric() { :; }
step() { echo "$*"; }; record() { echo "$*"; }
apps_prepare_pack() { APPS_PACK="$RESULTS_DIR/seed"; echo seed >"$APPS_PACK"; }
apps_capture_live() { echo live-attempt; return 1; }
apps_capture_cold() { echo cold-attempt; return 1; }
probe_S25`], { SCRIPTS: scripts, SCRIPT_DIR: scripts, RESULTS_DIR: dir, DRY_RUN: '0',
    PROBE_PREFIX: 'test-', TS: 'unique', APPS_VPID: '', APPS_VM_DISK: dir });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(r.stdout.toString()).toContain('live-attempt');
  expect(r.stdout.toString()).toContain('cold-attempt');
  expect(r.stdout.toString()).toContain('live capture INCONCLUSIVE');
  expect(r.stdout.toString()).toContain('cold capture INCONCLUSIVE');
});

test('bundled source pack must match both the checkpoint SHA and footer identity', async () => {
  const dir = await bundle();
  const source = artifact({ network: false });
  await writeFile(join(dir, 'source.smolmachine'), source);
  const sha = new Bun.CryptoHasher('sha256').update(source).digest('hex');
  const live = (packed: object, extra = {}) => artifact({ network: false, checkpoint: {
    version: 4, network: { enabled: false, ports: [] }, host_mounts: [], packed_layers: packed, ...extra,
  } });
  const packed = { artifact_sha256: sha, footer_checksum: 0 };
  await writeFile(join(dir, 'live.checkpoint'), live(packed));
  const good = inventory('write', dir);
  expect(good.exitCode, good.stderr.toString()).toBe(0);
  await writeFile(join(dir, 'inventory.json'), good.stdout);
  expect(inventory('verify', dir).exitCode).toBe(0);
  for (const bad of [{ ...packed, artifact_sha256: '0'.repeat(64) }, { ...packed, footer_checksum: 123 }, { ...packed, unknown_dependency: 'outside' }]) {
    await writeFile(join(dir, 'live.checkpoint'), live(bad));
    expect(inventory('write', dir).exitCode).not.toBe(0);
  }
  await writeFile(join(dir, 'live.checkpoint'), live(packed, { cache_disk: { base: 'outside' } }));
  expect(inventory('write', dir).exitCode).not.toBe(0);
  await writeFile(join(dir, 'live.checkpoint'), live(packed));
  await rm(join(dir, 'source.smolmachine'));
  expect(inventory('write', dir).exitCode).not.toBe(0);
});

test('local provisioning checkpoints only the retained cold pack and cleans its VM', async () => {
  const dir = await temporary();
  await writeFile(join(dir, 'source.smolmachine'), 'pack');
  const r = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
apps_create() { echo "create $1 from $APPS_PACK"; }
apps_measure() { echo "$*"; }
vm_delete() { echo "delete $1"; }
apps_provision_pack "$BUNDLE" owned-provision`], { SCRIPTS: scripts, BUNDLE: dir, TMP_DIR: dir, SMOLVM: 'pinned-smolvm' });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(r.stdout.toString()).toBe(`create owned-provision from ${dir}/source.smolmachine\ns25_pack_provision pinned-smolvm machine checkpoint --name owned-provision -o ${dir}/provision.checkpoint\ndelete owned-provision\n`);
});

test('pre-resume fence requires positive control and worker progress; escape fails and start refusal is inconclusive', async () => {
  for (const mode of ['fenced', 'escape', 'refuse']) {
    const dir = await temporary();
    const r = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
criterion() { :; }; apps_image() { :; }; apps_create() { :; }; apps_register() { :; }
apps_prepare_pack() { APPS_PACK="$TMP_DIR/pack"; echo pack >"$APPS_PACK"; }
free_port() { echo 12345; }; start_host_service() { : >"$4"; }; sleep() { :; }
apps_measure() { :; }; vm_delete() { :; }; perl() { :; }
step() { echo "$*"; }; record() { echo "$*"; }
apps_count() { local n=0; [ ! -f "$TMP_DIR/count" ] || n=$(cat "$TMP_DIR/count"); n=$((n+1)); echo "$n" >"$TMP_DIR/count"; echo "$n"; }
sm() {
  echo "$*" >>"$TMP_DIR/calls"
  case "$*" in
    *'exec'*|*'start'*'control'*) echo "connection request=GET /fence-unique-$$ HTTP/1.1" >>"$RESULTS_DIR/s23-sink.txt";;
    *'start'*'fenced'*)
      [ "$MODE" != refuse ] || return 1
      if [ "$MODE" = escape ]; then echo "connection request=GET /fence-unique-$$ HTTP/1.1" >>"$RESULTS_DIR/s23-sink.txt"; fi;;
  esac
}
capture() { if [ "$2" = curl ]; then echo "fence-unique-$$"; fi; }
probe_S23`], { SCRIPTS: scripts, SCRIPT_DIR: scripts, RESULTS_DIR: dir, TMP_DIR: dir, DRY_RUN: '0',
      PROBE_PREFIX: 'test-', TS: 'unique', SMOLVM: 'pinned', SMOLVM_VERSION: '1.29.0', GUEST_GATEWAY: '100.96.0.1', MODE: mode });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const stdout = r.stdout.toString();
    if (mode === 'fenced') expect(stdout).toContain('S23 PASS bounded synthetic');
    if (mode === 'escape') expect(stdout).toContain('S23 FAIL synthetic effect escaped');
    if (mode === 'refuse') expect(stdout).toContain('S23 INCONCLUSIVE updated topology');
    const calls = await readFile(join(dir, 'calls'), 'utf8');
    expect(calls.indexOf('--no-net')).toBeLessThan(calls.lastIndexOf('machine start'));
  }
});

// INVARIANT: cold exact-count verification cannot legitimize writes already lost
// during live capture/quiesce; the earlier acknowledged minimum still applies.
test('cold capture fails regressed acknowledgements before packing, but accepts equal or newer counts', async () => {
  for (const count of ['8', '9', '10']) {
    const dir = await temporary();
    const r = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
source=owned-source; minimum=9; capture_failed=0
now_ms() { echo 0; }; vm_exec() { :; }; apps_count() { echo "$COUNT"; }
step() { echo "$*"; }; metric() { :; }
apps_stop_wait() { echo stopped; }
apps_measure() { echo packed; echo pack >"$TMP_DIR/cold.smolmachine"; }
apps_headroom() { :; }; apps_restart_source() { :; }
bundle="$TMP_DIR/bundle"; mkdir "$bundle"
apps_capture_cold; rc=$?
echo "rc=$rc capture_failed=$capture_failed"`], { SCRIPTS: scripts, TMP_DIR: dir, SMOLVM: 'unused', COUNT: count });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const out = r.stdout.toString();
    if (count === '8') {
      expect(out).toContain('acknowledged source continuity FAIL');
      expect(out).toContain('rc=1 capture_failed=1');
      expect(out).not.toContain('stopped');
      expect(out).not.toContain('packed');
      expect(await Bun.file(join(dir, 'bundle/cold.smolmachine')).exists()).toBe(false);
    } else {
      expect(out).toContain('rc=0 capture_failed=0');
      expect(out).toContain('packed');
    }
  }
});

// INVARIANT: a dummy interface name is not a network fence. Only a kernel-
// identified, down, unaddressed and unrouted dummy may accompany loopback.
test('network verifier distinguishes an inert dummy from TSI or an external transport', async () => {
  const dir = await temporary();
  await writeFile(join(dir, 'ip'), `#!/bin/sh
case "$*" in
  '-details -json link show') printf '%s\\n' "$FIXTURE_LINKS";;
  '-json address show') printf '%s\\n' "$FIXTURE_ADDRESSES";;
  '-json -4 route show table all') printf '%s\\n' "$FIXTURE_ROUTES4";;
  '-json -6 route show table all') printf '%s\\n' "$FIXTURE_ROUTES6";;
  *) exit 9;;
esac
`, { mode: 0o755 });
  const lo = { ifname: 'lo', link_type: 'loopback', flags: ['LOOPBACK', 'UP'] };
  const dummy = { ifname: 'dummy0', link_type: 'ether', flags: ['BROADCAST', 'NOARP'], linkinfo: { info_kind: 'dummy' } };
  const cases = [
    { pass: true, links: [lo], addresses: [{ ifname: 'lo', addr_info: [] }] },
    { pass: true, links: [lo, dummy] },
    { pass: false, links: [lo, { ...dummy, ifname: 'eth0' }] },
    { pass: false, links: [lo, { ...dummy, linkinfo: { info_kind: 'veth' } }] },
    { pass: false, links: [lo, { ...dummy, flags: ['UP'] }] },
    { pass: false, links: [lo, dummy], addresses: [{ ifname: 'dummy0', addr_info: [{ local: '203.0.113.1' }] }] },
    { pass: false, links: [lo, dummy], routes4: [{ dev: 'dummy0', dst: 'default' }] },
    { pass: false, links: [lo, dummy], routes6: [{ dev: 'dummy0', dst: 'fe80::/64' }] },
    { pass: false, links: null },
  ];
  for (const sample of cases) {
    const result = run(['sh', join(scripts, 'guest/apps-recovery.sh'), 'verify-network'], {
      PATH: `${dir}:${process.env.PATH}`,
      FIXTURE_LINKS: JSON.stringify(sample.links),
      FIXTURE_ADDRESSES: JSON.stringify(sample.addresses ?? [{ ifname: 'lo', addr_info: [] }, { ifname: 'dummy0', addr_info: [] }]),
      FIXTURE_ROUTES4: JSON.stringify(sample.routes4 ?? [{ dev: 'lo', dst: '127.0.0.0/8' }]),
      FIXTURE_ROUTES6: JSON.stringify(sample.routes6 ?? [{ dev: 'lo', dst: '::1' }]),
    });
    expect(result.exitCode === 0, `${JSON.stringify(sample)}\n${result.stderr}`).toBe(sample.pass);
  }
});

test('a completed cold capture remains available when the separate restart check fails', async () => {
  const dir = await temporary();
  const result = run(['bash', '-uc', `source "$SCRIPTS/apps-recovery.sh"
source=owned-source; minimum=9; capture_failed=0
now_ms() { echo 0; }; vm_exec() { :; }; apps_count() { echo 9; }
step() { echo "$*"; }; metric() { :; }; apps_stop_wait() { :; }
apps_measure() { echo captured >"$TMP_DIR/cold.smolmachine"; }
apps_headroom() { :; }; apps_restart_source() { return 1; }
bundle="$TMP_DIR/bundle"; mkdir "$bundle"
apps_capture_cold; rc=$?
echo "rc=$rc capture_failed=$capture_failed"`], { SCRIPTS: scripts, TMP_DIR: dir, SMOLVM: 'unused' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain('same-machine stop/start FAIL');
  expect(result.stdout.toString()).toContain('rc=0 capture_failed=1');
  expect(await readFile(join(dir, 'bundle/cold.smolmachine'), 'utf8')).toBe('captured\n');
});
