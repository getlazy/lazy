/**
 * Which files lazy's containers may be mounting, across every container engine
 * on this host — the question agent-binary cleanup has to answer before it
 * deletes anything.
 *
 * `~/.lazy/bin` is per USER, shared by every project: a binary there may be
 * mounted by a container on the host's own engine OR on any project's solo
 * smolvm machine. So the answer is the union over:
 *
 *   - the host's engine (`docker`), exactly as before smolvm existed: one that
 *     does not answer is unknown. (Reading "cannot connect" as "no containers"
 *     would be tempting on a smolvm-only Mac, but a podman project's containers
 *     are not asked at all, and an unanswered docker is what keeps cleanup off
 *     their binaries today.)
 *   - every smolvm machine lazy recorded creating (`~/.lazy/smolvm/<m>/machine.json`):
 *     asked `smolvm machine ls` FIRST, changing nothing. A machine that is gone
 *     (a stale record) or stopped runs no container and holds nothing. A
 *     running one is asked directly with `smolvm machine exec -- docker`.
 *     Nothing here starts, creates or touches a machine.
 *
 * Any engine that cannot be asked makes the whole answer UNKNOWN (null), and an
 * unknown answer never deletes: asking only the host would hear "nothing in
 * use" while a guest container still mounts the file.
 *
 * Dependency-light on purpose: src/capture/claude.ts reads it, and the runner
 * imports claude.ts.
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { getHome } from '../utils/home';
import { listContainerMountSources } from '../agent/binary-install';
import { verifySmolvmBinary } from './smolvm-release';
import { SMOLVM_ENV, SmolvmDockerMachine, smolvmCliRunner, type MachineState } from './smolvm-docker-machine';

/** `~/.lazy/smolvm`: machine records, lifecycle locks, shims. Host-only; never shared into a guest. */
export function smolvmStateRoot(): string {
  return join(getHome(), '.lazy', 'smolvm');
}

/** Machine name → the smolvm launcher this process drives it with (for records that do not name one). */
const engines = new Map<string, string>();

export function registerSmolvmEngine(machine: string, smolvmBinary: string): void {
  if (smolvmBinary) engines.set(machine, smolvmBinary);
}

interface RecordedMachine { name: string; smolvmBinary: string | null }

/** Machines lazy recorded creating. A record that cannot be read makes the answer unknown. */
async function recordedMachines(stateRoot: string): Promise<RecordedMachine[] | null> {
  let names: string[];
  try { names = await readdir(stateRoot); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: RecordedMachine[] = [];
  for (const name of names) {
    let text: string;
    try { text = await readFile(join(stateRoot, name, 'machine.json'), 'utf8'); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return null;
    }
    try {
      const record = JSON.parse(text) as { smolvmBinary?: unknown };
      out.push({ name, smolvmBinary: typeof record.smolvmBinary === 'string' ? record.smolvmBinary : null });
    } catch { return null; } // an unreadable record: which engine it names is unknown
  }
  return out;
}

export interface MountSourceDeps {
  ambient?: string;
  stateRoot?: string;
  registered?: ReadonlyMap<string, string>;
  /** `<prefix> ps` / `<prefix> inspect` mount sources; null = no answer. */
  list?: (prefix: string[]) => Promise<string[] | null>;
  machineState?: (smolvm: string, machine: string) => Promise<MachineState>;
  /** The smolvm pin check; a launcher that fails it is never run. */
  verify?: (smolvm: string) => Promise<unknown>;
}

function listedState(smolvm: string, machine: string): Promise<MachineState> {
  return new SmolvmDockerMachine(smolvmCliRunner(smolvm), {
    name: machine, image: '', cpus: 1, memoryMib: 1, storageGib: 1, allowCidrs: [], volumes: [],
  }, () => {}).state();
}

/** `smolvm machine exec … -- docker`, with lazy's smolvm environment. */
export function guestDockerPrefix(smolvm: string, machine: string): string[] {
  return ['env', ...Object.entries(SMOLVM_ENV).map(([k, v]) => `${k}=${v}`), smolvm, 'machine', 'exec', '--name', machine, '--', 'docker'];
}

/** Every mount source of every running lazy container on this host, or null when any engine cannot be asked. */
export async function agentBinaryMountSources(deps: MountSourceDeps = {}): Promise<string[] | null> {
  const ambient = deps.ambient ?? 'docker';
  const list = deps.list ?? ((prefix) => listContainerMountSources(prefix));
  const all: string[] = [];

  const host = await list([ambient]);
  if (host === null) return null;
  all.push(...host);

  const machines = await recordedMachines(deps.stateRoot ?? smolvmStateRoot());
  if (machines === null) return null;
  for (const m of machines) {
    const smolvm = m.smolvmBinary ?? (deps.registered ?? engines).get(m.name);
    if (!smolvm) return null;
    // Never run an unverified smolvm: one that fails the pin cannot be asked, so the answer is unknown.
    try { await (deps.verify ?? ((b: string) => verifySmolvmBinary(b)))(smolvm); }
    catch { return null; }
    let state: MachineState;
    try { state = await (deps.machineState ?? listedState)(smolvm, m.name); }
    catch { return null; } // smolvm could not list its machines: unknown
    // Gone (a stale record) or stopped: no container in it runs, so it mounts nothing.
    if (state !== 'running') continue;
    const guest = await list(guestDockerPrefix(smolvm, m.name));
    if (guest === null) return null;
    all.push(...guest);
  }
  return all;
}
