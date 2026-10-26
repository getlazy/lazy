import { hardwareTestEnv } from './hardware-env';
import { builderMachineName } from '../../src/vm/smolvm-image-build';
import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

/** Keeps ownership outside the test callback, which Bun abandons on timeout. */
export class HardwareImageBuild {
  private proc: ReturnType<typeof Bun.spawn> | undefined;
  private outputDrained: Promise<void> | undefined;
  private managed = false;
  private readonly unsavedOutput: Record<string, string[]> = {};

  constructor(private readonly binary: string, private readonly output: string) {}

  async run(argv: string[], env: Record<string, string | undefined> = hardwareTestEnv()): Promise<number> {
    this.proc = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit', env });
    return await this.proc.exited;
  }

  /** Defer domain cleanup so even build/verification failures reach afterEach intact. */
  async runManaged(argv: string[], env: Record<string, string | undefined> = hardwareTestEnv()): Promise<number> {
    this.managed = true;
    await rm(this.evidenceDir, { recursive: true, force: true });
    await mkdir(this.evidenceDir, { recursive: true, mode: 0o700 });
    await Promise.all(['stdout.log', 'stderr.log'].map(name => writeFile(join(this.evidenceDir, name), '', { mode: 0o600 })));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'smolvm-image-build-worker.ts'), this.binary,
      join(this.evidenceDir, 'plan.json'), ...argv], { env, stdout: 'pipe', stderr: 'pipe', detached: true });
    this.proc = proc;
    const copy = async (stream: ReadableStream<Uint8Array>, name: string, out: NodeJS.WriteStream) => {
      for await (const chunk of stream) {
        // Keep draining even if disk writes fail: a full pipe must not wedge
        // the builder. Retain those bytes in memory for the final report.
        try { await appendFile(join(this.evidenceDir, name), chunk, { mode: 0o600 }); }
        catch (err) { (this.unsavedOutput[name] ??= []).push(`${String(err)}\n${Buffer.from(chunk).toString()}`); }
        out.write(chunk);
      }
    };
    this.outputDrained = Promise.all([
      copy(proc.stdout, 'stdout.log', process.stdout), copy(proc.stderr, 'stderr.log', process.stderr),
    ]).then(() => {});
    // Store the rejection until afterEach too, if Bun abandons this callback.
    void this.outputDrained.catch(err => console.error(`image build log capture failed: ${String(err)}`));
    const code = await this.proc.exited;
    await this.outputDrained;
    if (code === 0) await this.removeBuilder();
    return code;
  }

  get evidenceDir(): string { return `${this.output}.e2e`; }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const signalGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-proc.pid, signal); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; }
    };
    // A timed-out Bun callback can lose its worker while descendants are
    // still creating machines or holding its output pipes. Reap the group.
    if (this.managed) signalGroup('SIGTERM');
    else if (proc.exitCode === null) proc.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([proc.exited, this.outputDrained]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (this.managed) signalGroup('SIGKILL');
      else if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    await proc.exited;
    await this.outputDrained;
  }

  async capture(): Promise<Record<string, unknown>> {
    await this.stop();
    const probe = async (args: string[]) => {
      const proc = Bun.spawn([this.binary, ...args], { env: hardwareTestEnv(), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const name = builderMachineName(this.output);
    const tasks: Record<string, () => Promise<unknown>> = {
      context: async () => ({ machine: name, work: `${this.output}.build.d`, evidence: this.evidenceDir, unsavedOutput: this.unsavedOutput }),
      machines: () => probe(['machine', 'ls', '--json']),
      guest: () => probe(['machine', 'exec', '--name', name, '--', 'sh', '-c',
        'docker ps -a --no-trunc; for c in $(docker ps -aq); do docker inspect "$c"; docker logs --timestamps --tail 500 "$c"; done; dmesg | tail -n 100; for f in /var/log/lazy-dockerd.log /var/log/lazy-dockerd-restarts.log /var/log/lazy-forwarder.log; do echo "$f"; tail -n 100 "$f"; done']),
    };
    for (const file of ['plan.json', 'stdout.log', 'stderr.log']) tasks[file] = () => readFile(join(this.evidenceDir, file), 'utf8');
    return Object.fromEntries(await Promise.all(Object.entries(tasks).map(async ([key, read]) => {
      try { return [key, await read()]; }
      catch (err) { return [key, { diagnosticError: String(err) }]; }
    })));
  }

  private async removeBuilder(): Promise<void> {
    // Bun itself SIGKILLs dangling children on test timeout, bypassing shell
    // traps. Delete our exact builder even when its wrapper already died.
    const name = builderMachineName(this.output);
    const list = Bun.spawn([this.binary, 'machine', 'ls', '--json'], { env: hardwareTestEnv(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
    const [out, err, code] = await Promise.all([new Response(list.stdout).text(), new Response(list.stderr).text(), list.exited]);
    if (code !== 0) throw new Error(`could not check builder ${name}: ${err}`);
    const parsed = JSON.parse(out.trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : (parsed.machines ?? parsed.items ?? []);
    if (rows.some((row: { name?: string }) => row.name === name)) {
      const remove = Bun.spawn([this.binary, 'machine', 'delete', '--name', name, '--force'], { env: hardwareTestEnv(), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
      const [stdout, stderr, deleted] = await Promise.all([new Response(remove.stdout).text(), new Response(remove.stderr).text(), remove.exited]);
      if (deleted !== 0) throw new Error(`could not remove builder ${name}: ${stderr || stdout}`);
    }
    if (this.managed) await rm(`${this.output}.build.d`, { recursive: true, force: true });
  }

  async cleanup(options?: { preserveFiles?: boolean }): Promise<void> {
    if (!this.proc) return;
    try {
      await this.stop();
      if (options?.preserveFiles) return;
      await this.removeBuilder();
      if (this.managed) await rm(this.evidenceDir, { recursive: true, force: true });
    } finally {
      this.proc = undefined;
    }
  }
}
