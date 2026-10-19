/**
 * `lazy system machine` — what the project's machine is doing: its services
 * (container runtime, port forwarder, project daemon, task proxy), each one's
 * recent log, and CPU, memory and disk use (src/daemon/machine-observation.ts).
 *
 * A client only: every answer, and every rule behind it, is the daemon's. Logs
 * arrive already redacted.
 */
import { parseFlags } from '../helpers';
import { isTTY, promptYesNo } from '../editor';
import { theme } from '../../render/theme';
import { queryMachineState, queryResetMachineDockerStorage } from '../../daemon/rpc-fallback';

interface ServiceAnswer {
  label: string;
  state: string;
  detail: string | null;
  log: { available: boolean; source: string | null; lines: string[] };
  /** dockerd on a Lazy Teams machine: why it restarted. Absent from an older daemon. */
  history?: { available: boolean; source: string | null; lines: string[] } | null;
  escalation: { to: string; summary: string } | null;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export async function commandSystemMachine(args: string[]): Promise<void> {
  if (args[0] === 'reset-docker-storage') return commandResetDockerStorage(args.slice(1));
  const parsed = parseFlags(args, [
    { name: 'json', takesValue: false },
    { name: 'logs', takesValue: false },
    { name: 'lines', takesValue: true },
  ], 'system machine');
  const linesFlag = parsed.flags.get('lines');
  const lines = typeof linesFlag === 'string' ? Number.parseInt(linesFlag, 10) : undefined;
  if (lines !== undefined && !Number.isFinite(lines)) {
    console.error(`Error: --lines takes a number, got "${linesFlag}".`);
    process.exit(1);
  }
  const showLogs = parsed.flags.get('logs') === true;
  try {
    const answer = await queryMachineState({ lines: showLogs ? lines ?? 20 : lines ?? 0 }) as {
      kind: string; hostname: string;
      services: ServiceAnswer[];
      resources: {
        cpu: { cores: number; load1: number };
        memory: { totalBytes: number; availableBytes: number; usedPercent: number };
        disks: Array<{ label: string; path: string; totalBytes: number; freeBytes: number; usedPercent: number }>;
        warnings: Array<{ message: string }>;
      } | null;
      resourcesWithheld?: string | null;
    };
    if (parsed.flags.get('json') === true) {
      console.log(JSON.stringify(answer, null, 2));
      return;
    }
    console.log(answer.hostname ? `${answer.hostname} (${answer.kind})` : answer.kind);
    console.log('');
    for (const s of answer.services) {
      const state = s.state === 'running' ? theme.success(s.state) : s.state === 'not_applicable' ? s.state : theme.error(s.state);
      console.log(`  ${s.label}: ${state}${s.detail ? ` — ${s.detail}` : ''}`);
      if (s.escalation) console.log(`    ${theme.warning(s.escalation.summary)} (${s.escalation.to === 'maintainer' ? 'for your maintainer' : 'yours to fix'})`);
      if (showLogs && s.log.available) {
        for (const l of s.log.lines) console.log(`    | ${l}`);
      }
      if (showLogs && s.history?.available && s.history.lines.length > 0) {
        console.log('    Restart history:');
        for (const l of s.history.lines) console.log(`    | ${l}`);
      }
    }
    const r = answer.resources;
    console.log('');
    if (!r) {
      console.log(`  ${answer.resourcesWithheld ?? 'Resource use is not reported for this machine.'}`);
      return;
    }
    console.log(`  CPU: ${r.cpu.cores} cores, load ${r.cpu.load1.toFixed(2)}`);
    console.log(`  Memory: ${r.memory.usedPercent}% used of ${gib(r.memory.totalBytes)}`);
    for (const d of r.disks) console.log(`  Disk (${d.label}, ${d.path}): ${d.usedPercent}% used of ${gib(d.totalBytes)}`);
    for (const w of r.warnings) console.log(`  ${theme.warning(w.message)}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export function systemMachineUsage(): void {
  console.log(`Usage: lazy system machine [--logs] [--lines <n>] [--json]
       lazy system machine reset-docker-storage [--yes]

What the project's machine is doing: the container runtime, the port
forwarder (Lazy Teams machines only), the project daemon and its task proxy,
and CPU, memory and disk use. Read-only. Logs are redacted by the daemon.

  --logs        Also print each service's recent log (and dockerd's restart
                history on a Lazy Teams machine)
  --lines <n>   How many log lines per service (default 20 with --logs)
  --json        Machine-readable output, logs included

reset-docker-storage  Empty this machine's Docker storage safely (Lazy Teams
                microVMs only): holds dockerd recovery off, stops dockerd and
                containerd, unmounts everything under the data root, removes it
                without crossing mounts, starts dockerd again, narrating each step.
                DELETES every image, container, volume and build cache; builds
                are cold afterwards. Asks first; --yes skips the question.`);
}

interface StorageResetAnswer { state: string; steps: string[]; freedKb: number | null; failure: string | null }

/**
 * `lazy system machine reset-docker-storage` — the operator's route to the same
 * action as the Machine page. Destructive, so it asks first (`--yes` skips it);
 * the daemon does the work and this prints each step as it happens.
 */
async function commandResetDockerStorage(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [{ name: 'yes', takesValue: false }], 'system machine reset-docker-storage');
  if (parsed.flags.get('yes') !== true) {
    if (!isTTY()) {
      console.error('Error: resetting Docker storage needs --yes when there is no terminal to confirm at.');
      process.exit(1);
    }
    console.log(theme.warning('This deletes every image, container, volume and build cache on this machine, and stops everything running in Docker.'));
    console.log('Builds and task starts are cold afterwards: images are pulled and layers rebuilt.');
    if (!await promptYesNo('Reset this machine\'s Docker storage?', false)) {
      console.log('Not reset.');
      return;
    }
  }
  try {
    await queryResetMachineDockerStorage({ confirm: true });
    let shown = 0;
    for (;;) {
      await new Promise(r => setTimeout(r, 1000));
      const answer = await queryMachineState({ lines: 0 }) as { storageReset?: StorageResetAnswer | null };
      const reset = answer.storageReset;
      if (!reset) throw new Error('the daemon stopped reporting the reset; run `lazy system machine` to see where it stands.');
      for (const step of reset.steps.slice(shown)) console.log(`  ${step}`);
      shown = reset.steps.length;
      if (reset.state === 'running') continue;
      if (reset.state === 'failed') {
        console.error(theme.error(`Reset failed: ${reset.failure ?? 'see the steps above'}`));
        process.exit(1);
      }
      if (reset.freedKb !== null) console.log(`Freed ${gib(reset.freedKb * 1024)}.`);
      return;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
