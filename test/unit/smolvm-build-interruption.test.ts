import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { builderMachineName } from '../../src/vm/smolvm-image-build';

// INVARIANT: interrupting an image build removes only that output's builder,
// after stopping its build process group, including foreground descendants.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`image build cleans its own builder on ${signal}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'builder-interrupt-')));
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const calls = join(root, 'calls');
      const ready = join(root, 'ready');
      const heartbeat = join(root, 'heartbeat');
      const script = async (name: string, body: string) => {
        await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
        await chmod(join(bin, name), 0o755);
      };
      await script('bun', `if [[ "$*" == *--print-builder-image* ]]; then echo example:builder; exit 0; fi\nprintf ready > "$READY"\nwhile :; do echo tick >> "$HEARTBEAT"; sleep 0.05; done`);
      await script('smolvm', 'printf "%s\\n" "$*" >> "$CALLS"');
      await writeFile(join(root, 'lazy-image-builder-builder.tar'), 'cached builder');
      const output = join(root, 'output with spaces.tar');
      proc = Bun.spawn(['bash', resolve(import.meta.dir, '../../lazy-teams/bin/smolvm-build-daemon-image'),
        '--smolvm', join(bin, 'smolvm'), '--platform', 'linux/arm64', '--fleet-root', root, output], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, READY: ready, HEARTBEAT: heartbeat },
        stdout: 'pipe', stderr: 'pipe',
      });
      const deadline = Date.now() + 5_000;
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() > deadline) throw new Error('build did not start');
        await Bun.sleep(20);
      }
      proc.kill(signal);
      expect(await proc.exited).toBe(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129);
      expect((await readFile(calls, 'utf8')).trim()).toBe(`machine delete --name ${builderMachineName(output)} --force`);
      const stopped = await readFile(heartbeat, 'utf8');
      await Bun.sleep(150);
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
    } finally {
      if (proc && proc.exitCode === null) { proc.kill(); await proc.exited; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
