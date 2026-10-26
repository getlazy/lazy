import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { shellQuote } from '../../src/utils/shell-quote';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  assertAgentBinarySelfcheckForImage, verifyAgentBinarySelfcheckInContainer,
} from '../../src/agent/binary-identity';

let root: string;
let docker: FakeDocker;
let guestRoot: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'image-agent-probe-')));
  docker = await installFakeDocker(root);
  guestRoot = join(root, 'guest');
  await mkdir(guestRoot);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const probe = (path = join(root, 'agent')) => verifyAgentBinarySelfcheckInContainer(path, {
  containerImage: 'lazy-runner:test', dockerBinary: docker.binPath,
});

const agentScript = '[ "$1" = selfcheck ] || exit 2\nprintf "lazy-agent ok from guest\\n"\n';
async function useGuestRuntime() {
  const fixture = join(import.meta.dir, '../fixtures/docker-selfcheck-runtime.ts');
  await docker.onRun(`exec ${shellQuote(process.execPath)} ${shellQuote(fixture)} ${shellQuote(guestRoot)} "$@"`);
}

describe('agent selfcheck on the container engine', () => {
  // INVARIANT: host file existence does not prove a remote engine sees a bind
  // source. Docker must refuse a missing source rather than create a directory.
  test('a file present on the host but absent in the guest is a bind-source failure', async () => {
    const binary = join(root, 'agent');
    await writeFile(binary, agentScript);
    await useGuestRuntime();
    const verdict = await probe(binary);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('bind source path does not exist in the guest');
    expect(verdict.reason).toContain(binary);
    expect(await readFile(binary, 'utf8')).toBe(agentScript);
    const guestBinary = join(guestRoot, binary);
    await expect(stat(guestBinary)).rejects.toMatchObject({ code: 'ENOENT' });

    // The identical Docker argv succeeds once the guest can see the file.
    await mkdir(dirname(guestBinary), { recursive: true });
    await copyFile(binary, guestBinary);
    expect(await probe(binary)).toEqual({ ok: true });

    // Reproduce the old short-volume behavior against that same guest tree.
    await rm(guestBinary);
    const oldRun = Bun.spawn([docker.binPath, 'run', '--rm', '--network', 'none',
      '-v', `${binary}:/usr/local/bin/lazy-agent:ro`,
      '--entrypoint', '/usr/local/bin/lazy-agent', 'lazy-runner:test', 'selfcheck'],
    { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, code] = await Promise.all([new Response(oldRun.stderr).text(), oldRun.exited]);
    expect(code).toBe(126);
    expect(stderr).toContain('is a directory');
    expect((await stat(guestBinary)).isDirectory()).toBe(true);
  });

  test.each(['agent', 'agent,with"quotes'])('executes the guest file at %s', async (name) => {
    const binary = join(root, name);
    await writeFile(binary, 'exit 42\n'); // A host exec must not supply the sentinel.
    const guestBinary = join(guestRoot, binary);
    await mkdir(dirname(guestBinary), { recursive: true });
    await writeFile(guestBinary, agentScript);
    await useGuestRuntime();
    expect(await probe(binary)).toEqual({ ok: true });
    const [run] = await docker.invocations();
    expect(run).toContain('--network none');
    expect(run).toContain('--entrypoint /usr/local/bin/lazy-agent');
    expect(run).toContain('lazy-runner:test selfcheck');
  });

  test('empty successful output includes stderr and does not diagnose a broken binary', async () => {
    const binary = join(root, 'agent');
    await writeFile(binary, Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2048), Buffer.from('lazy-agent ok'),
    ]));
    await docker.onRun(`echo 'guest transport diagnostic' >&2; exit 0`);
    await expect(assertAgentBinarySelfcheckForImage('lazy-runner:test', binary, docker.binPath))
      .rejects.toThrow(/stdout: <empty>, stderr: guest transport diagnostic/);
    const verdict = await probe(binary);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('execution and output capture could not be verified');
  });

  // INVARIANT: an image check must reach its engine even on Linux. A working
  // host binary cannot establish that a VM's dockerd can mount or execute it.
  test('the image gate probes the engine even for an executable host agent', async () => {
    const source = join(root, 'agent.ts');
    const hostAgent = join(root, 'compiled-agent');
    await writeFile(source, "console.log('lazy-agent ok');\n");
    const build = Bun.spawn([process.execPath, 'build', '--compile',
      `--target=bun-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      source, '--outfile', hostAgent], { stdout: 'pipe', stderr: 'pipe' });
    const [output, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
    expect(code, output).toBe(0);
    await docker.onRun(`echo 'engine cannot mount the source' >&2; exit 125`);
    await expect(assertAgentBinarySelfcheckForImage('lazy-runner:test', hostAgent, docker.binPath))
      .rejects.toThrow('engine cannot mount the source');
    expect((await docker.invocations()).filter((line) => line.startsWith('run '))).toHaveLength(1);
  });
});
