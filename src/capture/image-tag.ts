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
 *   1. `lazy upgrade`      — always, unconditionally, with --no-cache. The
 *                            primary mechanism: upgrading lazy rebuilds the
 *                            image, which is what users already expect.
 *   2. age > MAX_AGE_DAYS  — the backstop, for people who never run `lazy
 *                            upgrade` and for source checkouts where "upgrade"
 *                            is not a thing you do.
 *   3. Dockerfile hash     — the orthogonal axis (the Dockerfile TEXT changed),
 *                            handled by the `lazy.dockerfile.hash` label.
 *
 * The tag itself is therefore only an identity, not a freshness signal.
 */

import { VERSION } from '../version';
import { majorMinor } from '../utils/version-parts';

/** Repository name of the base runner image. */
export const IMAGE_NAME = 'lazy-runner';

/** Label carrying the sha256 of the Dockerfile text an image was built from. */
export const DOCKERFILE_HASH_LABEL = 'lazy.dockerfile.hash';

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
