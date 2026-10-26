import { test, expect } from 'bun:test';
import { createSocket } from 'node:dgram';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkHostname, queryNetworkDns } from '../../src/daemon/machine-network';

test('network checks accept only a hostname, never a URL, IP, port, path or shell input', () => {
  expect(networkHostname('SH.RUSTUP.RS.')).toBe('sh.rustup.rs');
  expect(networkHostname(undefined)).toBeUndefined();
  for (const value of ['https://sh.rustup.rs', '127.0.0.1', '[::1]', 'host:53', 'name/path', 'name;id', '-x.example', 'x..com', {}, ['a.com']]) {
    expect(() => networkHostname(value)).toThrow('Enter a hostname');
  }
});

// INVARIANT: an unreadable workload inventory must refuse a restart preview,
// never masquerade as an idle machine whose in-memory work can be discarded.
test('restart inventory reads Docker output and refuses failures or incomplete details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-network-docker-'));
  try {
    await writeFile(join(dir, 'docker'), '#!/bin/sh\ncat "$NETWORK_DOCKER_OUTPUT"\nexit "$NETWORK_DOCKER_EXIT"\n', { mode: 0o755 });
    const output = join(dir, 'output');
    const modulePath = new URL('../../src/daemon/machine-network.ts', import.meta.url).href;
    const row = { ID: 'container-id', Names: 'task-shell', Image: 'runner:test', Status: 'Up 1 minute' };
    for (const sample of [
      { output: JSON.stringify(row), exit: '0', error: null },
      { output: '', exit: '0', error: null },
      { output: '', exit: '1', error: 'docker ps exited 1' },
      { output: 'not-json', exit: '0', error: 'invalid JSON' },
      { output: '{"ID":"missing-details"}', exit: '0', error: 'omitted container details' },
    ]) {
      await writeFile(output, sample.output);
      const child = Bun.spawn([process.execPath, '--eval', `import { machineRestartPreview } from ${JSON.stringify(modulePath)}; try { console.log(JSON.stringify(await machineRestartPreview())); } catch (error) { console.error(error.message); process.exitCode = 1; }`], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETWORK_DOCKER_OUTPUT: output, NETWORK_DOCKER_EXIT: sample.exit },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (sample.error) {
        expect(exit).toBe(1);
        expect(stderr).toContain(sample.error);
        expect(stderr).toContain('Nothing has been restarted');
      } else {
        expect(exit).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.containers).toEqual(sample.output ? [{ id: row.ID, name: row.Names, image: row.Image, state: row.Status }] : []);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// INVARIANT: a DNS failure is evidence in the result, never a successful empty
// lookup. IPv4 and IPv6 have separate outcomes so an absent AAAA does not hide A.
test('a real DNS server can answer A while AAAA or a different hostname fails', async () => {
  const socket = createSocket('udp4');
  socket.on('message', (query, peer) => {
    let end = 12;
    while (query[end]) end += query[end] + 1;
    const qtype = query.readUInt16BE(end + 1);
    const missing = query.subarray(12, end).includes(Buffer.from('missing'));
    end += 5;
    const answer = !missing && qtype === 1;
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(missing ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answer ? 1 : 0, 6);
    const record = answer ? Buffer.from('c00c000100010000003c00045db8d822', 'hex') : Buffer.alloc(0);
    socket.send(Buffer.concat([header, query.subarray(12, end), record]), peer.port, peer.address);
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  try {
    const port = (socket.address() as { port: number }).port;
    const results = await queryNetworkDns([`127.0.0.1:${port}`], ['works.example', 'missing.example']);
    expect(results[0].ok).toBe(true);
    expect(results[0].answer).toEqual(['93.184.216.34']);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toMatch(/ENODATA|ENOTFOUND/);
    expect(results[2].ok).toBe(false);
    expect(results[2].error).toContain('ENOTFOUND');
    expect(results.every(row => row.elapsedMs >= 0)).toBe(true);
  } finally {
    socket.close();
  }
});
