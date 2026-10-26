import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { builderMachineName } from '../../src/vm/smolvm-image-build';

// INVARIANT: Bun timeout cleanup bypasses shell traps, but the suite's
// afterEach must still delete its own builder, including before project setup.
test('afterEach removes only its builder after an actual Bun test timeout', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-timeout-')));
  const output = join(root, 'image.tar');
  const name = builderMachineName(output);
  const machine = join(root, name);
  const unrelated = join(root, 'unrelated-machine');
  const calls = join(root, 'calls');
  try {
    await writeFile(unrelated, 'keep');
    const build = join(root, 'build');
    await writeFile(build, '#!/bin/bash\ntouch "$MACHINE"\nexec sleep 30\n');
    const smolvm = join(root, 'smolvm');
    await writeFile(smolvm, `#!/bin/bash
if [[ "$2" == ls ]]; then
  printf '[{"name":"%s"},{"name":"unrelated-machine"}]' "$NAME"
elif [[ "$2" == delete && "$4" == "$NAME" ]]; then
  printf '%s\\n' "$*" >> "$CALLS"
  rm -f "$MACHINE"
else
  echo "unexpected command: $*" >&2; exit 1
fi
`);
    await Promise.all([chmod(build, 0o755), chmod(smolvm, 0o755)]);
    const fixture = join(root, 'timeout.test.ts');
    await writeFile(fixture, `
import { afterEach, test } from 'bun:test';
import { HardwareImageBuild } from ${JSON.stringify(resolve(import.meta.dir, '../helpers/smolvm-image-build.ts'))};
const build = new HardwareImageBuild(${JSON.stringify(smolvm)}, ${JSON.stringify(output)});
afterEach(async () => { await build.cleanup(); }, 5000);
test('deliberate build timeout', async () => {
  await build.run([${JSON.stringify(build)}]);
}, 1000);
`);
    const proc = Bun.spawn([process.execPath, 'test', fixture], {
      cwd: root,
      env: { ...process.env, MACHINE: machine, NAME: name, CALLS: calls },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stdout + stderr).toContain('timed out after 1000ms');
    expect(await Bun.file(machine).exists()).toBe(false);
    expect(await readFile(calls, 'utf8')).toBe(`machine delete --name ${name} --force\n`);
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
