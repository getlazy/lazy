/**
 * Doctor's rows for a project on `[runner] type = "smolvm"`
 * (src/runner/smolvm-runner.ts): everything that runner needs from the host,
 * each with what is wrong and the exact fix. The runner itself only prints the
 * one "run lazy doctor" pointer at the point of failure; the explanation is
 * here (shared memory `doctor-single-warning-surface`).
 *
 * Only ever called for a smolvm project outside managed mode — the fleet never
 * runs a repository's smolvm machine (src/config/managed.ts withholds the
 * runner type), so a Teams sweep shows none of these rows.
 *
 * Every probe is injectable so each pass and fail state is unit-tested against
 * a faked smolvm and filesystem (test/unit/doctor-smolvm.test.ts).
 */
import { access, constants, stat } from 'fs/promises';
import type { ResolvedConfig } from '../config/types';
import type { CheckResult } from './types';
import { SMOLVM_RELEASE, smolvmCliRunner, type MachineState } from '../vm/smolvm-docker-machine';
import { smolvmPlatform, smolvmArchiveName, verifySmolvmBinary } from '../vm/smolvm-release';
import {
  SoloSmolvmMachine, recreateCommands, soloMachineName, soloMachineStateDir, type RecordDifference,
} from '../vm/smolvm-project-machine';
import { relaySocketBase } from '../vm/docker-relay';
import { smolvmStateRoot } from '../vm/smolvm-engines';
import { spawn } from '../utils/spawn';
import { RUN_DOCTOR, SmolvmRecordUnreadableError } from '../vm/smolvm-project-machine';
import { SmolvmRunnerError } from '../runner/smolvm-runner';

/** The parts of a project machine the checks ask about. */
export interface SmolvmDoctorMachine {
  name: string;
  listedState(): Promise<MachineState>;
  recordDifference(): Promise<{ kind: 'none' } | { kind: 'present'; diff: RecordDifference }>;
}

export interface SmolvmDoctorDeps {
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  which: (name: string) => string | null;
  verifyBinary: (path: string) => Promise<string>;
  /** Hypervisor probe: null when available, else why not and the fix. */
  hypervisor: () => Promise<{ problem: string; fix: string } | null>;
  fileExists: (path: string) => Promise<boolean>;
  machine: (binary: string) => SmolvmDoctorMachine;
  relaySocketBase: () => Promise<string>;
}

const VENDOR_FIX =
  `Install smolvm ${SMOLVM_RELEASE.version} with \`lazy system smolvm-install\`: it downloads and verifies the pinned release ` +
  'and offers to set [smolvm] binary in lazy.toml to the launcher it installed (or prints the path to set).';

const DOCS = 'agent-container' as const;

export async function linuxKvmProbe(path = '/dev/kvm'): Promise<{ problem: string; fix: string } | null> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        problem: `there is no ${path}, so this machine cannot run KVM virtual machines`,
        fix: 'Enable hardware virtualization (in the firmware, or nested virtualization for a VM) and load the kvm module: sudo modprobe kvm_intel (or kvm_amd).',
      };
    }
    return {
      problem: `this user cannot open ${path}`,
      fix: 'Add yourself to the kvm group and log in again: sudo usermod -aG kvm "$USER"',
    };
  }
}

async function macHypervisorProbe(): Promise<{ problem: string; fix: string } | null> {
  let out: string;
  let code: number;
  try {
    const proc = spawn(['/usr/sbin/sysctl', '-n', 'kern.hv_support'], { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
    [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } catch (err) {
    return {
      problem: `lazy could not ask macOS whether Hypervisor.framework is available: ${msg(err)}`,
      fix: 'Run /usr/sbin/sysctl -n kern.hv_support yourself; it should print 1 on an Apple Silicon Mac.',
    };
  }
  if (code === 0 && out.trim() === '1') return null;
  return {
    problem: 'macOS reports no Hypervisor.framework support (sysctl kern.hv_support is not 1)',
    fix: 'smolvm needs an Apple Silicon Mac with virtualization available; inside a virtual machine, enable nested virtualization.',
  };
}

export function defaultSmolvmDoctorDeps(root: string, config: ResolvedConfig): SmolvmDoctorDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    which: (name) => Bun.which(name),
    verifyBinary: (p) => verifySmolvmBinary(p),
    hypervisor: () => process.platform === 'darwin' ? macHypervisorProbe() : linuxKvmProbe(),
    fileExists: async (p) => {
      try { return (await stat(p)).isFile(); } catch { return false; } // any stat failure: not a usable file
    },
    machine: (binary) => {
      const name = soloMachineName(root);
      return new SoloSmolvmMachine({
        projectRoot: root,
        smolvm: binary,
        run: smolvmCliRunner(binary),
        config: config.smolvm,
        // Imported lazily: the runner module pulls in the docker runner, which
        // doctor only needs on this path.
        shareInputs: async () => (await import('../runner/smolvm-runner')).realShareInputs(root, config),
        stateDir: soloMachineStateDir(smolvmStateRoot(), name),
      });
    },
    relaySocketBase: () => relaySocketBase(),
  };
}

/**
 * The row for a smolvm runner that could not be created — its relay socket
 * directory refused, or its state directory not writable — or null when the
 * error is something else (the sweep then handles it as before).
 */
export function smolvmRunnerSetupFailure(err: unknown): CheckResult | null {
  const fsError = typeof (err as NodeJS.ErrnoException)?.code === 'string';
  if (!(err instanceof SmolvmRunnerError) && !fsError) return null;
  const detail = msg(err).replace(RUN_DOCTOR, '').trim();
  return {
    ok: false, label: 'smolvm runner set up', problem: 'lazy could not set up the smolvm runner on this machine',
    detail, remedy: detail.split('\n')[0], docs: DOCS,
  };
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The smolvm rows, in the order a fix has to happen. */
export async function checkSmolvmSetup(root: string, config: ResolvedConfig, deps: SmolvmDoctorDeps = defaultSmolvmDoctorDeps(root, config)): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. The binary, against the pin.
  const binary = config.smolvm.binary || deps.env.LAZY_SMOLVM_BINARY?.trim() || '';
  let verified: string | null = null;
  const triple = smolvmPlatform(deps.platform, deps.arch);
  if (!binary) {
    results.push({
      ok: false, label: 'smolvm binary', problem: 'No smolvm binary is configured',
      detail: `[runner] type is "smolvm" but neither [smolvm] binary nor LAZY_SMOLVM_BINARY names one. ${VENDOR_FIX}`,
      remedy: VENDOR_FIX, docs: DOCS,
    });
  } else {
    try {
      verified = await deps.verifyBinary(binary);
      results.push({ ok: true, label: `smolvm binary (${binary}, release ${SMOLVM_RELEASE.version})` });
    } catch (err) {
      const expected = triple ? ` lazy expects ${smolvmArchiveName(triple)}.` : '';
      results.push({
        ok: false, label: 'smolvm binary', problem: `The smolvm at ${binary} cannot be used`,
        detail: `${msg(err)}.${expected}`, remedy: VENDOR_FIX, docs: DOCS,
      });
    }
  }

  // 2. The hypervisor.
  if (!triple) {
    results.push({
      ok: false, label: 'Hypervisor available', problem: `smolvm does not run on ${deps.platform}/${deps.arch}`,
      detail: `smolvm ${SMOLVM_RELEASE.version} ships for Apple Silicon macOS and arm64/x86_64 Linux only. Use [runner] type = "docker" on this machine.`,
      remedy: 'Use [runner] type = "docker" on this machine.', docs: DOCS,
    });
  } else {
    const hv = await deps.hypervisor();
    const kind = deps.platform === 'darwin' ? 'Hypervisor.framework' : '/dev/kvm';
    results.push(hv
      ? { ok: false, label: 'Hypervisor available', problem: `smolvm cannot start a VM: ${hv.problem}`, detail: hv.fix, remedy: hv.fix, docs: DOCS }
      : { ok: true, label: `Hypervisor available (${kind})` });
  }

  // 3. The host's docker client.
  const docker = deps.which('docker');
  const dockerFix = deps.platform === 'darwin'
    ? 'Install the client alone (no Docker Desktop needed): brew install docker'
    : 'Install the docker client package (e.g. sudo apt-get install docker-ce-cli); no local Docker engine is needed.';
  results.push(docker
    ? { ok: true, label: `docker CLI on PATH (${docker})` }
    : {
      ok: false, label: 'docker CLI on PATH', problem: 'There is no docker command on PATH',
      detail: `The smolvm runner drives the machine's own Docker engine with the docker client on this machine. ${dockerFix}`,
      remedy: dockerFix, docs: DOCS,
    });

  // 4. The image the machine boots.
  const imageFix = 'Point [smolvm] image at a lazy daemon image tar (docker save form): build one with ' +
    '`lazy system smolvm-build-image`, or `scripts/publish-lazy-daemon-image.sh --save <path>` from a lazy checkout.';
  if (!config.smolvm.image) {
    results.push({ ok: false, label: 'smolvm image', problem: '[smolvm] image is not set', detail: imageFix, remedy: imageFix, docs: DOCS });
  } else if (!(await deps.fileExists(config.smolvm.image))) {
    results.push({
      ok: false, label: 'smolvm image', problem: `No image tar at ${config.smolvm.image}`,
      detail: `[smolvm] image names ${config.smolvm.image}, which is not a file. ${imageFix}`, remedy: imageFix, docs: DOCS,
    });
  } else {
    results.push({ ok: true, label: `smolvm image (${config.smolvm.image})` });
  }

  // 5 and 6. The machine and its record: only a verified smolvm is ever run.
  if (!verified) {
    results.push({ ok: true, label: 'smolvm machine (skipped — fix the smolvm binary first)' });
  } else {
    const machine = deps.machine(verified);
    let state: MachineState | null = null;
    try {
      state = await machine.listedState();
      const said = state === 'absent'
        ? 'not created yet; lazy creates it when a task next starts'
        : state === 'stopped' ? 'stopped; lazy starts it when a task next starts' : 'running';
      results.push({ ok: true, label: `smolvm machine ${machine.name}: ${said}` });
    } catch (err) {
      results.push({
        ok: false, label: `smolvm machine ${machine.name}`, problem: 'smolvm could not list its machines',
        detail: `${msg(err)}. Run "${verified}" machine ls to see smolvm's own error.`, remedy: `Run "${verified}" machine ls`, docs: DOCS,
      });
    }
    if (state && state !== 'absent' && !config.smolvm.image) {
      results.push({ ok: true, label: 'smolvm machine matches lazy.toml (skipped — set [smolvm] image first)' });
    } else if (state && state !== 'absent') {
      const recreate = recreateCommands(verified, machine.name);
      const recreateText = `When no task is running, delete it and lazy creates it again on the next turn:\n${recreate.map((c) => `  ${c}`).join('\n')}`;
      try {
        const rec = await machine.recordDifference();
        if (rec.kind === 'none') {
          results.push({
            ok: false, label: 'smolvm machine matches lazy.toml', problem: `lazy has no record of how ${machine.name} was created`,
            detail: `lazy cannot tell whether it shares what tasks mount. ${recreateText}`, remedy: recreate.join(' && '), docs: DOCS,
          });
        } else if (rec.diff.recreate.length) {
          results.push({
            ok: false, label: 'smolvm machine matches lazy.toml', problem: `${machine.name} has to be recreated before it can run tasks`,
            detail: `${[...rec.diff.recreate, ...rec.diff.advisory].join('; ')}. ${recreateText}`, remedy: recreate.join(' && '), docs: DOCS,
          });
        } else if (rec.diff.advisory.length) {
          results.push({
            ok: true, label: 'smolvm machine matches lazy.toml',
            warning: `it keeps running as it was created: ${rec.diff.advisory.join('; ')}. To apply the new settings: ${recreate.join(' && ')}`,
          });
        } else {
          results.push({ ok: true, label: 'smolvm machine matches lazy.toml' });
        }
      } catch (err) {
        // Only an unreadable record means the machine must go. Anything else is
        // the config's own problem (a missing share, say): its message is the
        // fix, and recreating a healthy machine would throw away its images.
        const unreadable = err instanceof SmolvmRecordUnreadableError;
        results.push({
          ok: false, label: 'smolvm machine matches lazy.toml', problem: `lazy could not compare ${machine.name} with lazy.toml`,
          detail: unreadable ? `${msg(err)}. ${recreateText}` : msg(err),
          ...(unreadable ? { remedy: recreate.join(' && ') } : {}), docs: DOCS,
        });
      }
    }
  }

  // 7. The private directory the docker relay socket lives in.
  try {
    const base = await deps.relaySocketBase();
    results.push({ ok: true, label: `smolvm relay socket dir private (${base})` });
  } catch (err) {
    results.push({ ok: false, label: 'smolvm relay socket dir private', problem: 'The docker relay socket directory is not private', detail: msg(err), docs: DOCS });
  }

  return results;
}
