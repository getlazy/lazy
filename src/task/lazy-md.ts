/**
 * LAZY.md — per-project instructions written for agents running lazy tasks.
 *
 * Claude Code reads CLAUDE.md by itself, and codex/cursor read their own
 * equivalents, so lazy never injected project instructions. That leaves nowhere
 * to write the things that are true ONLY when an agent is running under lazy —
 * "run the suite this way inside the lazy container", "this project's services
 * come up with X in a task worktree" — because a human editing CLAUDE.md is
 * writing for every session, including their own interactive ones. LAZY.md is
 * that place, and lazy injects it because no harness knows the file exists.
 *
 * DISCOVERY follows Claude Code's CLAUDE.md rules as far as they can apply
 * (verified against the Claude Code memory docs, 2026-09-10):
 *
 *   - Claude Code loads CLAUDE.md from the working directory and EVERY
 *     directory above it, concatenated filesystem-root-first so the file
 *     closest to the working directory is read last. {@link collectLazyMdFiles}
 *     walks the same chain, from `startDir` up to `root`.
 *   - Claude Code discovers CLAUDE.md files in SUBDIRECTORIES too, but loads
 *     them ON DEMAND — when the agent reads a file in that directory. Lazy has
 *     no hook into an agent's file reads, so on-demand is not available to it:
 *     a nested LAZY.md is either loaded up front or never. It is loaded up
 *     front, ordered shallowest-first after the ancestor chain, under one
 *     shared character budget. That is the whole reason a budget exists here
 *     and not in Claude Code's design. The nested sweep skips directories the
 *     project's cascading `.gitignore` files ignore (loaded per directory as
 *     the walk reaches it) and every dot-directory (so `.lazy` can never leak
 *     one task's instructions into another).
 *
 * A task agent's working directory IS the worktree root today, so the ancestor
 * walk collapses to a single file and the nested sweep is what makes "multiples"
 * real. The walk is still written as a walk: if lazy ever lets a task declare
 * the directory it starts in, this needs no change.
 *
 * LAZY.md is GUIDANCE, never authority. It is read from the task's WORKTREE —
 * the same copy the agent's own CLAUDE.md comes from, so an agent's instructions
 * match the tree it is working in. That is deliberately unlike `lazy.toml`,
 * which is root-anchored precisely because it decides the rules a turn runs
 * under (CLAUDE.md, "A task worktree's lazy.toml has no authority"). Nothing in
 * LAZY.md can widen a permission, change a check, or pick a model; the worst a
 * branch can do by editing it is give its own next turn worse advice, exactly as
 * with CLAUDE.md.
 */

import { readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

import lazyMdContextTemplate from '../prompts/lazy-md-context.md' with { type: 'text' };
import { readWorktreeFileNoFollow } from '../review/worktree-read';
import { GitIgnoreCascade } from './lazy-md-gitignore';

/** The instruction file agents running lazy tasks are handed. */
export const LAZY_MD_FILENAME = 'LAZY.md';

/**
 * Total characters of LAZY.md content injected into one prompt.
 *
 * Every launch pays this before the agent has read a line of code, so it is
 * capped rather than trusted. 40k characters is roughly the per-file limit
 * Claude Code itself warns a single CLAUDE.md past (see `claudeMdCharLimit` in
 * src/context-budget.ts) — a project whose lazy-specific instructions exceed
 * that is not being served by loading all of them anyway. Files past the budget
 * are NAMED in the injected text rather than silently dropped: an agent told
 * nothing would treat a partial set as the complete one. Collection stops at
 * the first file that does not fit — later (often smaller, nested) files must
 * not displace earlier ancestor-chain instructions.
 */
export const LAZY_MD_CHAR_BUDGET = 40_000;

/** How deep below the root the nested sweep looks for a LAZY.md (directory segments). */
export const LAZY_MD_MAX_DEPTH = 6;

/** One discovered LAZY.md. */
export interface LazyMdFile {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the discovery root, POSIX-separated, e.g. `services/api/LAZY.md`. */
  relativePath: string;
  content: string;
}

/** What {@link collectLazyMdFiles} found, after the budget was applied. */
export interface LazyMdCollection {
  /** Files whose content is injected, in the order they are injected. */
  files: LazyMdFile[];
  /** Relative paths discovered but left out because the budget was reached. */
  skipped: string[];
}

/** Normalize a relative path to POSIX separators for stable labels and ordering. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Read a regular file under the discovery root without following symlinks.
 *
 * The worktree is agent-writable: a turn can plant `LAZY.md` (or `.gitignore`)
 * as a symlink to a host path. A plain `readFile` would follow it on the HOST
 * when the daemon builds the next system prompt — the same confused-deputy
 * class already fixed for review expand (`readWorktreeFileNoFollow`). Missing,
 * non-regular, and outside-the-worktree paths all contribute nothing; a prompt
 * layer must never be why a turn fails to start.
 */
async function readWorktreeText(root: string, relativePath: string): Promise<string | null> {
  const result = await readWorktreeFileNoFollow(root, relativePath);
  return result.kind === 'content' ? result.content : null;
}

/**
 * The ancestor chain from `startDir` up to and including `root`, ordered
 * ROOT-FIRST — so the file closest to where the agent starts is read last, the
 * way Claude Code orders CLAUDE.md.
 *
 * A `startDir` outside `root` (or equal to it) yields just the root.
 */
export function ancestorChain(root: string, startDir: string): string[] {
  const rel = relative(root, startDir);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return [root];
  const chain: string[] = [root];
  let current = root;
  for (const segment of rel.split(sep)) {
    if (segment === '' || segment === '.') continue;
    current = join(current, segment);
    chain.push(current);
  }
  return chain;
}

/** One directory on the nested-sweep BFS frontier, with the ignore cascade that applies to its children. */
interface SweepNode {
  /** Absolute path of the directory. */
  dir: string;
  /** POSIX path relative to the discovery root (`''` at root). */
  rel: string;
  /** `.gitignore` layers from the root down through this directory. */
  ignore: GitIgnoreCascade;
}

/**
 * Every LAZY.md below `root` that is not already on the ancestor chain,
 * shallowest-first and alphabetical within a depth.
 *
 * Bounded by construction: directories ignored by the project's cascading
 * `.gitignore` files (loaded per directory as the sweep reaches it),
 * dot-directories (a hard skip — `.lazy` holds other tasks' worktrees),
 * symbolic links (never followed — see {@link readWorktreeText}), and
 * {@link LAZY_MD_MAX_DEPTH}. An unreadable directory is skipped, not thrown —
 * a prompt layer never fails a launch.
 */
async function sweepNested(root: string, exclude: Set<string>): Promise<string[]> {
  const found: string[] = [];
  const rootIgnore = new GitIgnoreCascade();
  rootIgnore.push('', await readWorktreeText(root, '.gitignore'));
  let frontier: SweepNode[] = [{ dir: root, rel: '', ignore: rootIgnore }];

  // depth is the directory's distance below the root (0 = root). Process
  // directories at depths 0..=MAX so a LAZY.md MAX segments below the root is
  // still found; children past that are enqueued but never visited.
  for (let depth = 0; depth <= LAZY_MD_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: SweepNode[] = [];
    for (const node of frontier.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
      let entries;
      try {
        entries = await readdir(node.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        // Never follow symlinks out of (or even within) the worktree: a linked
        // directory would let the sweep leave the tree, and a linked LAZY.md
        // would be read on the host when building the prompt.
        if (entry.isSymbolicLink()) continue;
        const full = join(node.dir, entry.name);
        if (entry.isDirectory()) {
          // Dot-dirs are a hard skip, not a gitignore decision: `.lazy` holds
          // every other task's worktree, and sweeping it would inject one task's
          // LAZY.md into another's prompt even when `.lazy/` is not gitignored.
          if (entry.name.startsWith('.')) continue;
          const childRel = node.rel ? `${node.rel}/${entry.name}` : entry.name;
          if (node.ignore.ignores(childRel, true)) continue;
          const childIgnore = node.ignore.clone();
          childIgnore.push(childRel, await readWorktreeText(root, `${childRel}/.gitignore`));
          next.push({ dir: full, rel: childRel, ignore: childIgnore });
        } else if (entry.isFile() && entry.name === LAZY_MD_FILENAME && !exclude.has(full)) {
          found.push(full);
        }
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Discover the LAZY.md files a turn starting in `startDir` should be handed.
 *
 * Order is the story the agent reads: the ancestor chain root-first, then
 * nested files shallowest-first. Content stops at {@link LAZY_MD_CHAR_BUDGET};
 * the first file that does not fit ends collection, and every later present
 * file is named in `skipped` so root instructions cannot be dropped in favour
 * of smaller nested ones.
 */
export async function collectLazyMdFiles(
  root: string,
  opts: { startDir?: string; budget?: number } = {},
): Promise<LazyMdCollection> {
  const budget = opts.budget ?? LAZY_MD_CHAR_BUDGET;
  const chain = ancestorChain(root, opts.startDir ?? root);
  const chainPaths = chain.map(dir => join(dir, LAZY_MD_FILENAME));
  const nested = await sweepNested(root, new Set(chainPaths));

  const files: LazyMdFile[] = [];
  const skipped: string[] = [];
  let used = 0;
  const candidates = [...chainPaths, ...nested];

  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i]!;
    const rel = toPosix(relative(root, path)) || LAZY_MD_FILENAME;
    const content = await readWorktreeText(root, rel);
    if (content === null) continue;
    if (used + content.length > budget) {
      // Fail closed on overflow: do not keep scanning for a later file that
      // happens to fit. Ancestor-chain files are primary; nested ones refine
      // them — injecting a leaf without the root would invert that story.
      skipped.push(rel);
      for (let j = i + 1; j < candidates.length; j++) {
        const laterRel = toPosix(relative(root, candidates[j]!)) || LAZY_MD_FILENAME;
        if ((await readWorktreeText(root, laterRel)) !== null) skipped.push(laterRel);
      }
      break;
    }
    used += content.length;
    files.push({ path, relativePath: rel, content });
  }

  return { files, skipped };
}

/**
 * Render a collection into the prompt section, or '' when nothing was found.
 *
 * Empty means empty: a project with no LAZY.md pays nothing and is told
 * nothing, the same way the shared-memory index stays out of a prompt until
 * there are records.
 */
export function renderLazyMdSection(collection: LazyMdCollection): string {
  if (collection.files.length === 0) return '';

  const body = collection.files
    .map(f => `### ${f.relativePath}\n\n${f.content.trim()}`)
    .join('\n\n');

  const skippedNotice =
    collection.skipped.length > 0
      ? `\n\nNOTE: these LAZY.md files were found but NOT loaded — the combined ` +
        `instructions passed lazy's ${LAZY_MD_CHAR_BUDGET.toLocaleString('en-US')}-character ` +
        `budget: ${collection.skipped.join(', ')}. Read one with your file tools if your work ` +
        `touches that part of the tree.`
      : '';

  // String.replace with a string replacement interprets `$`, `$&`, `$1`, …
  // in the replacement — a LAZY.md that mentions shell variables or prices
  // would be silently corrupted. A function replacement inserts the body
  // verbatim (same pattern as feedback-redelivery.ts).
  return lazyMdContextTemplate.replace('{{LAZY_MD_FILES}}', () => body).trimEnd() + skippedNotice;
}

/**
 * The LAZY.md section for a turn, ready to hand to `buildSystemPrompt`.
 *
 * Never throws: a launch must not fail because a project's instruction files
 * could not be read.
 */
export async function buildLazyMdSection(
  root: string,
  opts: { startDir?: string; budget?: number } = {},
): Promise<string> {
  try {
    return renderLazyMdSection(await collectLazyMdFiles(root, opts));
  } catch {
    // Every filesystem read below already handles its own failure; this is the
    // backstop for anything else (a root that is not a directory, an exotic
    // fs error on readdir). Injecting no instructions is a degraded turn;
    // refusing to launch over it would be a worse one.
    return '';
  }
}
