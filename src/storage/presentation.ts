/**
 * Validation and helpers for agent-declared review presentations.
 *
 * INVARIANT: agent group order is the narrative order — tiers control default
 * collapse only. Residual "Other changes" is appended at render time so agents
 * cannot hide files from the diff.
 */

import type {
  PresentationCapName,
  PresentationCapRefusal,
  PresentationFile,
  PresentationGroup,
  PresentationItem,
  PresentationProse,
  PresentationScreenshot,
  PresentationSnippet,
  PresentationTier,
  ReviewPresentation,
} from '../types';

export const PRESENTATION_TIERS: readonly PresentationTier[] = [
  'core',
  'tests',
  'docs',
  'generated',
  'other',
] as const;

/**
 * Review renderer display order — docs and maintained files rank above core so
 * CHANGELOG/public-docs are never demoted below implementation diffs.
 * Agent group order within a tier is preserved (narrative order).
 */
export const TIER_DISPLAY_RANK: Record<PresentationTier, number> = {
  docs: 0,
  core: 1,
  tests: 2,
  generated: 3,
  other: 4,
};

const TIER_SET = new Set<string>(PRESENTATION_TIERS);

const MAX_GROUPS = 32;
/**
 * The two item caps, split by what the item COSTS.
 *
 * A `file` item is a path plus a short note — the walkthrough's membership
 * claim, and the unit a partition is made of. A release hub's branch is
 * hundreds of files, so a shared 64-item ceiling put the largest part of the
 * diff back in the residual block the walkthrough exists to replace: the agent
 * fitted 64 items, named ~200 paths in prose, and those paths landed in "Other
 * changes" (system message 2342bcf4). File items therefore get their own cap,
 * set where a release-sized branch cannot reach it.
 *
 * A `snippet` is context the reader pays for in screen space and attention,
 * and `prose` is the agent's own narrative — both keep the original 64, and
 * so does {@link MAX_SNIPPET_SPAN}.
 */
const MAX_FILE_ITEMS = 512;
const MAX_NARRATIVE_ITEMS = 64;
const MAX_SNIPPET_SPAN = 200;
const MAX_SCREENSHOTS = 12;

/**
 * The SIZE caps — the ones that can force a walkthrough to leave something
 * out, and therefore the only ones a refusal is recorded for.
 *
 * `MAX_SNIPPET_SPAN` and `MAX_SCREENSHOTS` are deliberately absent: neither
 * can push a file into the residual, so exceeding one is an authoring mistake
 * to fix at the item, not a cap to tell a reviewer the partition was cut down
 * for.
 */
export const PRESENTATION_CAPS: Record<PresentationCapName, number> = {
  file_items: MAX_FILE_ITEMS,
  narrative_items: MAX_NARRATIVE_ITEMS,
  groups: MAX_GROUPS,
};

/** How each cap is NAMED — "the 512-file-item cap". */
const CAP_PHRASES: Record<PresentationCapName, string> = {
  file_items: 'file-item',
  narrative_items: 'snippet/prose-item',
  groups: 'group',
};

/** What to do about each cap, in the refusal the AGENT reads. */
const CAP_ADVICE: Record<PresentationCapName, string> = {
  file_items:
    'Claim a directory or glob as one file item — { kind: "file", file: "test/e2e/" } — ' +
    'instead of listing its files one by one.',
  narrative_items:
    'Snippets and prose are the expensive items: keep the story to the lines that need ' +
    'quoting and claim the rest as file items (a directory or glob counts as one).',
  groups: 'Merge the smallest groups into the ones they belong with.',
};

/**
 * The cap named, e.g. "the 512-file-item cap".
 *
 * ONE naming, used by the refusal the agent reads and by the line the reviewer
 * reads — a cap described two ways is a cap nobody can look up.
 */
export function capName(refusal: Pick<PresentationCapRefusal, 'cap' | 'limit'>): string {
  return `the ${refusal.limit}-${CAP_PHRASES[refusal.cap] ?? refusal.cap} cap`;
}

export interface CapRefusalLineOptions {
  /**
   * Whether there IS an unassigned block for this line to talk about. With
   * none, the "some of these files may be unassigned" clause has no
   * antecedent and sends the reviewer hunting for something that is not
   * there — while the news is the opposite one: the cap bit, and the
   * rewrite covered everything anyway.
   */
  residual: boolean;
  /**
   * Whether the refusal was recorded WITH the walkthrough being shown.
   *
   * False when it came off a LATER report — the agent had this walkthrough on
   * record, tried to file a bigger one, and was refused without replacing it
   * — where "the walkthrough hit the cap" would be a claim about the wrong
   * walkthrough. (A refusal OLDER than the walkthrough is not shown at all:
   * it has been answered by the walkthrough that followed it.)
   */
  sameReport?: boolean;
}

/** One line naming a recorded cap refusal, for a surface showing a walkthrough. */
export function capRefusalLine(
  refusal: PresentationCapRefusal,
  opts: CapRefusalLineOptions = { residual: true },
): string {
  if (opts.sameReport === false) {
    // A LATER walkthrough was refused and never replaced, so what is on
    // record is the one filed before it. Nothing is claimed about how this
    // walkthrough was written — it predates the cap.
    const later =
      `A later walkthrough on this task was refused for exceeding ${capName(refusal)} — ` +
      `${refusal.actual} declared — so what is shown here is the one filed before it`;
    return opts.residual
      ? `${later}, and the files it does not name may be waiting on that rewrite.`
      : `${later}, and it covers every file of the change.`;
  }
  const hit =
    `The walkthrough hit ${capName(refusal)} — ${refusal.actual} declared — and was rewritten to fit`;
  return opts.residual
    ? `${hit}, so some of these files may be unassigned because of the cap rather than by choice.`
    : `${hit}, and it still covers every file of the change.`;
}

/**
 * A walkthrough refused for exceeding a cap — typed, so the refusal can be
 * RECORDED against the task by cap rather than by parsing a message.
 *
 * Engineer's rule (2026-09-20): a cap that is hit has to be visible to the
 * reviewer, or "raise it if real tasks hit it" is a promise nobody can keep —
 * the only signal a cap ever produced was a refused tool call the agent
 * quietly worked around.
 */
export class PresentationCapError extends Error {
  readonly refusal: PresentationCapRefusal;

  constructor(cap: PresentationCapName, actual: number) {
    const limit = PRESENTATION_CAPS[cap];
    super(`presentation exceeds ${capName({ cap, limit })} — ${actual} declared. ${CAP_ADVICE[cap]}`);
    this.name = 'PresentationCapError';
    this.refusal = { cap, limit, actual, created_at: Date.now() };
  }
}

export function isPresentationTier(value: unknown): value is PresentationTier {
  return typeof value === 'string' && TIER_SET.has(value);
}

function normalizeProse(raw: unknown, label: string): PresentationProse {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const body = (raw as { body?: unknown }).body;
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error(`${label} body must be a non-empty string`);
  }
  return { kind: 'prose', body: body.trimEnd() };
}

function normalizeSnippet(raw: unknown, label: string): PresentationSnippet {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const file = o.file;
  const start = o.start;
  const end = o.end;
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error(`${label} file must be a non-empty string`);
  }
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 1) {
    throw new Error(`${label} start must be a positive line number`);
  }
  if (typeof end !== 'number' || !Number.isFinite(end) || end < 1) {
    throw new Error(`${label} end must be a positive line number`);
  }
  if (start > end) {
    throw new Error(`${label} start must be <= end`);
  }
  if (end - start + 1 > MAX_SNIPPET_SPAN) {
    // A plain, LABELLED validation error, not a recorded cap: a snippet that
    // quotes too much cannot push a file out of the walkthrough, and the agent
    // fixing it needs to know which item is too long.
    throw new Error(`${label} snippet span exceeds ${MAX_SNIPPET_SPAN} lines`);
  }
  const side = o.side;
  if (side !== undefined && side !== 'old' && side !== 'new') {
    throw new Error(`${label} side must be "old" or "new" when set`);
  }
  const note = o.note;
  if (note !== undefined && (typeof note !== 'string' || !note.trim())) {
    throw new Error(`${label} note must be a non-empty string when set`);
  }
  return {
    kind: 'snippet',
    file: file.trim(),
    start: Math.floor(start),
    end: Math.floor(end),
    ...(side ? { side } : {}),
    ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
  };
}

function normalizeFileItem(
  raw: unknown,
  label: string,
  opts: NormalizePresentationOptions,
): PresentationFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const file = o.file;
  if (typeof file !== 'string' || !file.trim()) {
    throw new Error(`${label} file must be a non-empty string`);
  }
  const note = o.note;
  if (note !== undefined && (typeof note !== 'string' || !note.trim())) {
    throw new Error(`${label} note must be a non-empty string when set`);
  }
  // `matched` is ours to write, never the caller's — see
  // {@link NormalizePresentationOptions.resolved}. A caller-supplied one is
  // DROPPED here unless this is the save boundary re-normalizing what the
  // expansion boundary already resolved.
  const matched = opts.resolved ? o.matched : undefined;
  if (matched !== undefined) {
    if (!Array.isArray(matched) || matched.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new Error(`${label} matched must be an array of non-empty paths when set`);
    }
  }
  return {
    kind: 'file',
    file: file.trim(),
    ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
    ...(Array.isArray(matched) ? { matched: (matched as string[]).map((p) => p.trim()) } : {}),
  };
}

function normalizeItem(
  raw: unknown,
  label: string,
  opts: NormalizePresentationOptions,
): PresentationItem {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'snippet') return normalizeSnippet(raw, label);
  if (kind === 'file') return normalizeFileItem(raw, label, opts);
  if (kind === 'prose') return normalizeProse(raw, label);
  throw new Error(`${label} has unknown kind ${JSON.stringify(kind)}; expected snippet, file, or prose`);
}

function normalizeScreenshots(raw: unknown): PresentationScreenshot[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('presentation.screenshots must be an array');
  }
  if (raw.length > MAX_SCREENSHOTS) {
    // Same reasoning as the snippet span: a thirteenth screenshot leaves no
    // file unassigned, so this stays a validation error rather than a cap the
    // reviewer is told the partition was cut down for.
    throw new Error(`presentation.screenshots exceeds ${MAX_SCREENSHOTS} images`);
  }
  const shots: PresentationScreenshot[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const label = `presentation.screenshots[${i}]`;
    if (!s || typeof s !== 'object') {
      throw new Error(`${label} must be an object`);
    }
    const o = s as Record<string, unknown>;
    const artifact = o.artifact;
    if (typeof artifact !== 'string' || !artifact.trim()) {
      throw new Error(`${label}.artifact must be a non-empty artifact name`);
    }
    const caption = o.caption;
    if (caption !== undefined && (typeof caption !== 'string' || !caption.trim())) {
      throw new Error(`${label}.caption must be a non-empty string when set`);
    }
    shots.push({
      artifact: artifact.trim(),
      ...(typeof caption === 'string' && caption.trim() ? { caption: caption.trim() } : {}),
    });
  }
  return shots;
}

/** MIME types the review page will render inline as a screenshot. */
const IMAGE_MIME_PREFIX = 'image/';
/**
 * SVG is an image type the review page deliberately will NOT serve: it is a
 * document that can carry script, and artifacts are agent-authored. The
 * serving route refuses it, so the report call refuses it too — same answer at
 * both ends rather than a report that validates and then renders broken.
 */
const REFUSED_IMAGE_MIME = 'image/svg+xml';

export interface ScreenshotArtifactRef {
  name: string;
  mime_type: string;
}

/**
 * Resolve declared screenshots against the task's artifacts, and FAIL LOUDLY
 * naming the artifact when one is missing or is not an image.
 *
 * Split from shape validation because it needs the task's artifact list, which
 * only the tool boundary has. Validating here rather than at render time is the
 * point: a report that names an artifact nobody attached must be rejected while
 * the agent can still fix it, not degrade into a broken image on review.
 */
export function assertScreenshotsResolvable(
  screenshots: readonly PresentationScreenshot[],
  artifacts: readonly ScreenshotArtifactRef[],
): void {
  const byName = new Map(artifacts.map((a) => [a.name, a]));
  for (const shot of screenshots) {
    const artifact = byName.get(shot.artifact);
    if (!artifact) {
      const known = artifacts.map((a) => a.name);
      throw new Error(
        `presentation screenshot names artifact '${shot.artifact}', which is not attached to this task. ` +
          (known.length > 0
            ? `Attached artifacts: ${known.join(', ')}.`
            : 'This task has no artifacts.') +
          ' Attach the image with lazy_artifact_add first.',
      );
    }
    const mime = artifact.mime_type.toLowerCase();
    if (!mime.startsWith(IMAGE_MIME_PREFIX)) {
      throw new Error(
        `presentation screenshot artifact '${shot.artifact}' is ${artifact.mime_type}, not an image. ` +
          'Screenshots must be image artifacts (png, jpeg, gif, webp).',
      );
    }
    if (mime === REFUSED_IMAGE_MIME) {
      throw new Error(
        `presentation screenshot artifact '${shot.artifact}' is SVG, which the review page does not render ` +
          '(an SVG is a scriptable document, not a screenshot). Attach a raster capture (png, jpeg, gif, webp) instead.',
      );
    }
  }
}

export interface NormalizePresentationOptions {
  /**
   * Trust a file item's `matched` — ONLY for re-normalizing a walkthrough the
   * expansion boundary has already resolved (storage normalizes again on
   * save, and must not strip a resolved pattern back to an unresolved one).
   *
   * Default FALSE, and that default is the rule: `matched` says which files a
   * group OWNS, and the partition's credibility is that we resolved it
   * against the task's own diff. A caller-supplied one would claim paths no
   * pattern ever matched — lifting them out of "Other changes" without ever
   * facing the "this pattern matches nothing you changed" refusal — so every
   * external surface drops it and lets expansion be the only writer.
   */
  resolved?: boolean;
}

/**
 * Validate presentation at the MCP boundary. Returns undefined when omitted.
 *
 * Groups are optional as long as screenshots are present: showing the reviewer
 * a picture of what was built is a complete presentation on its own.
 */
export function normalizeReviewPresentation(
  raw: unknown,
  opts: NormalizePresentationOptions = {},
): ReviewPresentation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object') {
    throw new Error('presentation must be an object');
  }
  const screenshots = normalizeScreenshots((raw as { screenshots?: unknown }).screenshots);
  const groupsRaw = (raw as { groups?: unknown }).groups ?? [];
  if (!Array.isArray(groupsRaw)) {
    throw new Error('presentation.groups must be an array');
  }
  if (groupsRaw.length === 0 && screenshots.length === 0) {
    throw new Error('presentation must declare groups, screenshots, or both');
  }
  if (groupsRaw.length > MAX_GROUPS) {
    throw new PresentationCapError('groups', groupsRaw.length);
  }

  const groups: PresentationGroup[] = [];
  let fileItems = 0;
  let narrativeItems = 0;
  for (let gi = 0; gi < groupsRaw.length; gi++) {
    const g = groupsRaw[gi];
    if (!g || typeof g !== 'object') {
      throw new Error(`presentation.groups[${gi}] must be an object`);
    }
    const o = g as Record<string, unknown>;
    const title = o.title;
    const tier = o.tier;
    const itemsRaw = o.items;
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error(`presentation.groups[${gi}].title must be a non-empty string`);
    }
    if (!isPresentationTier(tier)) {
      throw new Error(
        `presentation.groups[${gi}].tier must be one of ${PRESENTATION_TIERS.join(', ')}`,
      );
    }
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      throw new Error(`presentation.groups[${gi}].items must be a non-empty array`);
    }
    const summary = o.summary;
    if (summary !== undefined && (typeof summary !== 'string' || !summary.trim())) {
      throw new Error(`presentation.groups[${gi}].summary must be a non-empty string when set`);
    }
    const id = o.id;
    if (id !== undefined && (typeof id !== 'string' || !id.trim())) {
      throw new Error(`presentation.groups[${gi}].id must be a non-empty string when set`);
    }

    const items: PresentationItem[] = [];
    for (let ii = 0; ii < itemsRaw.length; ii++) {
      const item = normalizeItem(itemsRaw[ii], `presentation.groups[${gi}].items[${ii}]`, opts);
      // Counted after normalization, so the two caps count the two kinds of
      // item they actually govern rather than raw array entries. The check is
      // after the whole walkthrough is read (below), so a refusal reports how
      // many items the agent really declared — the number the recorded refusal
      // shows the reviewer — not the one that happened to cross the line.
      if (item.kind === 'file') fileItems++;
      else narrativeItems++;
      items.push(item);
    }

    groups.push({
      title: title.trim(),
      tier,
      items,
      ...(typeof summary === 'string' && summary.trim() ? { summary: summary.trim() } : {}),
      ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}),
    });
  }

  if (fileItems > MAX_FILE_ITEMS) throw new PresentationCapError('file_items', fileItems);
  if (narrativeItems > MAX_NARRATIVE_ITEMS) {
    throw new PresentationCapError('narrative_items', narrativeItems);
  }

  return { groups, ...(screenshots.length > 0 ? { screenshots } : {}) };
}

// -------------------------------------------------------------------------
// File items that claim MORE THAN ONE path: directories and globs.
//
// A walkthrough of a release-sized branch is only writable if a 40-file test
// mass can cost one slot instead of forty. The pattern is what the agent
// wrote; the paths it claimed are resolved ONCE, against the task's diff
// range, and persisted next to it — so the partition a reviewer navigates is
// the same set of files tomorrow, after commits the walkthrough never saw.

/** Glob metacharacters that make a file item a pattern rather than a path. */
const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * Whether a file item's value LOOKS like a pattern — a directory (trailing
 * `/`) or a glob — rather than a literal path.
 *
 * A directory must carry the trailing slash: `src/review` is a legal file
 * path, and guessing which one an agent meant is exactly the auto-detection
 * "clever ain't wise" rules out. The tool description and the prompt both say
 * so, and a directory written without the slash fails the no-match check
 * below naming the fix.
 *
 * SYNTAX ONLY, and never the last word: a path that exactly matches one of
 * the task's changed files is a literal claim whatever it looks like (see
 * {@link expandPresentationPatterns}). `app/blog/[slug]/page.tsx` is the
 * standard Next.js/SvelteKit dynamic-route spelling and reads here as a glob
 * whose character class matches nothing. Callers without the diff in hand —
 * only `hasPatternItem`, deciding whether git has to be read at all — use
 * this as the cheap over-approximation it is: a false positive there costs a
 * git read, never a wrong answer.
 */
export function isPathPattern(value: string): boolean {
  return value.endsWith('/') || GLOB_MAGIC.test(value);
}

/**
 * A directory claim that also carries glob characters (`src`, star, slash) —
 * which is neither thing and cannot be guessed.
 *
 * The trailing slash takes the directory branch, where the glob characters
 * are matched literally against path prefixes, so it can only ever claim
 * nothing. Refused with both spellings named rather than silently answering
 * a question nobody asked.
 */
function isAmbiguousDirectoryGlob(value: string): boolean {
  return value.endsWith('/') && GLOB_MAGIC.test(value.slice(0, -1));
}

/** The diff paths a pattern claims out of `diffPaths`, in diff order. */
export function matchPattern(pattern: string, diffPaths: readonly string[]): string[] {
  if (pattern.endsWith('/')) {
    return diffPaths.filter((p) => p.startsWith(pattern));
  }
  const glob = new Bun.Glob(pattern);
  return diffPaths.filter((p) => glob.match(p));
}

/**
 * The paths ONE file item claims: a pattern's resolved matches, or the
 * literal path it names.
 *
 * The single reader of "what does this item claim" — every membership rule
 * (the residual computation, the double-claim refusal, a region row's files,
 * the id-matching file overlap) goes through it, so a pattern is a claim
 * everywhere or nowhere.
 */
export function fileItemPaths(item: PresentationFile): string[] {
  return item.matched ?? [item.file];
}

/**
 * Resolve every pattern file item against the diff range, and REFUSE a
 * pattern that matches nothing (`external-surfaces-validate-inputs`): a
 * walkthrough whose group claims `src/reivew/` silently claims no files, and
 * the reviewer sees the whole group's worth of real files in "Other changes"
 * with nothing saying why.
 *
 * Pure, and the one place expansion happens; the caller supplies the range's
 * paths. Literal items are returned untouched — including a literal path the
 * diff does not contain, which stays legal exactly as before (a walkthrough
 * may name a path the rendered range filtered away, and the renderer already
 * says so where it would have drawn it).
 */
export function expandPresentationPatterns(
  groups: readonly PresentationGroup[],
  diffPaths: readonly string[],
): PresentationGroup[] {
  // INVARIANT: a value that IS one of the task's changed paths is a literal
  // claim, whatever punctuation it contains — decided before any pattern
  // interpretation. `app/blog/[slug]/page.tsx` is how Next.js and SvelteKit
  // spell a dynamic route, and read as a glob its `[slug]` is a character
  // class matching one of `s`, `l`, `u`, `g`: it claims nothing, the no-match
  // check throws, and the agent's WHOLE report call fails on a file item that
  // is a plain correct path with no other spelling available. A literal that
  // is also somebody's glob cannot mislead in the other direction: an agent
  // who means a pattern does not write one that happens to be a changed
  // file's exact name.
  const changed = new Set(diffPaths);
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (item.kind !== 'file') return item;
      if (changed.has(item.file) || !isPathPattern(item.file)) {
        // A literal path claims itself and nothing else. Normalization has
        // already dropped any `matched` the caller sent; this drops one a
        // previous expansion left on an item whose pattern was later edited
        // into a plain path.
        const { matched: _dropped, ...literal } = item;
        return literal;
      }
      if (isAmbiguousDirectoryGlob(item.file)) {
        throw new Error(
          `presentation file item '${item.file}' mixes a directory claim (the trailing "/") ` +
            'with glob characters, and lazy will not guess which you meant. Write a glob ' +
            `('${item.file.replace(/\/$/, '')}/**' claims everything under the matches) or a ` +
            'plain directory (e.g. "src/review/").',
        );
      }
      const matched = matchPattern(item.file, diffPaths);
      if (matched.length === 0) {
        throw new Error(
          `presentation file item '${item.file}' matches no file this task changed. ` +
            'A directory must end with "/" (e.g. "src/review/"); a glob matches paths ' +
            'relative to the repository root (e.g. "test/e2e/regions*.test.ts"). ' +
            'Check the pattern against lazy_diff, or claim the files individually.',
        );
      }
      return { ...item, matched };
    }),
  }));
}

/**
 * The paths the walkthrough CLAIMS — its membership, and the one answer to
 * "what did the agent account for" that every surface uses.
 *
 * `kind: 'file'` items only, a pattern contributing everything it resolved
 * to. A snippet is a story beat, not a claim (final-turn design §6.1): a file
 * that is only quoted belongs to nobody, so it is residual, and a sign-off on
 * the group that quoted it covers nothing of it.
 *
 * This used to have a snippet-aware twin for the web Changes block, left over
 * from the design that preceded the partition. The two disagreed by exactly
 * the snippet-only files, so one page could tell a reviewer "5 of 277 files
 * are not named" on the Changes card and "17 of 277" on the Regions tab,
 * about one walkthrough at one head. Two numbers for one question is worse
 * than either number, so there is now one rule.
 */
export function fileClaimsFromGroups(groups: readonly PresentationGroup[]): Set<string> {
  const paths = new Set<string>();
  for (const g of groups) {
    for (const item of g.items) {
      if (item.kind !== 'file') continue;
      for (const path of fileItemPaths(item)) paths.add(path);
    }
  }
  return paths;
}

export interface AppendResidualOptions {
  /** Paths matching [[automation.maintain]] land in a docs-tier group, never "Other". */
  isMaintainedPath?: (path: string) => boolean;
  /**
   * The walkthrough's CLAIMS, when they differ from the `presented` set that
   * decides which files the residual block RENDERS. The count is computed
   * from these; membership from `presented`.
   *
   * They differ on exactly one surface and for a good reason. The web Changes
   * block does not re-card a file some group already quoted as a snippet —
   * the reviewer has seen that diff, in its story — but a quote is not a
   * claim (final-turn design §6.1), so the file is unaccounted for and every
   * region surface puts it in the residual REGION. Counting per surface made
   * one page say "5 of 277 files are not named" on the Changes card and
   * "17 of 277" on the Regions tab, about one walkthrough at one head; the
   * count now answers the partition's question everywhere, and the block
   * still shows only the diffs that are nowhere else on the page.
   */
  claimed?: Set<string>;
  /**
   * A cap the task's walkthrough was refused for, if one was recorded with
   * the report being rendered. Stated on the residual group, because a
   * reviewer looking at an unassigned block has no other way to tell "the
   * agent did not place these" from "the agent could not".
   */
  capRefusal?: PresentationCapRefusal;
  /** Whether that refusal was recorded with the walkthrough being shown. */
  capRefusalSameReport?: boolean;
}

/**
 * How much of the change the walkthrough did not name, and — when one was
 * recorded — the cap that forced it.
 *
 * ONE sentence, from the WHOLE residual, said in ONE place. It is computed
 * from every unnamed path, not from the block it is printed on: the web
 * Changes card splits maintained paths into their own block, and a per-block
 * count made that surface say "5 of 277" while the region surfaces — which
 * never split — said 17 about the same walkthrough. Two numbers for one
 * question is worse than the number being on the wrong card.
 */
export function residualSummary(
  omitted: number,
  totalChanged: number,
  capRefusal?: PresentationCapRefusal,
  capRefusalSameReport = true,
): string {
  const head =
    `${omitted} of ${totalChanged} changed file${totalChanged === 1 ? '' : 's'} ` +
    `${omitted === 1 ? 'is' : 'are'} not named in the walkthrough.`;
  return capRefusal
    ? `${head} ${capRefusalLine(capRefusal, { residual: true, sameReport: capRefusalSameReport })}`
    : head;
}

/**
 * The maintained block's own line: it explains a SPLIT, never a second count.
 *
 * Self-contained on purpose — display order puts this block ABOVE the one
 * carrying the residual sentence, so a line beginning "of those" would have
 * no antecedent by the time it is read.
 */
function maintainedSplitNote(count: number): string {
  return (
    `${count} of the files the walkthrough did not name ` +
    `${count === 1 ? 'is a maintained file' : 'are maintained files'}, shown separately.`
  );
}

/**
 * Append system-added residual groups for diff paths the agent omitted.
 * INVARIANT: non-suppressible — trust depends on completeness.
 * Maintained paths (when `isMaintainedPath` is set) are split out so reviewers
 * always see CHANGELOG/docs updates without opening Other changes.
 */
export function appendResidualGroup(
  groups: PresentationGroup[],
  diffPaths: string[],
  presented: Set<string>,
  options: AppendResidualOptions = {},
): PresentationGroup[] {
  const omitted = diffPaths.filter((p) => !presented.has(p)).sort();
  // What the walkthrough left UNCLAIMED, which is what the sentence counts —
  // the same number on every surface (see AppendResidualOptions.claimed).
  const claimed = options.claimed ?? presented;
  const unclaimed = claimed === presented
    ? omitted.length
    : diffPaths.filter((p) => !claimed.has(p)).length;
  // Nothing left over: no residual group, and no phantom one to carry a cap
  // line. A refusal is still not lost — the region surfaces carry it as a
  // cover note (`presentedRegions`), which is the channel for something true
  // of the whole review rather than of one group's files.
  if (omitted.length === 0) return groups;

  const isMaintained = options.isMaintainedPath;
  const maintained = isMaintained
    ? omitted.filter((p) => isMaintained(p))
    : [];
  const other = isMaintained
    ? omitted.filter((p) => !isMaintained(p))
    : omitted;

  // The count is stated rather than left to be inferred from the card list,
  // and the cap — when one was recorded — rides with it: this is the block
  // the reviewer is deciding how to read, and "the agent did not place these"
  // and "the agent could not" are different answers. It counts the WHOLE
  // residual, wherever the blocks below put the files.
  const summary = residualSummary(
    unclaimed,
    diffPaths.length,
    options.capRefusal,
    options.capRefusalSameReport,
  );

  const out = [...groups];
  if (maintained.length > 0) {
    out.push({
      title: 'Maintained files',
      tier: 'docs',
      // The sentence belongs to "Other changes" whenever there is one. With
      // every leftover maintained there is no such block, and this one holds
      // what is left — so it carries the sentence, and with it the cap line
      // that must not disappear because the only unnamed files happened to be
      // a CHANGELOG entry.
      summary: other.length > 0 ? maintainedSplitNote(maintained.length) : summary,
      items: maintained.map((file) => ({ kind: 'file' as const, file })),
    });
  }
  if (other.length > 0) {
    out.push({
      title: 'Other changes',
      tier: 'other',
      summary,
      items: other.map((file) => ({ kind: 'file' as const, file })),
    });
  }
  return out;
}

/** Sort groups for review display: tier rank first, then agent narrative order. */
export function sortPresentationGroupsForDisplay(
  groups: PresentationGroup[],
): PresentationGroup[] {
  return groups
    .map((g, index) => ({ g, index }))
    .sort((a, b) => {
      const rankDiff = TIER_DISPLAY_RANK[a.g.tier] - TIER_DISPLAY_RANK[b.g.tier];
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ g }) => g);
}

/** Whether a tier defaults to expanded on first paint. */
export function tierExpandedByDefault(tier: PresentationTier): boolean {
  // Docs (and maintained-file residuals) rank above core — show them expanded.
  return tier === 'core' || tier === 'docs';
}

// -------------------------------------------------------------------------
// Region ids and the whole-file partition boundary (final-turn design §6.1).
//
// A presentation is the task's review REGIONS (§6): each group becomes a
// region the reviewer can scope, name, own and sign off. That makes two
// things storage's job at the save boundary, where every writer funnels
// through and where the task's previous presentation is in reach:
//
//   - every group carries a STABLE id, so overlays and sign-offs survive a
//     re-sent report (the realistic re-send being a wrap-up recovery that
//     retitles or regroups a group or two);
//   - `kind: 'file'` items are claims of MEMBERSHIP, and a file claimed by
//     two groups is not a walkthrough but a contradiction — refused here,
//     while the agent that wrote it can still fix the report, not at render
//     time when a partition quietly double-counts a file.

/** Longest slug: enough to stay readable, short enough to stay a URL fragment. */
const MAX_SLUG = 40;

/** Lowercase, non-alphanumerics collapsed to dashes, capped, never empty. */
export function slugifyGroupTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || 'group';
}

/**
 * The id a presentation group is known by on every region surface.
 *
 * Storage mints one at the save boundary (see {@link assignPresentationGroupIds}),
 * so every report saved since carries ids; this fallback covers reports stored
 * before that and must agree with the mint rule — a legacy report re-sent
 * gets minted to the same id the fallback derives.
 */
export function groupIdOf(group: Pick<PresentationGroup, 'id' | 'title'>): string {
  return group.id ?? slugifyGroupTitle(group.title);
}

/**
 * The paths a group's items REFERENCE — `file` claims and snippet targets
 * alike. This is the presented-set rule the residual computation uses; a
 * snippet is a story about a file, not a claim of it.
 */
function groupReferencedFiles(group: PresentationGroup): string[] {
  return group.items.flatMap((item) =>
    item.kind === 'file'
      ? fileItemPaths(item)
      : item.kind === 'snippet'
        ? [item.file]
        : [],
  );
}

/**
 * Mint stable ids for a presentation's groups at the save boundary.
 *
 * Regions, overlays and sign-offs are keyed by id across sessions, so an id
 * must survive the report being re-sent. Resolution per group, in order:
 *
 *   1. an id the agent declared — honored as-is (and refused when it collides
 *      with another declared id: two groups answering to one id would silently
 *      merge their overlays);
 *   2. a previous group with the same title — its id;
 *   3. the UNIQUE previous group sharing referenced files with this one — its
 *      id, so a retitled group does not orphan the overlays hanging on it;
 *   4. a fresh slug from the title, deduped with -2, -3, … against ids this
 *      assignment has already handed out (declared or minted).
 *
 * File-overlap matching only breaks ties for retitled groups: a rewrite of
 * the whole walkthrough reorders everything, and an ambiguity there must fall
 * through to a fresh slug rather than guess.
 *
 * INVARIANT: every id this returns is UNIQUE — on a re-send exactly as on the
 * first report. Regions are the human review surface and are keyed by id, so
 * two groups answering to one id collapse into a single region: `lazy diff
 * --region <id>` then shows one group's files and silently omits the other's,
 * and a sign-off recorded against that id covers files nobody reviewed. That is
 * the same failure the declared-id collision check above refuses, arriving by
 * the back door. A previous group is therefore CONSUMED by the first new group
 * that matches it (by title or by file overlap), and a previous id is a
 * candidate only while `used` does not already hold it — which also stops a
 * freshly minted slug from being handed out a second time as a reused id.
 */
export function assignPresentationGroupIds(
  groups: PresentationGroup[],
  previous: readonly PresentationGroup[] = [],
): PresentationGroup[] {
  const used = new Set<string>();
  const out: PresentationGroup[] = [];

  // Declared ids first, so minting cannot step on one.
  for (let i = 0; i < groups.length; i++) {
    const id = groups[i]!.id?.trim();
    if (!id) continue;
    if (used.has(id)) {
      throw new Error(
        `presentation.groups[${i}].id '${id}' is already used by another group in this presentation — ` +
          'group ids must be unique.',
      );
    }
    used.add(id);
  }

  // Only id-bearing previous groups can lend an id, and only while that id is
  // still free. `used` grows as ids are handed out, so filtering on it at MATCH
  // time is what consumes a previous group: the second new group with the same
  // title, or overlapping the same previous files, no longer sees it.
  type PreviousWithId = PresentationGroup & { id: string };
  const candidates = (): PreviousWithId[] =>
    previous.filter((p): p is PreviousWithId => Boolean(p.id) && !used.has(p.id!));

  for (const g of groups) {
    const declared = g.id?.trim();
    if (declared) {
      out.push({ ...g, id: declared });
      continue;
    }

    const available = candidates();
    const byTitle = available.find((p) => p.title === g.title);
    if (byTitle) {
      used.add(byTitle.id);
      out.push({ ...g, id: byTitle.id });
      continue;
    }

    const referenced = groupReferencedFiles(g);
    let overlap: { id: string; count: number } | null = null;
    let tie = false;
    for (const p of available) {
      const pFiles = new Set(groupReferencedFiles(p));
      const count = referenced.filter((f) => pFiles.has(f)).length;
      if (count === 0) continue;
      if (overlap && count === overlap.count) {
        tie = true;
      } else if (!overlap || count > overlap.count) {
        overlap = { id: p.id, count };
        tie = false;
      }
    }
    if (overlap && !tie) {
      used.add(overlap.id);
      out.push({ ...g, id: overlap.id });
      continue;
    }

    const base = slugifyGroupTitle(g.title);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    out.push({ ...g, id: candidate });
  }

  // Unreachable while the rule above holds — and a loud failure rather than a
  // silently merged region if a later edit breaks it. This is the save
  // boundary, the same one that refuses colliding declared ids.
  const minted = new Set(out.map((g) => g.id));
  if (minted.size !== out.length) {
    throw new Error(
      'presentation group ids are not unique after assignment ' +
        `(${out.map((g) => g.id).join(', ')}) — regions key on them and would silently merge.`,
    );
  }
  return out;
}

/**
 * INVARIANT (final-turn design §6.1): a `kind: 'file'` item claims the file
 * WHOLE — it is the group's share of a partition, so two groups claiming the
 * same file cannot both be rendered as regions. Refused at the boundary,
 * naming both groups and the path. Snippets are narrative, not membership: a
 * snippet referencing another group's file is exactly how a second group
 * talks about a file it does not own, and is accepted.
 *
 * A PATTERN claims every path it resolved to, so the rule reads through
 * {@link fileItemPaths} and the refusal names the pattern the path came in
 * under: two groups whose globs overlap is the same contradiction as two
 * groups naming one path, and the message has to say which patterns to
 * narrow.
 */
export function assertNoWholeFileClaimTwice(groups: readonly PresentationGroup[]): void {
  const claimByPath = new Map<string, { label: string; index: number; via: string }>();
  for (let gi = 0; gi < groups.length; gi++) {
    const title = groups[gi]!.title;
    for (const item of groups[gi]!.items) {
      if (item.kind !== 'file') continue;
      for (const path of fileItemPaths(item)) {
        const prior = claimByPath.get(path);
        if (prior) {
          const under = (pattern: string) =>
            pattern === path ? '' : ` (under '${pattern}')`;
          throw new Error(
            `presentation.groups[${prior.index}] ('${prior.label}')${under(prior.via)} and ` +
              `presentation.groups[${gi}] ('${title}')${under(item.file)} both claim '${path}' ` +
              'as a file item — a file belongs to exactly one group. Keep the claim in one group ' +
              '(narrow the pattern if it is a directory or glob), or reference the file from the ' +
              "other group's narrative as a snippet instead.",
          );
        }
        claimByPath.set(path, { label: title, index: gi, via: item.file });
      }
    }
  }
}
