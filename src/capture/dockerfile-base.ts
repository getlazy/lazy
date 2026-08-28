/**
 * Which lazy base image a project's custom Dockerfile builds FROM.
 *
 * WHY THIS EXISTS
 * ---------------
 * A project's `Dockerfile.lazy` is encouraged to start with `FROM lazy-runner`
 * (README, and src/prompts/setup-dockerfile.md) so it inherits the base runner
 * image instead of reassembling the toolchain. `lazy-runner` is a LOCAL image
 * that lazy builds — it exists on no registry. So on a machine where it has
 * never been built (fresh machine, `docker system prune`, a first task after an
 * upgrade forced a custom-image rebuild), `docker build` treats the unresolvable
 * name as a Docker Hub repository and dies with
 *
 *     ERROR: failed to solve: pull access denied, repository does not exist
 *
 * which says nothing about the actual problem. Detecting the reference lets the
 * build path build the base first, and lets the failure name
 * `lazy system build lazy-runner` as the remedy.
 *
 * SCOPE — the exact `lazy-runner` repository is what lazy will build for you.
 * The agent-suffixed repositories (`lazy-runner-cursor`, …) are recognised but
 * NOT auto-built: they are lazy's own per-agent default images, produced by
 * `ensureImage` from the default Dockerfile plus that agent's install line, and
 * nothing documents them as a FROM target. Building one here would mean
 * re-deriving agent-aware Dockerfile content inside a path that is already
 * building the project's custom Dockerfile. They still get the actionable error
 * message rather than the raw registry one.
 *
 * Likewise a base reference pinned to a tag lazy does not write (`FROM
 * lazy-runner:0.19`) is recognised but not built — a base build writes only the
 * current version tag and `:latest`, so building would not produce the ref the
 * Dockerfile asked for.
 */

/** The parse of one `FROM` instruction. */
interface FromInstruction {
  /** The image reference as written, minus any flags — e.g. `lazy-runner:latest`. */
  ref: string;
  /** The stage name from a trailing `AS <name>`, lowercased, if present. */
  stage: string | null;
}

/**
 * Parse the `FROM` instructions out of Dockerfile text.
 *
 * Handles the spellings that actually occur: comments, leading whitespace, a
 * `--platform=…` (or any other `--flag`) between `FROM` and the ref, and a
 * trailing `AS <stage>`. References to an earlier build stage are dropped —
 * `FROM builder` after `FROM debian AS builder` names a stage, not an image.
 *
 * Anything it cannot resolve (an `ARG`-interpolated `FROM ${BASE}`) simply does
 * not match the lazy base repository, which is the safe direction: the worst
 * case is the behaviour lazy had before this existed.
 */
export function parseFromRefs(content: string): FromInstruction[] {
  const refs: FromInstruction[] = [];
  const stages = new Set<string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^FROM\s+(.+)$/i.exec(line);
    if (!match) continue;

    // Drop flags (`--platform=linux/amd64`), then take the ref and an optional
    // `AS <stage>`.
    const tokens = match[1].split(/\s+/).filter(token => token.length > 0);
    while (tokens.length > 0 && tokens[0].startsWith('--')) tokens.shift();
    const ref = tokens.shift();
    if (!ref) continue;

    let stage: string | null = null;
    if (tokens.length >= 2 && tokens[0].toUpperCase() === 'AS') {
      stage = tokens[1].toLowerCase();
    }

    // A reference to a stage declared earlier in this file is not an image.
    if (!stages.has(ref.toLowerCase())) refs.push({ ref, stage });
    if (stage) stages.add(stage);
  }

  return refs;
}

/** How a Dockerfile depends on lazy's own base images. */
export interface LazyBaseUsage {
  /**
   * Every `FROM` reference naming a lazy base repository, normalised so an
   * untagged one carries the `:latest` it actually resolves through.
   */
  referenced: string[];
  /**
   * The subset lazy can produce itself — refs a base build genuinely writes.
   * These are the ones worth building before the custom build runs.
   */
  buildable: string[];
  /** `referenced` minus `buildable`: recognised, but lazy cannot supply them. */
  unbuildable: string[];
}

/**
 * Is `ref` a reference to one of lazy's own locally-built base repositories?
 *
 * A registry-qualified or namespaced name (`docker.io/acme/lazy-runner`) is
 * somebody else's image that merely shares the name, so any `/` disqualifies.
 */
function isLazyBaseRepository(repository: string, baseName: string): boolean {
  if (repository.includes('/')) return false;
  return repository === baseName || repository.startsWith(`${baseName}-`);
}

/**
 * Split a reference into repository and tag, treating an untagged reference as
 * `:latest` (which is what Docker resolves it to). Digest references
 * (`repo@sha256:…`) have no tag lazy could ever write, so they come back with a
 * null tag and are never considered buildable.
 */
function splitRef(ref: string): { repository: string; tag: string | null } {
  const at = ref.indexOf('@');
  if (at !== -1) return { repository: ref.slice(0, at), tag: null };

  const colon = ref.lastIndexOf(':');
  // A colon before a `/` is a registry port, not a tag — but a `/` already
  // disqualifies the ref, so a plain lastIndexOf is enough here.
  if (colon === -1) return { repository: ref, tag: 'latest' };
  return { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

/**
 * Work out which lazy base images `content` builds FROM, and which of those
 * lazy can build itself.
 *
 * @param baseName      the base runner repository (`lazy-runner`)
 * @param buildableRefs the full refs a base build writes, e.g.
 *                      `['lazy-runner:0.23', 'lazy-runner:latest']`
 */
export function analyzeLazyBaseUsage(
  content: string,
  baseName: string,
  buildableRefs: string[],
): LazyBaseUsage {
  const buildableSet = new Set(buildableRefs);
  const referenced: string[] = [];
  const buildable: string[] = [];
  const unbuildable: string[] = [];

  for (const { ref } of parseFromRefs(content)) {
    const { repository, tag } = splitRef(ref);
    if (!isLazyBaseRepository(repository, baseName)) continue;

    const normalized = tag === null ? ref : `${repository}:${tag}`;
    if (referenced.includes(normalized)) continue;
    referenced.push(normalized);
    (buildableSet.has(normalized) ? buildable : unbuildable).push(normalized);
  }

  return { referenced, buildable, unbuildable };
}
