/**
 * The task metadata keys the CLI writes, checked against the keys the Teams
 * proxy route admits.
 *
 * `storage:updateTaskMetadata` takes ANY key, and the daemon reads several
 * keys to make decisions (accept continuation, pairing, review settings,
 * pinned images). So the Rails route checks the KEY, not only the method
 * (`StorageMethodPolicy::METADATA_KEYS`), admitting only keys lazy's own
 * create / edit / clone / redo paths send AND the browser can also produce.
 *
 * This test keeps that list honest from both directions, in the same shape
 * as `cli-storage-policy-parity.test.ts`:
 *
 *   - a key the CLI sends that the Rails list does not admit and the register
 *     below does not classify fails — a finding for a test, not a 403 a
 *     member meets at the keyboard;
 *   - a key the Rails list admits that nothing in the CLI sends fails — an
 *     admitted key with no caller is surface nobody needed;
 *   - a register entry the Rails list now admits fails, so the two sides
 *     never silently disagree.
 *
 * What counts as "the CLI sends":
 *   - every LITERAL key in a `storage.updateTaskMetadata(…, '<key>', …)` call
 *     anywhere under `src/cli/` — so the pairing / revert / continuation keys
 *     other commands send must be classified too, not only create/edit's;
 *   - the keys written by the helper modules `create` / `edit` / `clone` /
 *     `redo` import (a literal, or a `*_KEY` constant resolved in that module);
 *   - the DYNAMIC review-setting keys (`for (const [key, value] of …)`), which
 *     are exactly what `reviewOverrideMetadata` produces — computed by calling
 *     it, and every non-literal site is required to be one of the known ones,
 *     so a new dynamic writer fails loudly instead of being skipped.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { loadRailsPolicyTables } from '../helpers/rails-policy-tables';
import { reviewOverrideMetadata } from '../../src/review/mode';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const rel = (p: string): string => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');

/** The commands whose writes the Rails list is derived from. */
const DERIVING_COMMANDS = [ 'create', 'edit', 'clone', 'redo' ];

/**
 * The only places a metadata key is not a literal or a resolvable constant.
 * Each writes review-setting keys from a `for (const [key, value] of …)` loop.
 */
const KNOWN_DYNAMIC_SITES = new Set([
  'src/cli/commands/create.ts',
  'src/cli/commands/edit.ts',
  'src/daemon/effort.ts',
]);

/**
 * Keys the CLI sends that the route refuses on purpose — each a refusal a
 * member meets in a bound clone, classified here instead of by accident.
 */
const REFUSED_BY_DESIGN: Readonly<Record<string, string>> = {
  review_mode: 'lazy create/edit --review: no browser page sets a task\'s review mode.',
  review_mode_source: 'provenance marker written beside review_mode.',
  review_auto_fix: 'lazy create/edit --review-auto-fix: no browser page sets it.',
  review_auto_fix_source: 'provenance marker written beside review_auto_fix.',
  review_gate: 'lazy create/edit --review-gate: no browser page sets it.',
  review_gate_source: 'provenance marker written beside review_gate.',
  custom_image: 'a pinned container image is local TTY consent; the browser cannot pin one.',
  custom_image_hash: 'written beside custom_image.',
  custom_image_context: 'written beside custom_image.',
  pairing_pid: 'lazy pair is a local-machine act; a bound clone has no local agent to pair with.',
  pairing_started_at: 'written beside pairing_pid.',
  continues_task_id: 'accept\'s revert continuation — the daemon reads it to decide what to continue.',
  revert_task_id: 'accept\'s revert continuation.',
  revert_sha: 'accept\'s revert continuation.',
  reverts_task_id: 'lazy revert — read by accept to build the continuation; the browser has no revert.',
  reverts_merge_sha: 'lazy revert.',
  revert_reason: 'lazy revert.',
  original_task_code: 'lazy revert — read by accept.',
  rework_of: 'lazy rework — the browser has no rework.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** `export const NAME = 'value'` constants in one module. */
function constantsOf(text: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of text.matchAll(/export const ([A-Z_]+)\s*=\s*'([a-z_]+)'/g)) consts.set(m[1], m[2]);
  return consts;
}

interface Scan {
  /** key → one site that sends it */
  keys: Map<string, string>;
  /** files with a non-literal, non-constant key argument */
  dynamicSites: Set<string>;
  scannedHelpers: Set<string>;
}

function scanFile(path: string, scan: Scan, callPattern: RegExp): void {
  const text = readFileSync(path, 'utf8');
  const consts = constantsOf(text);
  for (const m of text.matchAll(callPattern)) {
    const arg = m[1].trim();
    const literal = arg.match(/^'([a-z_]+)'$/);
    const key = literal ? literal[1] : consts.get(arg);
    if (key) {
      if (!scan.keys.has(key)) scan.keys.set(key, rel(path));
    } else {
      scan.dynamicSites.add(rel(path));
    }
  }
}

function cliMetadataKeys(): Scan {
  const scan: Scan = { keys: new Map(), dynamicSites: new Set(), scannedHelpers: new Set() };
  const storageCall = /\bstorage\.updateTaskMetadata\(\s*[^,]+,\s*([^,]+),/g;

  for (const file of walk(join(REPO_ROOT, 'src', 'cli'))) scanFile(file, scan, storageCall);

  // Helper modules the deriving commands import that write metadata on the
  // storage handle they are given. Any receiver name counts here — helpers
  // name their parameter `storage`, but the scan must not depend on it.
  const anyCall = /\bupdateTaskMetadata\(\s*[^,]+,\s*([^,]+),/g;
  for (const command of DERIVING_COMMANDS) {
    const file = join(REPO_ROOT, 'src', 'cli', 'commands', `${command}.ts`);
    for (const m of readFileSync(file, 'utf8').matchAll(/from '(\.\.?\/[^']+)'/g)) {
      let target = resolve(dirname(file), m[1]);
      if (!target.endsWith('.ts')) target += '.ts';
      if (!existsSync(target) || target.includes(`${join('src', 'cli')}`)) continue;
      if (target.endsWith(join('storage', 'interface.ts'))) continue; // the declaration, not a writer
      if (!/\bupdateTaskMetadata\(/.test(readFileSync(target, 'utf8'))) continue;
      scan.scannedHelpers.add(rel(target));
      scanFile(target, scan, anyCall);
    }
  }

  // The dynamic sites write review settings; these are exactly those keys.
  const reviewKeys = Object.keys(reviewOverrideMetadata({ mode: 'low_high', auto_fix: true, gate: 'auto' }));
  for (const key of reviewKeys) {
    if (!scan.keys.has(key)) scan.keys.set(key, 'reviewOverrideMetadata (src/review/mode.ts)');
  }
  return scan;
}

describe('the task metadata keys the CLI writes, against the Rails route\'s admitted keys', () => {
  const tables = loadRailsPolicyTables();
  const scan = cliMetadataKeys();

  test('the scan itself is sound — it sees the known writers and keys', () => {
    // An empty or blind scan would make every assertion below vacuous.
    for (const anchor of [ 'effort', 'effort_explicit', 'redo_of', 'pairing_pid', 'review_mode', 'custom_image' ]) {
      expect(scan.keys.has(anchor)).toBe(true);
    }
    expect(scan.scannedHelpers.has('src/daemon/effort.ts')).toBe(true);
    expect(scan.scannedHelpers.has('src/docker/worktree-image.ts')).toBe(true);
  });

  test('every non-literal key site is a known review-settings writer', () => {
    // INVARIANT: a metadata write whose key the scan cannot read is a key
    // this parity check cannot classify. Each known one writes review
    // settings; a NEW one must be added here consciously, with its keys.
    const unknown = [ ...scan.dynamicSites ].filter((site) => !KNOWN_DYNAMIC_SITES.has(site));
    expect(unknown).toEqual([]);
  });

  test('every key the CLI sends is admitted by the Rails route or on the refused-by-design register', () => {
    // INVARIANT: a bound clone's CLI never meets an UNCLASSIFIED metadata
    // refusal — every key is either admitted or refused on purpose.
    const missing: string[] = [];
    for (const [ key, site ] of scan.keys) {
      if (tables.metadataKeys.has(key) || Object.hasOwn(REFUSED_BY_DESIGN, key)) continue;
      missing.push(`${key} (sent from ${site})`);
    }
    if (missing.length > 0) {
      throw new Error(
        'The CLI writes task metadata keys StorageMethodPolicy::METADATA_KEYS does not admit and this register does not classify.\n' +
        'Either admit the key in lazy-teams/app/models/storage_method_policy.rb (only if the browser can make the same write) or add it to REFUSED_BY_DESIGN here with a reason.\n' +
        'Missing: ' + missing.join(', '),
      );
    }
  });

  test('every key the Rails route admits is one the CLI actually sends', () => {
    // INVARIANT: the admitted list is derived from lazy's own callers, not
    // guessed — an admitted key nothing sends is surface nobody needed.
    const unsent = [ ...tables.metadataKeys ].filter((key) => !scan.keys.has(key));
    expect(unsent).toEqual([]);
  });

  test('every register entry is still refused — an admitted key must leave the register', () => {
    const stale = Object.keys(REFUSED_BY_DESIGN).filter((key) => tables.metadataKeys.has(key));
    expect(stale).toEqual([]);
  });

  test('every register entry is a key the CLI still sends', () => {
    const orphaned = Object.keys(REFUSED_BY_DESIGN).filter((key) => !scan.keys.has(key));
    expect(orphaned).toEqual([]);
  });
});
