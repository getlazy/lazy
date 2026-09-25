/**
 * The guards that stand between `--root <path>` and a recursive delete.
 *
 * `lazy playground` takes a directory from its caller and, as a normal part of its
 * job, removes that directory and kills processes associated with it. Those are
 * exactly the two operations that must never trust a caller-supplied path, and
 * the flag is the command's own invitation to supply one. A mistyped `--root`,
 * or a `LAZY_PLAYGROUND_ROOT` set once in a shell profile and forgotten, is enough.
 *
 * Two independent checks, deliberately not collapsed into one:
 *
 *  1. **Shape** ({@link assertRootIsOwnable}) — some paths may never be a demo
 *     root at all, whatever they contain. Checked first, because it is the one
 *     that holds even when the directory does not exist yet.
 *  2. **Marker** ({@link classifyRoot}) — a directory that already has content
 *     must carry this command's own manifest before anything is removed.
 *
 * `lazy playground up` runs both through the same teardown path as `lazy playground down`,
 * so provisioning cannot become a way around them.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { resolve, sep } from 'path';
import { MANIFEST_FILE, MANIFEST_VERSION, type DemoManifest, type DemoPaths } from './paths';

/**
 * Directories a demo root may never be, nor contain.
 *
 * "Nor contain" is the point: `--root /` is obviously wrong, but `--root
 * /home/user` is the one that actually happens, and it is dangerous precisely
 * because `$HOME` sits underneath it. So the test is ancestry in BOTH
 * directions — a root that IS one of these, or one that would have one of these
 * inside it.
 */
function forbiddenRoots(): string[] {
  return [
    resolve('/'),
    resolve(homedir()),
    resolve(tmpdir()),
    // tmpdir() is /tmp on Linux and a per-user path under /var/folders on
    // macOS, so name the conventional ones explicitly rather than relying on it.
    '/tmp',
    '/var/tmp',
  ];
}

/** What a forbidden path IS, in words, so the refusal explains itself. */
function describe(path: string): string {
  if (path === resolve('/')) return 'the filesystem root';
  if (path === resolve(homedir())) return 'your home directory';
  return 'a shared temporary directory';
}

/** True when `ancestor` is `descendant` or contains it. */
function containsOrEquals(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return descendant.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/**
 * Refuse a root whose SHAPE makes it unsafe to own, whatever is inside it.
 *
 * Throws rather than returning a flag: there is no caller that should carry on
 * after this, and the message names the path so a mistyped flag is obvious.
 */
export function assertRootIsOwnable(root: string): void {
  const resolved = resolve(root);

  for (const forbidden of forbiddenRoots()) {
    if (containsOrEquals(resolved, forbidden)) {
      const relation = resolved === forbidden
        ? `${resolved} is ${describe(forbidden)}`
        : `${resolved} contains ${describe(forbidden)} (${forbidden})`;
      throw new Error(
        `Refusing to use ${resolved} as a playground root.\n\n` +
        `\`lazy playground\` owns its root completely — it removes the whole directory on \`down\`, ` +
        `and on \`up\` before provisioning. ${relation}, so owning it would put far more than a ` +
        `playground inside something this command deletes.\n\n` +
        `Pick a dedicated directory instead, e.g.  lazy playground up --root ~/.lazy-playground`,
      );
    }
  }
}

/** What a candidate demo root turns out to be. */
export type RootKind =
  /** Nothing there. Safe to create; nothing to remove. */
  | { kind: 'absent' }
  /** An empty directory. Safe to provision into; nothing to remove. */
  | { kind: 'empty' }
  /** Carries this command's manifest — a demo we own. */
  | { kind: 'demo' }
  /** Has content but no manifest. Never ours to delete. */
  | { kind: 'foreign'; entries: string[] };

/**
 * Decide what a root is, WITHOUT touching it.
 *
 * The manifest is the marker — but the marker is its CONTENT, never its
 * filename. `demo.json` is an entirely plausible name for a real project to
 * carry, and treating the name alone as authorisation meant a directory that
 * happened to contain one was removed whole, with no undo. So the file is
 * parsed and has to actually look like one of ours:
 *
 *  - it parses as JSON,
 *  - its `version` is the one this lazy writes, and
 *  - its `root` resolves to the very directory being classified.
 *
 * That last check is what stops a manifest copied, moved or restored from
 * somewhere else authorising the deletion of wherever it now sits.
 *
 * A `demo.json` that fails any of those is FOREIGN, not "no demo": a parse
 * failure must never fall through to a delete. Manifest writes are atomic
 * (`writeManifest`), so a half-written file is not a state this can reach.
 *
 * An EMPTY directory counts as neither ours nor foreign: creating the root
 * ahead of time is a normal thing for a caller to do (the e2e suite hands `up`
 * a fresh `mkdtemp`), and refusing it would make the command unusable for the
 * exact callers most likely to be careful.
 */
export async function classifyRoot(paths: DemoPaths): Promise<RootKind> {
  let isDir: boolean;
  try {
    isDir = (await stat(paths.root)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw new Error(`Cannot inspect the demo root ${paths.root}: ${(err as Error).message}`);
  }

  if (!isDir) {
    return { kind: 'foreign', entries: [] };
  }

  const entries = await readdir(paths.root);
  if (entries.length === 0) return { kind: 'empty' };
  if (!entries.includes(MANIFEST_FILE)) return { kind: 'foreign', entries };

  return (await manifestClaimsThisRoot(paths))
    ? { kind: 'demo' }
    : { kind: 'foreign', entries };
}

/**
 * Does the manifest in this root actually describe THIS root?
 *
 * Every failure answers no. There is deliberately no "close enough" branch:
 * this is the single predicate standing between `--root <path>` and an
 * irreversible recursive delete, so anything it cannot positively confirm is
 * treated as somebody else's directory.
 */
async function manifestClaimsThisRoot(paths: DemoPaths): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(paths.manifest, 'utf-8');
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) return false;
  const manifest = parsed as Partial<DemoManifest>;

  if (manifest.version !== MANIFEST_VERSION) return false;
  if (typeof manifest.root !== 'string' || manifest.root.length === 0) return false;

  return resolve(manifest.root) === resolve(paths.root);
}

/**
 * The refusal shown when a root has content this command did not put there.
 *
 * It names what it found, because the usual cause is a path that is one
 * character off from the intended one and seeing `src`, `package.json` in the
 * listing is what makes that obvious.
 */
export function foreignRootMessage(root: string, entries: string[], verb: string): string {
  const sample = entries.slice(0, 6).join(', ');
  const more = entries.length > 6 ? `, … (${entries.length} entries)` : '';
  return (
    `Refusing to ${verb} ${root}: it is not a lazy playground.\n\n` +
    `\`lazy playground\` removes its root completely, so it only ever touches a directory ` +
    `carrying its own ${MANIFEST_FILE} manifest. This one has content but no manifest:\n` +
    `  ${sample}${more}\n\n` +
    `If you meant a different directory, check the path. If this really was a playground ` +
    `and its manifest is gone, remove the directory yourself — lazy will not do it for you.`
  );
}
