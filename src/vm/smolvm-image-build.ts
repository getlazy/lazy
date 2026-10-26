/**
 * Build the lazy daemon image with no Docker on the host: on a throwaway
 * smolvm machine's own Docker engine, exported back to the host as a
 * `docker save` tar — the one image form every smolvm machine boots from
 * (lazy-teams/app/clients/daemon_image_fetcher.rb says why never a registry
 * reference) — with the `.source-id` sidecar the fleet compares daemons by.
 *
 *   1. export   `scripts/publish-lazy-daemon-image.sh --export-context` writes
 *               the committed tree and the exact buildx arguments the Docker
 *               path would use (same fingerprint, tags and source stamp).
 *   2. machine  boot a lazy daemon image in a machine of its own, the build
 *               directory shared in over virtiofs, and start its dockerd.
 *   3. build    `docker buildx build --load` inside the guest.
 *   4. export   `docker save` into the shared directory; read the source id
 *               out of the built image (never recomputed).
 *   5. remove   the machine, success or not (or leave cleanup to an enclosing
 *               lifecycle that first captures failure evidence).
 *   6. verify   every blob in the tar re-hashed on the host, then renamed into
 *               place — an interrupted build never looks like a finished one.
 *
 * No step falls back to anything: each failure names its step.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { spawn } from '../utils/spawn';
import { verifyImageTar } from './image-tar-verify';
import {
  BUILDER_DEFAULTS, SmolvmDockerMachine, SmolvmMachineError, type SmolvmRunner,
} from './smolvm-docker-machine';

const MINUTE = 60_000;
const BUILD_TIMEOUT_MS = 90 * MINUTE;
const SAVE_TIMEOUT_MS = 30 * MINUTE;
export const SOURCE_ID_SUFFIX = '.source-id';
const SOURCE_ID = /^[0-9a-f]{16}$/;

export interface ExportedContext { buildArgs: string[]; dockerfile: string; imageRef: string }
/** Writes `<dir>/context` and the build description; resolves when done. */
export type ContextExporter = (checkout: string, dir: string, platform: string) => Promise<void>;

export interface SmolvmImageBuildOptions {
  checkout: string;
  /** Absolute path of the tar to write. */
  output: string;
  platform: string;
  /** Absolute path of a lazy daemon image tar the builder machine boots. */
  builderImage: string;
  allowCidrs: string[];
  run: SmolvmRunner;
  say: (line: string) => void;
  cpus?: number;
  memoryMib?: number;
  storageGib?: number;
  exportContext?: ContextExporter;
  /** An enclosing lifecycle captures diagnostics and removes the machine/work dir. */
  cleanupOwner?: 'caller';
}

export interface SmolvmImageBuildResult { output: string; imageRef: string; sourceId: string; verifiedBlobs: number }

export async function publishScriptExporter(checkout: string, dir: string, platform: string): Promise<void> {
  const proc = spawn([join(checkout, 'scripts/publish-lazy-daemon-image.sh'), '--export-context', dir, '--platform', platform], {
    cwd: checkout, stdout: 'inherit', stderr: 'inherit', timeout: 10 * MINUTE,
  });
  const code = await proc.exited;
  if (code !== 0) throw new SmolvmMachineError('export the build context', `scripts/publish-lazy-daemon-image.sh --export-context exited ${code}; its output is above`);
}

async function readExport(dir: string): Promise<ExportedContext> {
  const read = async (name: string) => {
    try { return (await readFile(join(dir, name), 'utf8')).split('\n').filter((l) => l.length > 0); }
    catch (err) { throw new SmolvmMachineError('export the build context', `${join(dir, name)} was not written: ${(err as Error).message}`); }
  };
  const [buildArgs, dockerfile, imageRef] = await Promise.all([read('build-args'), read('dockerfile'), read('image-ref')]);
  if (!dockerfile[0] || !imageRef[0]) throw new SmolvmMachineError('export the build context', `${dir} names no Dockerfile or image reference`);
  return { buildArgs, dockerfile: dockerfile[0], imageRef: imageRef[0] };
}

function requireAbsolute(what: string, p: string): void {
  if (!p.startsWith('/')) throw new SmolvmMachineError('prepare', `${what} must be an absolute path, got ${p}`);
  if (p.includes(':')) throw new SmolvmMachineError('prepare', `${what} cannot contain ':' (it is shared into the machine as -v HOST:GUEST): ${p}`);
}

/** Deterministic per output, so a killed run's leftover machine is found and removed by the next. */
export function builderMachineName(output: string): string {
  return `${BUILDER_DEFAULTS.namePrefix}${createHash('sha256').update(output).digest('hex').slice(0, 12)}`;
}

export async function buildImageInSmolvm(opts: SmolvmImageBuildOptions): Promise<SmolvmImageBuildResult> {
  const { output, say } = opts;
  requireAbsolute('the output tar', output);
  requireAbsolute('the builder image', opts.builderImage);
  try { await stat(opts.builderImage); }
  catch { throw new SmolvmMachineError('prepare', `no builder image tar at ${opts.builderImage}`); }

  const work = `${output}.build.d`;
  const share = BUILDER_DEFAULTS.guestShareDir;
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'out'), { recursive: true });

  say(`step 1/6: exporting the build context from ${opts.checkout}`);
  await (opts.exportContext ?? publishScriptExporter)(opts.checkout, work, opts.platform);
  const exported = await readExport(work);

  const machine = new SmolvmDockerMachine(opts.run, {
    name: builderMachineName(output),
    image: opts.builderImage,
    cpus: opts.cpus ?? BUILDER_DEFAULTS.cpus,
    memoryMib: opts.memoryMib ?? BUILDER_DEFAULTS.memoryMib,
    storageGib: opts.storageGib ?? BUILDER_DEFAULTS.storageGib,
    allowCidrs: opts.allowCidrs,
    volumes: [{ host: work, guest: share }],
  }, (line) => say(`  ${line}`));

  const guestTar = `${share}/out/image.tar`;
  let sourceId = '';
  let buildError: unknown = null;
  try {
    say('step 2/6: booting a throwaway builder machine');
    await machine.boot();
    await machine.startDockerd();

    say(`step 3/6: building ${exported.imageRef} for ${opts.platform} inside the machine (several minutes)`);
    await machine.exec('build the image', [
      'docker', 'buildx', 'build', '-f', `${share}/context/${exported.dockerfile}`,
      ...exported.buildArgs, '--load', `${share}/context`,
    ], BUILD_TIMEOUT_MS, (line) => say(`  | ${line}`));

    say(`step 4/6: exporting the image to ${output}`);
    await machine.exec('export the image', ['docker', 'save', '-o', guestTar, exported.imageRef], SAVE_TIMEOUT_MS);
    const read = await machine.exec('read the source id', [
      'docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat', exported.imageRef, '/opt/lazy/.source-fingerprint',
    ], 5 * MINUTE);
    sourceId = read.stdout.trim();
    if (!SOURCE_ID.test(sourceId)) {
      throw new SmolvmMachineError('read the source id', `${exported.imageRef} carries a malformed /opt/lazy/.source-fingerprint (${JSON.stringify(sourceId)}); expected 16 hex characters`);
    }
  } catch (err) {
    buildError = err;
  } finally {
    if (opts.cleanupOwner === 'caller') {
      say('step 5/6: builder cleanup belongs to the caller');
    } else {
      say('step 5/6: removing the builder machine');
      try { await machine.remove(); }
      catch (err) {
        // The build's own failure is the one to report; a removal failure on top is said, not hidden.
        if (buildError) say(`  ${(err as Error).message}`);
        else buildError = err;
      }
    }
  }
  if (buildError) {
    if (opts.cleanupOwner !== 'caller') await rm(work, { recursive: true, force: true });
    throw buildError;
  }

  say('step 6/6: verifying every blob of the image on the host');
  const hostTar = join(work, 'out', 'image.tar');
  let verified;
  try {
    // The guest wrote this file: a symlink would point the verifier and the rename elsewhere.
    const info = await lstat(hostTar);
    if (!info.isFile()) throw new SmolvmMachineError('verify the image', `${hostTar} is not a regular file`);
    verified = await verifyImageTar(hostTar);
    await mkdir(dirname(output), { recursive: true });
    // Sidecar first: a tar in place without its source id would be reused as "built earlier".
    await writeFile(`${output}${SOURCE_ID_SUFFIX}.partial`, `${sourceId}\n`);
    await rename(`${output}${SOURCE_ID_SUFFIX}.partial`, `${output}${SOURCE_ID_SUFFIX}`);
    await rename(hostTar, output);
  } finally {
    if (opts.cleanupOwner !== 'caller') await rm(work, { recursive: true, force: true });
  }
  say(`built ${output} (lazy source ${sourceId}, ${verified.verifiedBlobs} blobs verified)`);
  return { output, imageRef: exported.imageRef, sourceId, verifiedBlobs: verified.verifiedBlobs };
}
