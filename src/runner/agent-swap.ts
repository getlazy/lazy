/**
 * Moving a KEPT task container onto a new agent binary, for `lazy upgrade`.
 *
 * Every container bind-mounts one content-addressed agent binary, read-only,
 * for its whole life (src/agent/binary-install.ts) — nothing may ever write to
 * a path a container mounts. So an upgrade that keeps a container copies the
 * new binary INTO the container's own filesystem instead, at
 * {@link UPGRADED_AGENT_PATH}, and the wrapper runs that file for every
 * supervisor it starts from then on. The copy lands under a temporary name and
 * is renamed inside the container, so the wrapper never sees half a file.
 *
 * Only a container whose wrapper knows the path carries {@link AGENT_SWAP_LABEL};
 * an older one would keep running the old supervisor (which refuses every
 * command after a protocol change), so upgrade stops and removes it instead.
 */
import { spawn } from '../utils/spawn';

export const AGENT_SWAP_LABEL = 'lazy.agent-swap';
export const UPGRADED_AGENT_PATH = '/tmp/lazy-agent-upgraded';

const TIMEOUT_MS = 120_000;

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = spawn(args, { stdout: 'pipe', stderr: 'pipe', timeout: TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

/** True when the container's wrapper runs a copied-in agent binary. */
export async function supportsAgentSwap(binary: string, runName: string): Promise<boolean> {
  const r = await run([binary, 'inspect', '--format', `{{index .Config.Labels "${AGENT_SWAP_LABEL}"}}`, runName]);
  return r.code === 0 && r.out === '1';
}

/** Copy the agent binary into a running container. Throws with the runtime's reason. */
export async function swapAgentBinary(binary: string, runName: string, agentBinaryPath: string): Promise<void> {
  const tmp = `${UPGRADED_AGENT_PATH}.new`;
  const cp = await run([binary, 'cp', agentBinaryPath, `${runName}:${tmp}`]);
  if (cp.code !== 0) throw new Error(`could not copy the agent binary into ${runName}: ${cp.err || `exit ${cp.code}`}`);
  const mv = await run([binary, 'exec', runName, 'sh', '-c', `chmod 755 ${tmp} && mv -f ${tmp} ${UPGRADED_AGENT_PATH}`]);
  if (mv.code !== 0) throw new Error(`could not install the agent binary in ${runName}: ${mv.err || `exit ${mv.code}`}`);
}
