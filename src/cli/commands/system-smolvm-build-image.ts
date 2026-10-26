/**
 * `lazy system smolvm-build-image` — build the lazy daemon image on a
 * throwaway smolvm machine and write it to the host as a verified
 * `docker save` tar, with no Docker on the host. Project-free: Lazy Teams'
 * native install runs it before any project or daemon exists.
 */
import { resolve } from 'path';
import { parseFlags } from '../helpers';
import { buildImageInSmolvm } from '../../vm/smolvm-image-build';
import { BUILDER_DEFAULTS, smolvmCliRunner } from '../../vm/smolvm-docker-machine';

function defaultPlatform(): string {
  return process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
}

export async function commandSystemSmolvmBuildImage(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'smolvm', takesValue: true },
    { name: 'builder-image', takesValue: true },
    { name: 'output', takesValue: true },
    { name: 'platform', takesValue: true },
    { name: 'allow-cidrs', takesValue: true },
    { name: 'checkout', takesValue: true },
    { name: 'memory-mib', takesValue: true },
    { name: 'print-builder-image', takesValue: false },
  ], 'system smolvm-build-image');
  const flag = (name: string) => parsed.flags.get(name) as string | undefined;

  if (parsed.flags.get('print-builder-image') === true) {
    console.log(BUILDER_DEFAULTS.image);
    return;
  }
  const smolvm = flag('smolvm') ?? process.env.LAZY_SMOLVM_BINARY;
  const builderImage = flag('builder-image');
  const output = flag('output');
  const cidrs = (flag('allow-cidrs') ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const missing = [!smolvm && '--smolvm (or LAZY_SMOLVM_BINARY)', !builderImage && '--builder-image', !output && '--output', cidrs.length === 0 && '--allow-cidrs']
    .filter(Boolean);
  if (missing.length) {
    console.error(`Error: missing ${missing.join(', ')}. See: lazy system smolvm-build-image --help`);
    process.exit(2);
  }
  const memory = flag('memory-mib');
  try {
    await buildImageInSmolvm({
      checkout: resolve(flag('checkout') ?? process.cwd()),
      output: resolve(output!),
      platform: flag('platform') ?? defaultPlatform(),
      builderImage: resolve(builderImage!),
      allowCidrs: cidrs,
      memoryMib: memory ? Number(memory) : undefined,
      run: smolvmCliRunner(smolvm!),
      say: (line) => console.log(`smolvm-build-image: ${line}`),
    });
  } catch (err) {
    console.error(`smolvm-build-image: failed at ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function systemSmolvmBuildImageUsage(): void {
  console.log(`Usage: lazy system smolvm-build-image --builder-image <tar> --output <tar> --allow-cidrs <list> [options]

Build the lazy daemon image from a lazy checkout without Docker on this
machine: a throwaway smolvm machine boots a lazy daemon image (which carries
its own Docker engine), builds the image there, and writes it back as a
\`docker save\` tar with a .source-id file beside it. Every blob is checked
on this machine before the tar is moved into place, and the machine is
always deleted afterwards.

Options:
  --smolvm <path>          The smolvm binary (default: $LAZY_SMOLVM_BINARY)
  --builder-image <tar>    A lazy daemon image tar for the builder machine to boot
  --output <tar>           Where to write the built image
  --allow-cidrs <list>     Comma-separated public CIDRs the builder may reach
  --platform <os/arch>     Target platform (default: this machine's)
  --checkout <dir>         The lazy checkout to build (default: current directory)
  --memory-mib <n>         The builder's memory (default: ${BUILDER_DEFAULTS.memoryMib})
  --print-builder-image    Print the published image the builder boots by default, and exit

Examples:
  lazy system smolvm-build-image --print-builder-image
  lazy system smolvm-build-image --builder-image ~/lazy-fleet/lazy-image-builder.tar \\
      --output ~/lazy-fleet/lazy-daemon-abc.tar --allow-cidrs 1.0.0.0/8,2.0.0.0/7`);
}
