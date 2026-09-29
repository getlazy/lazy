/**
 * The source stamp: git identity carried into a checkout that has no `.git`.
 *
 * Image builds copy lazy's sources with `.git` excluded (.dockerignore, and the
 * publish scripts build from a `git archive`), so every git probe inside the
 * image fails. Without a stamp the version falls back to package.json's bare
 * `0.90.0` and the provenance suffix is dropped — `lazy-agent ok 0.90.0`, which
 * says nothing about whether the build is current.
 *
 * The script that HAS the checkout passes the identity in as build args
 * (`LAZY_BUILD_SHA`, `LAZY_BUILD_BRANCH`, `LAZY_BUILD_DIRTY`,
 * `LAZY_BUILD_COMMIT_COUNT`); the image's build step runs
 * `scripts/write-source-stamp.ts`, which writes them to `source-stamp.json` at
 * the checkout root. Every later reader — the version generator, the agent
 * binary compile inside a guest, the Teams image that copies this checkout —
 * falls back to that file whenever git cannot answer. Git always wins when it
 * can: a stale stamp in a real checkout must never outrank the repository.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export const SOURCE_STAMP_FILE = 'source-stamp.json';

export interface SourceStamp {
  /** Short git SHA the checkout was exported from. */
  sha: string;
  /** Branch name, or null when the builder could not name one. */
  branch: string | null;
  /** True when the exported tree differed from the commit. */
  dirty: boolean;
  /** `git rev-list --count` of the commit — the version's patch component. */
  commitCount: number | null;
  /**
   * Commit time (ISO 8601), or null. Deterministic on purpose: it becomes the
   * resting build-info.ts's BUILD_TIME, and anything varying per call there
   * changes the agent binary's source hash (a rebuild on every launch) and the
   * baked source fingerprint (a different id per build of one commit).
   */
  time: string | null;
}

const SHA_RE = /^[0-9a-f]{4,40}$/;

/**
 * Parse the stamp's four inputs, as build args or env vars. Returns null when
 * no SHA was supplied — the stamp is all-or-nothing on the SHA, because a
 * branch without a commit identifies nothing.
 */
export function sourceStampFromEnv(env: Record<string, string | undefined>): SourceStamp | null {
  const sha = env.LAZY_BUILD_SHA?.trim().toLowerCase() ?? '';
  if (!sha) return null;
  if (!SHA_RE.test(sha)) {
    throw new Error(`LAZY_BUILD_SHA must be a hex git SHA, got '${sha}'`);
  }
  const branch = env.LAZY_BUILD_BRANCH?.trim() || null;
  const dirtyRaw = env.LAZY_BUILD_DIRTY?.trim().toLowerCase() ?? '';
  if (dirtyRaw !== '' && !['true', 'false', '1', '0'].includes(dirtyRaw)) {
    throw new Error(`LAZY_BUILD_DIRTY must be true or false, got '${dirtyRaw}'`);
  }
  const countRaw = env.LAZY_BUILD_COMMIT_COUNT?.trim() ?? '';
  if (countRaw !== '' && !/^\d+$/.test(countRaw)) {
    throw new Error(`LAZY_BUILD_COMMIT_COUNT must be a whole number, got '${countRaw}'`);
  }
  const time = env.LAZY_BUILD_TIME?.trim() || null;
  if (time !== null && Number.isNaN(Date.parse(time))) {
    throw new Error(`LAZY_BUILD_TIME must be an ISO 8601 time, got '${time}'`);
  }
  return {
    sha,
    branch,
    time,
    dirty: dirtyRaw === 'true' || dirtyRaw === '1',
    commitCount: countRaw === '' ? null : Number(countRaw),
  };
}

/**
 * Read `<root>/source-stamp.json`, or null when there is none.
 *
 * Sync on purpose: its callers are build-time scripts and the git-probe
 * fallbacks beside them, which are already synchronous spawns; the file is a
 * few bytes. A stamp that exists but does not parse is an error, not "none" —
 * silently dropping it would bring back exactly the unidentifiable build this
 * file exists to prevent.
 */
export function readSourceStamp(root: string): SourceStamp | null {
  const path = join(root, SOURCE_STAMP_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: Partial<SourceStamp>;
  try {
    parsed = JSON.parse(raw) as Partial<SourceStamp>;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed.sha !== 'string' || !SHA_RE.test(parsed.sha)) {
    throw new Error(`${path} has no valid "sha" — rebuild the image with LAZY_BUILD_SHA set`);
  }
  return {
    sha: parsed.sha,
    branch: typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : null,
    dirty: parsed.dirty === true,
    time: typeof parsed.time === 'string' && parsed.time ? parsed.time : null,
    commitCount: typeof parsed.commitCount === 'number' && Number.isInteger(parsed.commitCount)
      ? parsed.commitCount
      : null,
  };
}

export function formatSourceStampFile(stamp: SourceStamp): string {
  return JSON.stringify(stamp, null, 2) + '\n';
}
