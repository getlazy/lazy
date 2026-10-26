import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { builderMachineName } from '../../src/vm/smolvm-image-build';
import { hardwareTestEnv } from '../helpers/hardware-env';

// INVARIANT: image setup fails before a TestContext exists. Its real builder
// must leave logs, work files and the machine available until afterEach saves
// evidence; KEEP applies to that machine too, including on a Bun timeout.
test('real image-build setup captures failures before deletion and honors KEEP', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sv-build-evidence-')));
  try {
    const checkout = join(root, 'checkout');
    const bin = join(root, 'bin');
    await Promise.all(['lazy-teams/bin', 'lazy-teams/app/clients', 'src/vm', 'scripts'].map(dir => mkdir(join(checkout, dir), { recursive: true })));
    await mkdir(bin);
    for (const file of ['lazy-teams/bin/smolvm-build-daemon-image', 'lazy-teams/app/clients/public_egress.rb', 'src/vm/smolvm-docker-machine.json']) {
      await copyFile(resolve(import.meta.dir, '../..', file), join(checkout, file));
    }
    const script = async (path: string, body: string) => {
      await writeFile(path, `#!/bin/bash\nset -eu\n${body}\n`);
      await chmod(path, 0o755);
    };
    // Only external boundaries are faked: fetching a pinned image, exporting
    // a small context, and the machine CLI. The shell handoff, worker, domain
    // builder, verifier, afterEach and evidence writer are production paths.
    await script(join(bin, 'bun'), `
test -z "\${LAZY_SHOULD_NOT_LEAK:-}"
if [[ "$FAULT" == prepare ]]; then echo 'prepare failed with evidence' >&2; exit 1; fi
[[ "$*" == *--print-builder-image* ]]
echo example:builder`);
    await writeFile(join(root, 'lazy-image-builder-builder.tar'), 'cached builder');
    await script(join(checkout, 'scripts/publish-lazy-daemon-image.sh'), `
mkdir -p "$2/context"
printf '%s\\n' --platform linux/arm64 > "$2/build-args"
printf '%s\\n' Dockerfile > "$2/dockerfile"
printf '%s\\n' example:test > "$2/image-ref"`);
    // A small valid image lets the success case use the real host verifier.
    const tarRoot = join(root, 'tar');
    const blob = Buffer.from('image bytes');
    const hex = createHash('sha256').update(blob).digest('hex');
    await mkdir(join(tarRoot, 'blobs/sha256'), { recursive: true });
    await writeFile(join(tarRoot, 'blobs/sha256', hex), blob);
    await writeFile(join(tarRoot, 'manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${hex}`, Layers: [`blobs/sha256/${hex}`] }]));
    const validTar = join(root, 'valid.tar');
    expect(await Bun.spawn(['tar', '-cf', validTar, '-C', tarRoot, '.'], { timeout: 5000 }).exited).toBe(0);
    const smolvm = join(bin, 'smolvm');
    await script(smolvm, `
test -z "\${LAZY_SHOULD_NOT_LEAK:-}"
case "$2" in
  ls)
    if [[ -f "$TARGET.machine" ]]; then printf '[{"name":"%s"},{"name":"unrelated"}]' "$NAME";
    else printf '[{"name":"unrelated"}]'; fi ;;
  create) touch "$TARGET.machine"; echo 'machine created' ;;
  start) echo 'machine started' ;;
  delete)
    [[ "$4" == "$NAME" ]]
    if [[ "$FAULT" != success ]]; then test -f "$REPORT/report.txt"; fi
    echo deleted >> "$TARGET.events"
    rm -f "$TARGET.machine" ;;
  exec)
    if [[ "$*" == *'sh -c'* ]]; then
      test -f "$TARGET.machine"
      echo snapshot >> "$TARGET.events"
      echo 'guest buildkit and dockerd evidence before deletion'
    elif [[ "$*" == *buildx* ]]; then
      echo 'builder stdout evidence'
      echo 'builder stderr evidence' >&2
      if [[ "$FAULT" == build ]]; then exit 42; fi
      if [[ "$FAULT" == timeout ]]; then
        while :; do echo tick >> "$TARGET.heartbeat"; sleep 0.05; done
      fi
    elif [[ "$*" == *'docker save'* ]]; then
      if [[ "$FAULT" == verify ]]; then echo corrupt > "$TARGET.build.d/out/image.tar";
      else cp "$VALID_TAR" "$TARGET.build.d/out/image.tar"; fi
    elif [[ "$*" == *source-fingerprint* ]]; then echo 0123456789abcdef;
    fi ;;
  *) echo "unexpected smolvm command: $*" >&2; exit 1 ;;
esac`);
    for (const keep of [false, true]) {
      const fixture = join(root, `fixture-${keep}.test.ts`);
      const base = join(root, String(keep));
      await mkdir(base);
      await writeFile(fixture, `
import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { HardwareImageBuild } from ${JSON.stringify(resolve(import.meta.dir, '../helpers/smolvm-image-build.ts'))};
import { finishSmolvmHardwareTest, saveSmolvmFailureEvidence } from ${JSON.stringify(resolve(import.meta.dir, '../helpers/smolvm-failure-evidence.ts'))};
import { builderMachineName } from ${JSON.stringify(resolve(import.meta.dir, '../../src/vm/smolvm-image-build.ts'))};
let build; let succeeded = false;
afterEach(async () => {
  await finishSmolvmHardwareTest({
    succeeded, keepOnFailure: ${keep},
    capture: () => saveSmolvmFailureEvidence(process.env.REPORT, { imageBuild: () => build.capture() }),
    cleanup: retained => build.cleanup({ preserveFiles: retained }),
  });
}, 20000);
for (const fault of ['prepare', 'build', 'verify', 'timeout', 'success']) {
  test(fault, async () => {
    succeeded = false;
    const output = ${JSON.stringify(base)} + '/' + fault + '.tar';
    Object.assign(process.env, { FAULT: fault, TARGET: output, REPORT: output + '.report', NAME: builderMachineName(output), LAZY_SHOULD_NOT_LEAK: 'poison' });
    build = new HardwareImageBuild(${JSON.stringify(smolvm)}, output);
    const code = await build.runManaged([${JSON.stringify(join(checkout, 'lazy-teams/bin/smolvm-build-daemon-image'))},
      '--smolvm', ${JSON.stringify(smolvm)}, '--platform', 'linux/arm64', '--fleet-root', ${JSON.stringify(root)}, output]);
    expect(code).toBe(0);
    expect(fault).toBe('success');
    succeeded = true;
  }, fault === 'timeout' ? 1500 : 10000);
}
`);
      const proc = Bun.spawn([process.execPath, 'test', fixture], {
        env: hardwareTestEnv({ PATH: `${bin}:${process.env.PATH}`, VALID_TAR: validTar }), cwd: root,
        stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const printed = stdout + stderr;
      expect(code).toBe(1);
      expect(printed).toContain('timed out after 1500ms');
      expect(printed).toContain('1 pass');
      expect(printed).toContain('4 fail');
      for (const fault of ['prepare', 'build', 'verify', 'timeout']) {
        const output = join(base, `${fault}.tar`);
        const report = await readFile(`${output}.report/report.txt`, 'utf8');
        expect(printed).toContain(report);
        expect(report).toContain(builderMachineName(output));
        if (fault === 'prepare') {
          expect(report).toContain('prepare failed with evidence');
        } else {
          expect(report).toContain('builder stdout evidence');
          expect(report).toContain('builder stderr evidence');
          expect(report).toContain('guest buildkit and dockerd evidence before deletion');
          expect(await Bun.file(`${output}.machine`).exists()).toBe(keep);
          expect(await Bun.file(`${output}.build.d/build-args`).exists()).toBe(keep);
          expect((await readFile(`${output}.events`, 'utf8')).trim()).toBe(keep ? 'snapshot' : 'snapshot\ndeleted');
        }
        expect(await Bun.file(`${output}.e2e/stdout.log`).exists()).toBe(keep);
      }
      const heartbeat = join(base, 'timeout.tar.heartbeat');
      const stopped = await readFile(heartbeat, 'utf8');
      await Bun.sleep(100);
      expect(await readFile(heartbeat, 'utf8')).toBe(stopped);
      expect(await Bun.file(join(base, 'success.tar')).exists()).toBe(true);
      expect(await Bun.file(join(base, 'success.tar.machine')).exists()).toBe(false);
      expect(await Bun.file(join(base, 'success.tar.build.d/build-args')).exists()).toBe(false);
      expect(await Bun.file(join(base, 'success.tar.e2e/plan.json')).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 125_000);
