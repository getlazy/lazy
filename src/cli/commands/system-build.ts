/**
 * `lazy system build <name>` — prebuild a lazy system image explicitly,
 * bypassing the current project's lazy.toml configuration.
 *
 * Today only `lazy-runner` is a valid image name. This unblocks custom
 * Dockerfiles that layer on top of the base image (`FROM lazy-runner`)
 * on fresh machines where the base image hasn't been built yet.
 */

import { buildLazyRunnerImage } from '../../capture/claude';
import { IMAGE_TAG, IMAGE_MAX_AGE_DAYS } from '../../capture/image-tag';
import { parseFlags } from '../helpers';
import { theme } from '../theme';
import { logger } from '../../utils/logger';

/** System images that `lazy system build` can prebuild. */
const VALID_SYSTEM_IMAGES = ['lazy-runner'] as const;
type SystemImageName = (typeof VALID_SYSTEM_IMAGES)[number];

function isValidSystemImage(name: string): name is SystemImageName {
  return (VALID_SYSTEM_IMAGES as readonly string[]).includes(name);
}

export async function commandSystemBuild(args: string[]): Promise<void> {
  if (args.length === 0) {
    systemBuildUsage();
    process.exit(1);
  }

  const parsed = parseFlags(args, [
    { name: 'no-cache', takesValue: false },
  ], 'system build');

  if (parsed.positional.length === 0) {
    console.error('Error: `lazy system build` requires an image name.');
    console.error(`Valid names: ${VALID_SYSTEM_IMAGES.join(', ')}`);
    process.exit(1);
  }

  if (parsed.positional.length > 1) {
    console.error(`Error: too many arguments (expected one image name, got ${parsed.positional.length}).`);
    process.exit(1);
  }

  const name = parsed.positional[0];
  if (!isValidSystemImage(name)) {
    console.error(`Error: unknown system image '${name}'.`);
    console.error(`Valid names: ${VALID_SYSTEM_IMAGES.join(', ')}`);
    process.exit(1);
  }

  const noCache = parsed.flags.get('no-cache') === true;

  try {
    const tags = await buildLazyRunnerImage({ noCache });
    console.log(`${theme.success('Built')} ${tags.join(', ')}`);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function systemBuildUsage(): void {
  console.log(`Usage: lazy system build <name> [--no-cache]

Prebuild a lazy system image, bypassing the current project's lazy.toml.

Use this to build the base 'lazy-runner' image on a fresh machine — for
example, when a project's custom Dockerfile does \`FROM lazy-runner\` and
the base image doesn't exist yet.

Images are tagged with lazy's major.minor version (lazy-runner:${IMAGE_TAG}). The
base image also gets a \`:latest\` alias pointing at that same build, which is
what \`FROM lazy-runner\` resolves to.

The image carries the configured agent's CLI and the Dockerfile's own packages, not lazy
itself — lazy-agent is mounted into the container at launch. It is rebuilt by
\`lazy upgrade\`, when the Dockerfile changes, and automatically once it is more
than ${IMAGE_MAX_AGE_DAYS} days old.

Valid names:
  lazy-runner              The base Docker image used by agent containers

Options:
  --no-cache               Force a clean rebuild; do not reuse Docker layers

Examples:
  lazy system build lazy-runner
  lazy system build lazy-runner --no-cache`);
}
