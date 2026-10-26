import { Resolver } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { spawn } from '../utils/spawn';

export const NETWORK_NAMES = ['sh.rustup.rs', 'static.rust-lang.org', 'deb.debian.org', 'docker.io'];
const TIMEOUT_MS = 3_000;

export function networkHostname(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 253 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value)) {
    throw new Error('Enter a hostname such as sh.rustup.rs, without a URL, port or path.');
  }
  return value.toLowerCase().replace(/\.$/, '');
}

async function measured(label: string, action: () => Promise<unknown>) {
  const started = performance.now();
  try {
    return { label, ok: true, answer: await action(), elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started) };
  }
}

function publicConnection(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => { socket.destroy(); resolve('Connected to 1.1.1.1:443 without DNS'); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Connection to 1.1.1.1:443 timed out')); });
    socket.once('error', reject);
  });
}

export async function queryNetworkDns(servers: string[], names: string[]) {
  const resolver = new Resolver({ timeout: 1_500, tries: 1 });
  resolver.setServers(servers);
  return Promise.all(names.flatMap(name => [
    measured(`${name} A`, () => resolver.resolve4(name)),
    measured(`${name} AAAA`, () => resolver.resolve6(name)),
  ]));
}

/** Runs in the guest, on the same resolver and egress policy as its dockerd. */
export async function checkMachineNetwork(hostname?: string) {
  const resolvConf = await readFile('/etc/resolv.conf', 'utf8');
  const servers = [...resolvConf.matchAll(/^\s*nameserver\s+(\S+)/gm)].map(match => match[1]);
  if (!servers.length) throw new Error('The machine has no nameserver in /etc/resolv.conf. Ask the installation maintainer to check its network.');
  const names = [...new Set([...NETWORK_NAMES, ...(hostname ? [hostname] : [])])];
  const observedAt = new Date().toISOString();
  const [dns, https, egress] = await Promise.all([
    queryNetworkDns(servers, names),
    Promise.all([...new Set(['sh.rustup.rs', ...(hostname ? [hostname] : [])])].map(name => measured(`https://${name}/`, async () => {
      const response = await fetch(`https://${name}/`, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      // An HTTP refusal still proves that DNS, TCP and TLS worked. Show its status.
      return `HTTP ${response.status}`;
    }))),
    measured('Public IP egress', publicConnection),
  ]);
  return { observedAt, resolvConf, servers, dns, https, egress };
}

/** Actual running containers, including task services, member shells and builders. */
export async function machineRestartPreview() {
  const result = spawn(['docker', 'ps', '--no-trunc', '--format', '{{json .}}'], { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (exit !== 0) throw new Error(`Could not read running containers: ${stderr.trim() || `docker ps exited ${exit}`}. Nothing has been restarted.`);
  const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); }
    catch (error) { throw new Error(`Could not read running containers: docker ps returned invalid JSON (${error instanceof Error ? error.message : String(error)}). Nothing has been restarted.`); }
    if (!row || ['ID', 'Names', 'Image', 'Status'].some(key => typeof row[key] !== 'string' || !row[key])) {
      throw new Error('Could not read running containers: docker ps omitted container details. Nothing has been restarted.');
    }
    return { id: row.ID as string, name: row.Names as string, image: row.Image as string, state: row.Status as string };
  });
  return { observedAt: new Date().toISOString(), containers };
}
