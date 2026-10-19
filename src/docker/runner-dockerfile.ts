/**
 * The default runner Dockerfile: the base text plus EVERY container-capable
 * agent's CLI.
 *
 * One image carries every agent (engineer decision 2026-09-27, see
 * docs/design/published-runner-image.md): per-agent variants meant patching
 * Dockerfiles, which hid what was actually in an image. Each agent still owns
 * its own install line (`dockerInstallCommand()`, with any pinned version), so
 * this module only concatenates — no install line is written twice.
 *
 * The same text is what `lazy system export-dockerfile` prints, what a local
 * build uses, and what the release publishes (scripts/runner-image-dockerfile.ts)
 * — so a pulled image and a local build carry the same identity label.
 */

import BASE_DOCKERFILE from './base.Dockerfile' with { type: 'text' };
import { getAgentPackaging, listAgents } from '../agent/registry';
import {
  BASE_SOURCE_LABEL,
  DOCKERFILE_HASH_LABEL,
  DOCKERFILE_INPUT_KEY,
  IMAGE_INPUTS_LABEL,
  PUBLISHED_RUNNER_REPOSITORY,
  runnerContentTag,
  hashManifest,
  shortHash,
  type ImageInputManifest,
} from '../capture/image-tag';

/** Agents whose CLI the runner image carries, in registry order. */
export function runnerImageAgents(): string[] {
  return listAgents().filter(id => getAgentPackaging(id).supportsContainerRunner());
}

export function composeRunnerDockerfile(): string {
  const sections = runnerImageAgents().map(id =>
    `# Agent CLI: ${id}\n${getAgentPackaging(id).dockerInstallCommand()}\n`,
  );
  return `${BASE_DOCKERFILE.trimEnd()}\n\n${sections.join('\n')}\nWORKDIR /work\n`;
}

/**
 * The labels a PUBLISHED runner image carries: the same identity labels a local
 * build of this text writes, plus `lazy.base.source=published`. The release
 * stamps these (scripts/runner-image-dockerfile.ts), and `ensureImage` accepts a
 * pulled image only when its identity label matches what this binary composes.
 */
export function publishedRunnerImageLabels(): Record<string, string> {
  const manifest: ImageInputManifest = { [DOCKERFILE_INPUT_KEY]: shortHash(composeRunnerDockerfile()) };
  return {
    [DOCKERFILE_HASH_LABEL]: hashManifest(manifest),
    [IMAGE_INPUTS_LABEL]: JSON.stringify(manifest),
    [BASE_SOURCE_LABEL]: 'published',
  };
}

/** The identity hash ({@link DOCKERFILE_HASH_LABEL}) of the composed runner. */
export function runnerIdentityHash(): string {
  return publishedRunnerImageLabels()[DOCKERFILE_HASH_LABEL]!;
}

/**
 * The ref THIS lazy pulls, e.g. `ghcr.io/getlazy/lazy-runner:sha-0123456789abcdef`:
 * the content tag of the runner it composes. A local fallback build wears it too
 * (with `lazy.base.source=local`), so a `FROM` naming it resolves from the local
 * store either way.
 */
export const PUBLISHED_RUNNER_REF = `${PUBLISHED_RUNNER_REPOSITORY}:${runnerContentTag(runnerIdentityHash())}`;
