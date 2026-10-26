/**
 * The REAL daemon-image build in a throwaway smolvm machine — no host Docker.
 * Each test sets its own two-hour timeout, including cold image builds.
 *
 * Hardware only: it needs a vendored smolvm and a hypervisor, so it runs on
 * the engineer's Mac and nowhere else. Opt in, from the lazy checkout:
 *
 *   LAZY_SMOLVM_E2E=1 LAZY_SMOLVM_BINARY="$(cd lazy-teams && bin/vendor-smolvm)" \
 *     bun test test/e2e/smolvm-image-build.test.ts
 *
 * Takes the time of a full image build (tens of minutes cold) plus, on the
 * first run, a one-off fetch of the builder machine's published image.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, realpath } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { verifyImageTar } from '../../src/vm/image-tar-verify';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { HardwareImageBuild } from '../helpers/smolvm-image-build';
import { builderMachineName } from '../../src/vm/smolvm-image-build';
import { finishSmolvmHardwareTest, saveSmolvmFailureEvidence } from '../helpers/smolvm-failure-evidence';

const enabled = process.env.LAZY_SMOLVM_E2E === '1' && !!process.env.LAZY_SMOLVM_BINARY;
if (!enabled) console.log('skip: test/e2e/smolvm-image-build.test.ts (set LAZY_SMOLVM_E2E=1 and LAZY_SMOLVM_BINARY on a Mac with smolvm)');

describe.skipIf(!enabled)('daemon image built in a smolvm machine', () => {
  let build: HardwareImageBuild | undefined;
  let fleet: string | undefined;
  let succeeded = false;
  afterEach(async () => {
    try {
      await finishSmolvmHardwareTest({
        succeeded, keepOnFailure: process.env.LAZY_SMOLVM_E2E_KEEP === '1',
        capture: () => saveSmolvmFailureEvidence(join(homedir(), '.lazy/smolvm-e2e/last-failure'), {
          context: async () => ({ fleet }),
          imageBuild: async () => build ? build.capture() : 'image build was not started',
        }),
        cleanup: async keep => {
          await build?.cleanup({ preserveFiles: keep });
          if (keep) console.log(`smolvm image build: kept failed fixture: ${fleet}`);
          else if (fleet) await rm(fleet, { recursive: true, force: true });
        },
      });
    } finally {
      build = undefined; fleet = undefined; succeeded = false;
    }
  }, 300_000);

  test('writes a verified tar and source id, and leaves no machine behind', async () => {
    const checkout = resolve(import.meta.dir, '../..');
    fleet = await realpath(await mkdtemp(join(process.env.LAZY_SMOLVM_E2E_FLEET ?? tmpdir(), 'smolvm-build-e2e-')));
    const output = join(fleet, 'lazy-daemon-e2e.tar');
    const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    build = new HardwareImageBuild(process.env.LAZY_SMOLVM_BINARY!, output);
    const code = await build.runManaged([join(checkout, 'lazy-teams/bin/smolvm-build-daemon-image'),
      '--smolvm', process.env.LAZY_SMOLVM_BINARY!, '--platform', platform, '--fleet-root', fleet, output],
      // Any host Docker call fails loudly: no daemon is reachable through this env.
      hardwareTestEnv({ DOCKER_HOST: 'unix:///nonexistent/lazy-no-docker.sock', DOCKER_CONTEXT: '' }));
    expect(code).toBe(0);
    expect((await stat(output)).size).toBeGreaterThan(50 * 1024 * 1024);
    expect((await readFile(`${output}.source-id`, 'utf8')).trim()).toMatch(/^[0-9a-f]{16}$/);
    expect((await verifyImageTar(output)).verifiedBlobs).toBeGreaterThan(1);

    const ls = Bun.spawn([process.env.LAZY_SMOLVM_BINARY!, 'machine', 'ls', '--json'], { env: hardwareTestEnv(), stdout: 'pipe', timeout: 30_000 });
    expect(await new Response(ls.stdout).text()).not.toContain(builderMachineName(output));
    expect(await ls.exited).toBe(0);
    succeeded = true;
  }, 7_200_000);
});
