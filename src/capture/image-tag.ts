/**
 * How the runner image is tagged, and how long a build of it stays fresh.
 *
 * Split out of src/capture/claude.ts so the e2e agent mock (test/mocks/claude.ts,
 * which REPLACES that module wholesale) can import the same values instead of
 * re-stating them — a mock that invents its own tag shape is a mock that keeps
 * passing after the real one changes.
 *
 * WHAT THE IMAGE ACTUALLY CONTAINS, because the whole scheme follows from it:
 * the image is built from the project's Dockerfile and does NOT contain lazy.
 * There is no COPY/ADD from the repo; `lazy-agent` is bind-mounted read-only at
 * container launch. So a stale image never means "running old lazy".
 *
 * What it does contain varies by project — the only thing lazy's own default
 * (src/docker/base.Dockerfile) guarantees is Claude Code plus a handful of
 * Debian packages, and a project supplying its own Dockerfile can put anything
 * in it. What every such image has in common is that none of it is pinned:
 * `apt-get install` and the Claude Code installer both resolve to whatever is
 * current at build time (pinning was considered and rejected — the maintenance
 * burden is not wanted). So the contents drift with WALL-CLOCK TIME, not with
 * lazy's version number.
 *
 * That is why freshness is time-based rather than version-tagged. Three
 * independent triggers rebuild the image, and they cover different axes:
 *
 *   1. `lazy upgrade`      — with --no-cache. The primary mechanism: upgrading
 *                            lazy rebuilds the image, which is what users
 *                            already expect. When nothing about the image's
 *                            identity has changed since the last build, the
 *                            interactive upgrade ASKS rather than deciding on a
 *                            timer (`evaluateUpgradeRebuild`), because the only
 *                            thing a rebuild would buy is re-resolving unpinned
 *                            contents — worth minutes some days, not others,
 *                            and only the human knows which. Non-interactive
 *                            runs and `--images` always rebuild.
 *   2. age > MAX_AGE_DAYS  — the backstop, for people who never run `lazy
 *                            upgrade` and for source checkouts where "upgrade"
 *                            is not a thing you do.
 *   3. Dockerfile hash     — the orthogonal axis (the Dockerfile TEXT changed),
 *                            handled by the `lazy.dockerfile.hash` label.
 *
 * The tag itself is therefore only an identity, not a freshness signal.
 */

import { createHash } from 'crypto';
import { VERSION } from '../version';
import { majorMinor } from '../utils/version-parts';

/** Repository name of the base runner image. */
export const IMAGE_NAME = 'lazy-runner';

/**
 * Label carrying the sha256 of everything an image's identity is derived from:
 * the Dockerfile text, plus the contents of every `[docker] build_inputs` file.
 *
 * The name is historical — it predates `build_inputs`, and renaming it would
 * make every image already on every developer's host look unlabelled and
 * trigger a multi-minute rebuild for nothing.
 */
export const DOCKERFILE_HASH_LABEL = 'lazy.dockerfile.hash';

/**
 * Label carrying a JSON map of `path → short sha256` for each input that fed
 * DOCKERFILE_HASH_LABEL. Purely EXPLANATORY: the rebuild decision is made on
 * the combined hash above, and this exists only so a rebuild can say WHICH file
 * changed instead of "something did". Absent on images built by older lazy
 * versions, which is why every reader treats it as best-effort.
 */
export const IMAGE_INPUTS_LABEL = 'lazy.image.inputs';

/** Manifest key used for the Dockerfile itself, which is never a real path. */
export const DOCKERFILE_INPUT_KEY = 'Dockerfile';

/**
 * Maximum age of a runner image before `ensureImage` rebuilds it.
 *
 * 14 days is chosen against how often Claude Code ships (often — it is the one
 * thing every runner image carries) and against how often this timer is
 * actually the thing that fires (rarely — trigger 1 above normally gets there
 * first). Short enough that a machine nobody upgrades does not sit on a
 * months-old Claude Code; long enough that it is never a rebuild you notice.
 */
export const IMAGE_MAX_AGE_DAYS = 14;
export const IMAGE_MAX_AGE_MS = IMAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Coerce a version fragment into a legal Docker tag: `[A-Za-z0-9_][A-Za-z0-9_.-]*`.
 * Guards against a hand-edited package.json version producing an unbuildable ref.
 */
function dockerTagFor(version: string): string {
  const sanitized = version.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 128);
  if (!sanitized) return 'dev';
  return /^[A-Za-z0-9_]/.test(sanitized) ? sanitized : `v${sanitized}`;
}

/**
 * The image tag for a given lazy version: the `major.minor` prefix only
 * (`0.21.1373-alpha` → `0.21`).
 *
 * Coarse on purpose. VERSION advances on every commit, so a full-version tag
 * would trigger a multi-minute rebuild on every commit in a source checkout —
 * the common case for anyone developing lazy. The deliberate tradeoff is that a
 * patch release (0.21.0 → 0.21.1) does not change the tag either; that is fine,
 * because the tag is not what keeps the image fresh (see the header comment) —
 * those releases are days apart against a staleness window of months, and
 * `lazy upgrade` rebuilds regardless of what the tag says.
 *
 * The `-alpha` suffix never reaches the tag: it lives past the major.minor
 * prefix, so an alpha build and a main build of the same minor share one image.
 * They also want the same image — nothing in it depends on lazy's branch.
 *
 * The prefix itself comes from {@link majorMinor}, shared with the docs site's
 * version segment (src/docs/links.ts) — one place decides what "the minor this
 * build belongs to" means.
 */
export function imageTagFor(version: string): string {
  return dockerTagFor(majorMinor(version));
}

/** The tag THIS lazy runs, e.g. `lazy-runner:0.21`. */
export const IMAGE_TAG = imageTagFor(VERSION);

/**
 * Identity of a human-consented worktree image: the Dockerfile bytes AND the
 * directory they build against.
 *
 * The pure content hash is not enough. Two task worktrees of the same repo
 * routinely hold byte-identical `Dockerfile.lazy` copies while their trees
 * differ — that is the normal state of two branches cut from one base. Keyed on
 * content alone they would share a single `lazy-custom-<hash>` image, so
 * whichever built first would win and the other task would silently run an
 * image built from the wrong branch's files: the same wrong-tree bug this flow
 * exists to prevent, one step further along.
 *
 * The key covers the context DIRECTORY, not a commit. The build reads that
 * directory live, so there is no single tree object to name — and the path is
 * exactly what went into the image, at the cost of no git invocation at all.
 * `contentHash` stays a pure content hash: drift detection compares Dockerfile
 * bytes against it and must not move when a worktree is merely relocated.
 *
 * Lives here rather than in src/docker/ because src/docker/worktree-image.ts
 * imports the build from src/capture/claude.ts — the reverse import would be a
 * cycle.
 */
export function consentedBuildIdentity(contentHash: string, contextDir: string): string {
  return createHash('sha256')
    .update(`dockerfile:${contentHash}\ncontext:${contextDir}\n`)
    .digest('hex');
}
