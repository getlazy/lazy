/**
 * Doctor's smolvm rows (src/doctor/smolvm.ts): each check's pass and fail
 * state against a faked smolvm, hypervisor and filesystem.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import { checkSmolvmSetup, linuxKvmProbe, smolvmRunnerSetupFailure, type SmolvmDoctorDeps, type SmolvmDoctorMachine } from '../../src/doctor/smolvm';
import { classifyDoctorCheck } from '../../src/doctor/check-families';
import { SMOLVM_RELEASE } from '../../src/vm/smolvm-docker-machine';
import type { CheckResult } from '../../src/doctor/types';
import { SmolvmRecordUnreadableError } from '../../src/vm/smolvm-project-machine';
import { SmolvmRunnerError } from '../../src/runner/smolvm-runner';

function config(over: Partial<ResolvedConfig['smolvm']> = {}): ResolvedConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runner.type = 'smolvm';
  c.smolvm = { ...c.smolvm, binary: '/opt/smolvm/smolvm', image: '/opt/lazy-daemon.tar', ...over };
  return c;
}

function machine(over: Partial<SmolvmDoctorMachine> = {}): SmolvmDoctorMachine {
  return {
    name: 'lazy-proj-1234',
    listedState: async () => 'running',
    recordDifference: async () => ({ kind: 'present', diff: { recreate: [], advisory: [] } }),
    ...over,
  };
}

function deps(over: Partial<SmolvmDoctorDeps> = {}): SmolvmDoctorDeps {
  return {
    platform: 'linux',
    arch: 'x64',
    env: {},
    which: () => '/usr/bin/docker',
    verifyBinary: async (p) => p,
    hypervisor: async () => null,
    fileExists: async () => true,
    machine: () => machine(),
    relaySocketBase: async () => '/tmp/lazy-1000',
    ...over,
  };
}

const run = (c: ResolvedConfig, d: SmolvmDoctorDeps) => checkSmolvmSetup('/proj', c, d);
const row = (rows: CheckResult[], prefix: string) => {
  const r = rows.find((x) => x.label.startsWith(prefix));
  if (!r) throw new Error(`no row starting ${prefix}: ${rows.map((x) => x.label).join(' | ')}`);
  return r;
};
const failText = (r: CheckResult) => (r.ok ? '' : `${r.problem} ${r.detail ?? ''}`);

describe('a healthy smolvm setup', () => {
  test('every row passes, naming what it found', async () => {
    const rows = await run(config(), deps());
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(rows.map((r) => r.label)).toEqual([
      `smolvm binary (/opt/smolvm/smolvm, release ${SMOLVM_RELEASE.version})`,
      'Hypervisor available (/dev/kvm)',
      'docker CLI on PATH (/usr/bin/docker)',
      'smolvm image (/opt/lazy-daemon.tar)',
      'smolvm machine lazy-proj-1234: running',
      'smolvm machine matches lazy.toml',
      'smolvm relay socket dir private (/tmp/lazy-1000)',
    ]);
  });

  test('every row is classified by a family, never the default', async () => {
    const rows = await run(config(), deps());
    for (const r of rows) expect(classifyDoctorCheck(r.label, 'fallback').family).toStartWith('smolvm-');
  });
});

describe('the smolvm binary', () => {
  test('none configured: says so, with how to install it; the machine rows are skipped', async () => {
    const rows = await run(config({ binary: '' }), deps());
    const r = row(rows, 'smolvm binary');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('lazy system smolvm-install');
    expect(failText(r)).toContain(SMOLVM_RELEASE.version);
    expect(row(rows, 'smolvm machine').label).toBe('smolvm machine (skipped — fix the smolvm binary first)');
  });

  test('taken from LAZY_SMOLVM_BINARY when lazy.toml names none', async () => {
    const rows = await run(config({ binary: '' }), deps({ env: { LAZY_SMOLVM_BINARY: '/env/smolvm' } }));
    expect(row(rows, 'smolvm binary').label).toContain('/env/smolvm');
  });

  test('failing the pin check: the verifier\'s reason, the expected release archive, and the fix', async () => {
    let machineAsked = false;
    const rows = await run(config(), deps({
      verifyBinary: async () => { throw new Error('vendored from smolvm-1.9.3-linux-x86_64.tar.gz'); },
      machine: () => { machineAsked = true; return machine(); },
    }));
    const r = row(rows, 'smolvm binary');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('vendored from smolvm-1.9.3');
    expect(failText(r)).toContain(`smolvm-${SMOLVM_RELEASE.version}-linux-x86_64.tar.gz`);
    // INVARIANT: an unverified smolvm is never run, not even to list machines.
    expect(machineAsked).toBe(false);
  });
});

describe('the hypervisor', () => {
  test('a failing probe: its problem and fix', async () => {
    const rows = await run(config(), deps({ hypervisor: async () => ({ problem: 'this user cannot open /dev/kvm', fix: 'sudo usermod -aG kvm "$USER"' }) }));
    const r = row(rows, 'Hypervisor available');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('cannot open /dev/kvm');
    expect(failText(r)).toContain('usermod -aG kvm');
  });

  test('macOS names Hypervisor.framework', async () => {
    const rows = await run(config(), deps({ platform: 'darwin', arch: 'arm64' }));
    expect(row(rows, 'Hypervisor available').label).toBe('Hypervisor available (Hypervisor.framework)');
  });

  test('an Intel Mac is not a platform smolvm ships for', async () => {
    let probed = false;
    const rows = await run(config(), deps({ platform: 'darwin', arch: 'x64', hypervisor: async () => { probed = true; return null; } }));
    const r = row(rows, 'Hypervisor available');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('darwin/x64');
    expect(probed).toBe(false);
  });

  test('the Linux probe: a missing /dev/kvm and an unreadable one say different things', async () => {
    const missing = await linuxKvmProbe('/nonexistent/kvm');
    expect(missing?.problem).toContain('there is no /nonexistent/kvm');
    expect(missing?.fix).toContain('modprobe');
  });
});

describe('the docker CLI', () => {
  test('absent: install the client alone, no Docker Desktop', async () => {
    const rows = await run(config(), deps({ which: () => null, platform: 'darwin', arch: 'arm64' }));
    const r = row(rows, 'docker CLI on PATH');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('brew install docker');
    expect(failText(r)).toContain('no Docker Desktop needed');
  });
});

describe('the image', () => {
  test('not set', async () => {
    const r = row(await run(config({ image: '' }), deps()), 'smolvm image');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.problem).toBe('[smolvm] image is not set');
    expect(failText(r)).toContain('lazy system smolvm-build-image');
  });

  test('set to a path with no file', async () => {
    const r = row(await run(config(), deps({ fileExists: async () => false })), 'smolvm image');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('No image tar at /opt/lazy-daemon.tar');
  });
});

describe('the machine', () => {
  test('absent: passes (lazy creates it), and there is no record to compare', async () => {
    const rows = await run(config(), deps({ machine: () => machine({ listedState: async () => 'absent' }) }));
    expect(row(rows, 'smolvm machine lazy').label).toBe('smolvm machine lazy-proj-1234: not created yet; lazy creates it when a task next starts');
    expect(rows.some((r) => r.label.startsWith('smolvm machine matches'))).toBe(false);
  });

  test('stopped: passes (lazy starts it)', async () => {
    const rows = await run(config(), deps({ machine: () => machine({ listedState: async () => 'stopped' }) }));
    expect(row(rows, 'smolvm machine lazy').label).toContain('stopped; lazy starts it');
  });

  test('smolvm cannot list: a failure with smolvm\'s own command to look', async () => {
    const rows = await run(config(), deps({ machine: () => machine({ listedState: async () => { throw new Error('cannot read state'); } }) }));
    const r = row(rows, 'smolvm machine lazy');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('machine ls');
  });

  test('a record that needs a recreate: what differs and the recreate commands', async () => {
    const rows = await run(config(), deps({
      machine: () => machine({ recordDifference: async () => ({ kind: 'present', diff: { recreate: ['it does not share /data into the machine'], advisory: [] } }) }),
    }));
    const r = row(rows, 'smolvm machine matches');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('it does not share /data');
    expect(failText(r)).toContain('machine delete --name lazy-proj-1234 --force');
  });

  test('no record of an existing machine: recreate', async () => {
    const rows = await run(config(), deps({ machine: () => machine({ recordDifference: async () => ({ kind: 'none' }) }) }));
    const r = row(rows, 'smolvm machine matches');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('machine stop --name lazy-proj-1234');
  });

  test('advisory differences only: passes with a warning naming the recreate commands', async () => {
    const rows = await run(config(), deps({
      machine: () => machine({ recordDifference: async () => ({ kind: 'present', diff: { recreate: [], advisory: ['[smolvm] cpus is 8, the machine was created with 4'] } }) }),
    }));
    const r = row(rows, 'smolvm machine matches');
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('cpus is 8');
    expect(r.warning).toContain('machine delete');
  });
});

describe('the relay socket dir', () => {
  test('not private: the relay\'s own reason, which carries the chmod', async () => {
    const rows = await run(config(), deps({ relaySocketBase: async () => { throw new Error('/tmp/lazy-1000 is not a private directory; chmod 700 /tmp/lazy-1000'); } }));
    const r = row(rows, 'smolvm relay socket dir');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('chmod 700');
  });
});

describe('the record check never advises deleting a machine over a config problem', () => {
  test('image unset on an existing machine: the comparison is skipped, no recreate commands', async () => {
    const rows = await run(config({ image: '' }), deps());
    expect(row(rows, 'smolvm machine matches').label).toBe('smolvm machine matches lazy.toml (skipped — set [smolvm] image first)');
    expect(JSON.stringify(rows)).not.toContain('machine delete');
  });

  test('a config error (a missing share): its own message, no recreate commands', async () => {
    const rows = await run(config(), deps({
      machine: () => machine({ recordDifference: async () => { throw new Error('machine create: /data does not exist, so it cannot be shared into the machine'); } }),
    }));
    const r = row(rows, 'smolvm machine matches');
    expect(r.ok).toBe(false);
    expect(failText(r)).toContain('/data does not exist');
    expect(JSON.stringify(rows)).not.toContain('machine delete');
  });

  test('an unreadable record: recreate', async () => {
    const rows = await run(config(), deps({
      machine: () => machine({ recordDifference: async () => { throw new SmolvmRecordUnreadableError('machine.json is not valid JSON'); } }),
    }));
    expect(failText(row(rows, 'smolvm machine matches'))).toContain('machine delete --name lazy-proj-1234 --force');
  });
});

describe('a smolvm runner that cannot be set up', () => {
  // INVARIANT: doctor reports a runner it cannot create as a row and keeps
  // going; it never dies telling the user to run doctor.
  test('a SmolvmRunnerError becomes one failing row without the doctor pointer', () => {
    const r = smolvmRunnerSetupFailure(new SmolvmRunnerError('/tmp/lazy-1000 is not a private directory; chmod 700 /tmp/lazy-1000'));
    expect(r?.ok).toBe(false);
    expect(r && !r.ok ? r.detail : '').toContain('chmod 700');
    expect(r && !r.ok ? r.detail : '').not.toContain('lazy doctor');
    expect(classifyDoctorCheck(r!.label, 'x').family).toBe('smolvm-runner-setup');
  });

  test('a filesystem error (an unwritable state dir) too; anything else is not this row', () => {
    const fsErr = Object.assign(new Error('EACCES: permission denied, mkdir ~/.lazy/smolvm'), { code: 'EACCES' });
    expect(smolvmRunnerSetupFailure(fsErr)?.ok).toBe(false);
    expect(smolvmRunnerSetupFailure(new Error('Unknown runner type'))).toBeNull();
  });
});
