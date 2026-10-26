/**
 * A smolvm machine that runs its own dockerd, driven from the host.
 *
 * ONE implementation for every lazy surface that needs "a Docker engine in a
 * microVM": Lazy Teams' native install builds the daemon image in a throwaway
 * one (`buildImageInSmolvm`, src/vm/smolvm-image-build.ts), and solo lazy's
 * smolvm runner (docs/design/ic-mode-smolvm-shape.md, shape (b)) drives a
 * long-lived one per project through this same class
 * (src/vm/smolvm-project-machine.ts). The facts both sides share — smolvm's
 * environment, its pinned release, the public egress policy, the builder's
 * image and size — live in
 * smolvm-docker-machine.json, not in code, so nothing is copied.
 *
 * The machine boots a lazy daemon image, which carries dockerd, buildx and
 * `lazy-guest-init`: the script that puts docker's data-root on the machine's
 * ext4 `--storage` disk (the overlay rootfs cannot hold overlay2) and starts
 * dockerd. That is exactly how a Teams project machine gets its engine, so
 * there is no second way to run one.
 *
 * Every smolvm call goes through an injectable runner, so tests drive a fake
 * CLI and only the engineer's Mac runs the real thing.
 */
import facts from './smolvm-docker-machine.json';
import { spawn } from '../utils/spawn';

export const SMOLVM_ENV: Readonly<Record<string, string>> = Object.freeze({ ...facts.smolvmEnv });
export const BUILDER_DEFAULTS = Object.freeze({ ...facts.builder });
/** The one smolvm release lazy runs, and its archive digests per platform (Teams: SmolvmRelease). */
export const SMOLVM_RELEASE = Object.freeze({ version: facts.release.version, pinConfirmed: facts.release.pinConfirmed, releaseBase: facts.release.releaseBase, archiveSha256: Object.freeze({ ...facts.release.archiveSha256 }) as Readonly<Record<string, string>> });
/** All of public IP space and nothing else, as `--allow-cidr` blocks (Teams: PublicEgress.cidrs). */
export const PUBLIC_EGRESS_CIDRS: readonly string[] = Object.freeze([...facts.egress.publicCidrs]);
export const SOLO_DEFAULTS = Object.freeze({ ...facts.solo });

/** What `machine ls --json` says about one machine. */
export type MachineState = 'absent' | 'running' | 'stopped';

export interface SmolvmResult { exitCode: number; stdout: string; stderr: string }
export interface SmolvmRunOptions {
  timeoutMs: number;
  onLine?: (line: string) => void;
  /** Extra environment for this invocation, on top of lazy's smolvm environment. */
  env?: Record<string, string>;
}
/** Runs `<smolvm> ...argv` and resolves with its outcome; never throws for a non-zero exit. */
export type SmolvmRunner = (argv: string[], opts: SmolvmRunOptions) => Promise<SmolvmResult>;

export class SmolvmMachineError extends Error {
  constructor(public readonly step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = 'SmolvmMachineError';
  }
}

/**
 * One virtiofs share. `readOnly` appends `:ro` (smolvm's per-mount read-only,
 * libkrun `krun_add_virtiofs3(…, read_only)`; used on the pinned release by the
 * probe harness, scripts/smolvm-probes/run.sh).
 */
export interface MachineVolume { host: string; guest: string; readOnly?: boolean }
export interface MachineSpec {
  name: string;
  /** A `docker save` tar (absolute path) of a lazy daemon image. */
  image: string;
  cpus: number;
  memoryMib: number;
  storageGib: number;
  /** Public CIDRs the machine may reach; smolvm cannot add a policy after create, so none is refused. */
  allowCidrs: string[];
  volumes: MachineVolume[];
  /**
   * smolvm's ONE guest-to-host mapping (`SMOLVM_GUEST_HOST_SERVICE=<guest port>:<host port>`):
   * the guest reaches the gateway address on `guestPort` and lands on this
   * host's loopback `hostPort`, and nothing else on the host becomes reachable
   * (probes S7/S8). smolvm reads it when the VM process launches, so create
   * and every start carry it (S9: a start applies it to an existing machine).
   */
  hostService?: { guestPort: number; hostPort: number };
}

const MINUTE = 60_000;
export const TIMEOUTS = { create: 10 * MINUTE, start: 5 * MINUTE, short: MINUTE, dockerd: 3 * MINUTE };

/** The real runner: the vendored smolvm binary, with lazy's smolvm environment. */
export function smolvmCliRunner(binary: string): SmolvmRunner {
  return async (argv, { timeoutMs, onLine, env }) => {
    const proc = spawn([binary, ...argv], {
      stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs,
      env: { ...process.env, ...SMOLVM_ENV, ...env },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const decoder = new TextDecoder();
      let all = '';
      let pending = '';
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        all += text;
        if (!onLine) continue;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      }
      if (onLine && pending) onLine(pending);
      return all;
    };
    const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
    return { exitCode: exitCode ?? -1, stdout, stderr };
  };
}

/** A mount source crosses into the guest as `-v HOST:GUEST`: refuse what that string cannot say. */
export function validateVolume(v: MachineVolume): void {
  for (const [side, p] of [['host', v.host], ['guest', v.guest]] as const) {
    if (!p.startsWith('/')) throw new SmolvmMachineError('machine create', `the ${side} side of a mount must be absolute, got ${p}`);
    if (p.includes(':')) throw new SmolvmMachineError('machine create', `a mount path cannot contain ':' (smolvm splits -v on it): ${p}`);
  }
}

export class SmolvmDockerMachine {
  constructor(private readonly run: SmolvmRunner, readonly spec: MachineSpec, private readonly say: (line: string) => void) {}

  get name(): string { return this.spec.name; }

  /** What every create, publish and start of this machine carries: its host-service mapping. */
  private get lifecycleEnv(): Record<string, string> | undefined {
    const hs = this.spec.hostService;
    return hs ? { SMOLVM_GUEST_HOST_SERVICE: `${hs.guestPort}:${hs.hostPort}` } : undefined;
  }

  private async must(step: string, argv: string[], timeoutMs: number, onLine?: (line: string) => void, env?: Record<string, string>): Promise<SmolvmResult> {
    const result = await this.run(argv, env ? { timeoutMs, onLine, env } : { timeoutMs, onLine });
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').split('\n').slice(-15).join('\n');
      throw new SmolvmMachineError(step, `smolvm ${argv.join(' ')} exited ${result.exitCode}:\n${detail}`);
    }
    return result;
  }

  /** Create and start the machine. A leftover under the same name (a killed earlier run) is removed first. */
  async boot(): Promise<void> {
    this.validateSpec();
    await this.remove({ quiet: true });
    await this.create();
    await this.start();
  }

  private validateSpec(): void {
    if (this.spec.allowCidrs.length === 0) {
      throw new SmolvmMachineError('machine create', 'refusing to create a machine with no egress policy: a bare network reaches this host\'s loopback, and smolvm cannot add a policy afterwards');
    }
    this.spec.volumes.forEach(validateVolume);
  }

  /**
   * `machine create`, and nothing else: never removes anything first. A
   * caller that keeps its machine (the solo runner) must decide from
   * {@link state} that there is nothing to keep before calling this.
   */
  async create(): Promise<void> {
    const { spec } = this;
    this.validateSpec();
    this.say(`creating machine ${spec.name} from ${spec.image} (${spec.cpus} vCPU, ${spec.memoryMib} MiB RAM, ${spec.storageGib} GiB disk)`);
    await this.must('machine create', [
      'machine', 'create', '--name', spec.name, '-I', spec.image,
      '--cpus', String(spec.cpus), '--mem', String(spec.memoryMib), '--storage', String(spec.storageGib),
      ...spec.volumes.flatMap((v) => ['-v', `${v.host}:${v.guest}${v.readOnly ? ':ro' : ''}`]),
      ...spec.allowCidrs.flatMap((c) => ['--allow-cidr', c]),
    ], TIMEOUTS.create, undefined, this.lifecycleEnv);
  }

  /**
   * Publish host loopback `hostPort` → guest `guestPort` with `machine update
   * -p` on the STOPPED machine — the only state smolvm publishes in, and the
   * path Lazy Teams runs on the pinned release (SmolvmSupervisor#apply_ports);
   * create's own `-p` has not been exercised on hardware. `taken` when the
   * host port belongs to something else (worth retrying with another port);
   * any other failure throws. A mapping smolvm says is already there is success.
   */
  async publishPort(hostPort: number, guestPort: number): Promise<'published' | 'taken'> {
    const argv = ['machine', 'update', '--name', this.name, '-p', `${hostPort}:${guestPort}`];
    const result = await this.run(argv, { timeoutMs: TIMEOUTS.short, ...(this.lifecycleEnv ? { env: this.lifecycleEnv } : {}) });
    if (result.exitCode === 0) return 'published';
    const text = `${result.stdout}${result.stderr}`.toLowerCase();
    // Same two readings as SmolvmSupervisor#host_port_taken? / #already_published?.
    if (/in use|eaddrinuse|address already|port .*(taken|unavailable)/.test(text)) return 'taken';
    if (/already (published|mapped|added|exists|configured)/.test(text)) return 'published';
    const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').split('\n').slice(-15).join('\n');
    throw new SmolvmMachineError('machine publish', `smolvm ${argv.join(' ')} exited ${result.exitCode}:\n${detail}`);
  }

  /** `machine start`, then wait until the guest takes an exec. */
  async start(): Promise<void> {
    this.say(`starting machine ${this.name}`);
    await this.must('machine start', ['machine', 'start', '--name', this.name], TIMEOUTS.start, undefined, this.lifecycleEnv);
    await this.awaitExecReady();
  }

  /**
   * This machine's state from `machine ls --json`. A listing that fails or
   * does not parse THROWS: answering "absent" would make a caller create a
   * machine that already exists (the Teams supervisor's parse_machine_list
   * draws the same line).
   */
  async state(): Promise<MachineState> {
    const listed = await this.run(['machine', 'ls', '--json'], { timeoutMs: TIMEOUTS.short });
    if (listed.exitCode !== 0) {
      throw new SmolvmMachineError('machine ls', `smolvm machine ls --json exited ${listed.exitCode}: ${listed.stderr.trim() || listed.stdout.trim() || '(no output)'}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(listed.stdout.trim() || '[]'); }
    catch (err) { throw new SmolvmMachineError('machine ls', `cannot read smolvm machine ls --json output: ${(err as Error).message}`); }
    const rows = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' ? ((parsed as Record<string, unknown>).machines ?? (parsed as Record<string, unknown>).items ?? []) : [];
    const row = (Array.isArray(rows) ? rows : []).find((r): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as Record<string, unknown>).name === this.name);
    if (!row) return 'absent';
    const state = String(row.state ?? row.status ?? '').toLowerCase();
    return state.includes('run') ? 'running' : 'stopped';
  }

  /**
   * `machine start` returns before the guest takes an exec, so poll `true`
   * until it does (the same wait Teams' supervisor makes, await_exec_ready).
   */
  async awaitExecReady(timeoutMs = TIMEOUTS.start, intervalMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: SmolvmResult | null = null;
    for (;;) {
      last = await this.run(['machine', 'exec', '--name', this.name, '--', 'true'], { timeoutMs: TIMEOUTS.short });
      if (last.exitCode === 0) return;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SmolvmMachineError('machine start', `${this.name} did not accept an exec within ${Math.round(timeoutMs / 1000)}s of starting; smolvm's last answer: ${(last?.stderr.trim() || last?.stdout.trim() || '(no output)')}`);
  }

  /**
   * Bring up the guest's dockerd the way every lazy machine does. `ensure`
   * (`lazy-guest-init --ensure`) does nothing when this boot is already
   * prepared and dockerd answers — the mode for a machine that is KEPT, whose
   * running containers a `--force` must not disturb.
   */
  async startDockerd(mode: 'force' | 'ensure' = 'force'): Promise<void> {
    if (mode === 'force') this.say('starting the machine\'s Docker engine (lazy-guest-init)');
    await this.must('start dockerd', ['machine', 'exec', '--name', this.name, '--', 'lazy-guest-init', `--${mode}`], TIMEOUTS.dockerd);
    await this.must('start dockerd', ['machine', 'exec', '--name', this.name, '--', 'docker', 'version', '--format', '{{.Server.Version}}'], TIMEOUTS.short);
  }

  /** Run a command in the guest; a non-zero exit fails `step`. */
  exec(step: string, argv: string[], timeoutMs: number, onLine?: (line: string) => void): Promise<SmolvmResult> {
    return this.must(step, ['machine', 'exec', '--name', this.name, '--', ...argv], timeoutMs, onLine);
  }

  /**
   * Stop dockerd gracefully, stop and delete the machine. Best-effort per step
   * (a machine that never booted has nothing to stop), but a delete that fails
   * is reported: a leftover machine holds its disk.
   */
  async remove(opts: { quiet?: boolean } = {}): Promise<void> {
    const listed = await this.run(['machine', 'ls', '--json'], { timeoutMs: TIMEOUTS.short });
    if (listed.exitCode === 0 && !listed.stdout.includes(`"${this.name}"`)) return;
    if (!opts.quiet) this.say(`removing machine ${this.name}`);
    await this.run(['machine', 'exec', '--name', this.name, '--', 'lazy-guest-init', '--stop-docker'], { timeoutMs: TIMEOUTS.dockerd });
    await this.run(['machine', 'stop', '--name', this.name], { timeoutMs: TIMEOUTS.start });
    const deleted = await this.run(['machine', 'delete', '--name', this.name, '--force'], { timeoutMs: TIMEOUTS.short });
    if (deleted.exitCode !== 0) {
      throw new SmolvmMachineError('machine delete', `could not delete ${this.name} (${deleted.stderr.trim() || deleted.stdout.trim()}); remove it with: smolvm machine delete --name ${this.name} --force`);
    }
  }
}
