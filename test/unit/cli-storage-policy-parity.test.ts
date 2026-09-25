/**
 * The CLI's storage surface, checked against the Rails policy table.
 *
 * The bound-clone proxy route refuses by default: a storage method
 * RemoteStorage proxies that `StorageMethodPolicy` does not admit is a 404
 * every CLI command asking for it dies on at runtime — as happened to
 * `getStoragePath`, the boot read `src/preconditions.ts` makes to open
 * `RemoteStorage` at all, whose omission made every store-backed command
 * exit 1 against the real route while every suite stayed green, because the
 * e2e stub answered from a hand-written list and the Rails suite had no case
 * for the method. The two halves could not disagree.
 *
 * This test is the durable half of the fix: the e2e stub now consults the
 * real Ruby tables (test/helpers/rails-policy-tables.ts), and this test
 * cross-checks the SAME tables against the methods lazy's own CLI actually
 * sends through the route. A new `storage.<method>()` call in CLI code that
 * is neither admitted by the Rails table nor on the refused-by-design
 * register below fails HERE — a finding for a test, not a refusal a member
 * meets at the keyboard.
 *
 * Scope, deliberately:
 *  - The scan covers the CLI's own storage calls (`src/cli/**` plus the
 *    boot read in `src/preconditions.ts`) — the surfaces a bound-clone
 *    member drives.
 *  - `src/mcp/tools.ts` is a separate agent-facing surface with its own
 *    narrower contract; it is not scanned here.
 *  - Daemon-side helper modules a CLI command may pass its `RemoteStorage`
 *    handle into (e.g. `loadTaskShowData`) are not enumerated; when such a
 *    path is live in a bound clone, the e2e stub's table-driven refusal
 *    catches an unmapped method at runtime.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadRailsPolicyTables } from '../helpers/rails-policy-tables';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Methods RemoteStorage proxies through the `storage` RPC route. */
function proxiedMethods(): Set<string> {
  const source = readFileSync(join(REPO_ROOT, 'src', 'storage', 'remote-storage.ts'), 'utf8');
  const proxied = new Set<string>();
  for (const line of source.split('\n')) {
    const idx = line.indexOf('this.call');
    if (idx === -1) continue;
    // The first quoted identifier after `this.call` on the same line is the
    // method name (the call is `this.call('name', …)` or
    // `this.call<Generic>('name', …)`; type generics never contain a bare
    // quoted `[A-Za-z]+` before the argument).
    const rest = line.slice(idx);
    const match = rest.match(/'([A-Za-z]+)'/);
    if (match) proxied.add(match[1]);
  }
  return proxied;
}

/**
 * The CLI's storage surface: every proxied method called as
 * `storage.<method>(…)` in CLI code, plus the literal methods of the boot
 * `client.rpc('storage', …)` call(s) in `src/preconditions.ts` (the shape
 * `tryRemoteStorage` uses to open RemoteStorage — the first call every
 * store-backed command makes, and the one the scan by variable name cannot
 * see). Returns method → one call site, for the failure message.
 */
function cliStorageSurface(): Map<string, string> {
  const surface = new Map<string, string>();
  const proxied = proxiedMethods();

  const cliDir = join(REPO_ROOT, 'src', 'cli');
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    const { readdirSync, statSync } = require('fs');
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.push({ path: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(cliDir);
  files.push({
    path: join(REPO_ROOT, 'src', 'preconditions.ts'),
    text: readFileSync(join(REPO_ROOT, 'src', 'preconditions.ts'), 'utf8'),
  });

  for (const file of files) {
    const rel = file.path.slice(REPO_ROOT.length + 1);
    for (const match of file.text.matchAll(/\bstorage\.([A-Za-z_]+)\(/g)) {
      const method = match[1];
      if (!proxied.has(method)) continue; // local-only handle (e.g. close()); never routed
      if (!surface.has(method)) surface.set(method, rel.replace(/\\/g, '/'));
    }
    // The boot read's literal `method: 'X'` argument — any new storage rpc
    // opened in preconditions.ts is checked the same way.
    if (file.path.endsWith('preconditions.ts')) {
      for (const m of file.text.matchAll(/method:\s*'([A-Za-z]+)'/g)) {
        if (!surface.has(m[1])) surface.set(m[1], file.path.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return surface;
}

/**
 * Methods the CLI calls through the route that StorageMethodPolicy
 * deliberately does NOT admit. Refuse-by-default is the route's posture, so
 * each of these is a refusal a member meets in a bound clone today, recorded
 * here so it is a CLASSIFIED refusal instead of an accident:
 *
 *   - moving one of these into the Rails table is the normal flow as a
 *     surface is driven in a bound clone — and this test then FAILS until
 *     the entry is removed from the register below, so the two sides are
 *     never silently inconsistent;
 *   - a new CLI storage call that lands in neither table fails the surface
 *     assertion with its call site.
 */
const REFUSED_BY_DESIGN: Readonly<Record<string, string>> = {
  // --- agent-session plumbing: written by the daemon in normal operation;
  //     these CLI call sites are local recovery/diagnostic surfaces.
  createCommit: 'lazy pair records a commit row mid-session (local recovery surface).',
  createTurn: 'lazy pair appends a turn row (local recovery surface).',
  getNextTurnSequence: 'lazy pair allocates the next turn sequence.',
  updateSessionClaudeId: 'lazy pair repairs a lost agent session id.',
  updateSessionContainerName: 'lazy doctor remedy clears a container name; doctor refuses bound clones before reaching it.',
  updateTaskStatus: "lazy pair marks 'pairing'; doctor-task forces 'working' — neither runs in a bound clone.",
  updateTaskRunnerType: 'lazy create/edit --runner: the browser edit form has no runner field.',
  updateTaskBranchedFromSha: 'lazy reopen repairs a branch base after a reopen.',
  getLatestWorktreeSnapshot: 'lazy status shows the last worktree snapshot.',
  getAgentSessionLog: 'lazy chat reads the agent transcript log.',
  saveAgentSessionLog: 'lazy chat appends to the agent transcript log.',
  readTraceSpans: 'lazy timings reads trace spans.',
  // --- conversations: reads are admitted; writes are not yet classified.
  saveConversation: 'lazy import-conversation stores an imported transcript.',
  deleteConversation: 'lazy doctor cleans an imported conversation; doctor refuses bound clones.',
  promoteConversation: 'lazy conversations promote turns an imported transcript into a task.',
  // --- memory: agents may read; writes are curated by the human/builder.
  saveMemory: 'lazy memory save writes a curated record.',
  deleteMemory: 'lazy memory delete removes a curated record.',
  clearMemoryCompact: 'lazy memory clear-compact drops the compact summary.',
  saveMemoryCompact: 'lazy memory rebuild-compact writes the compact summary.',
  // --- scratch files: project-local housekeeping, proxied but not admitted.
  getScratchFile: 'lazy scratch read/get — housekeeping a bound clone does not serve.',
  listScratchFiles: 'lazy scratch list — housekeeping a bound clone does not serve.',
  deleteScratchFile: 'lazy scratch rm — housekeeping a bound clone does not serve.',
  // --- system messages: read state is server-side direction, pending.
  markSystemMessageRead: 'lazy messages marks a message read; server-side read state is the recorded direction.',
  dismissSystemMessage: 'lazy messages dismisses a message; server-side read state is the recorded direction.',
  // --- task actions: real CLI verbs, unmapped until a human classifies them.
  abandonTask: 'lazy redo abandons the superseded task; the loop interruption path uses it too.',
  deleteTaskArtifact: 'lazy artifact rm deletes an artifact (create is admitted; delete is not yet classified).',
  createHunkApproval: 'the per-hunk review TUI writes an approval; no browser page writes hunk approvals.',
  promoteRaisedItem: 'lazy raised promote turns a raised item into a task.',
};

describe('the CLI storage surface against the Rails policy table', () => {
  const tables = loadRailsPolicyTables();
  const surface = cliStorageSurface();

  test('the scan itself is sound — it sees the known surface', () => {
    // If the scan stops seeing these, the derivation (regex over source) has
    // gone stale and must be fixed consciously — an empty surface would make
    // every assertion below vacuous.
    for (const anchor of [ 'getTask', 'createTask', 'createComment', 'getProjectSettings', 'getStoragePath' ]) {
      expect(surface.has(anchor)).toBe(true);
    }
    expect(surface.size).toBeGreaterThanOrEqual(60);
  });

  test('every storage method the CLI calls is admitted by the Rails table or on the refused-by-design register', () => {
    const missing: string[] = [];
    for (const [ method, site ] of surface) {
      if (tables.storageMethods.has(method)) continue;
      if (Object.hasOwn(REFUSED_BY_DESIGN, method)) continue;
      missing.push(`${method} (called from ${site})`);
    }
    if (missing.length > 0) {
      throw new Error(
        `The CLI calls storage methods the Rails policy table does not admit and this register does not classify.\n` +
        'Either map the method in lazy-teams/app/models/storage_method_policy.rb (the route admits it) or add it to REFUSED_BY_DESIGN here with a reason.\n' +
        'Missing: ' + missing.join(', '),
      );
    }
  });

  test('every register entry is still refused — a mapped method must leave the register', () => {
    const stale = Object.keys(REFUSED_BY_DESIGN).filter((method) => tables.storageMethods.has(method));
    if (stale.length > 0) {
      throw new Error(
        `These methods are now ADMITTED by StorageMethodPolicy, so their register entries are stale — remove them from REFUSED_BY_DESIGN: ${stale.join(', ')}`,
      );
    }
  });

  test('the boot read every store-backed command makes first is admitted', () => {
    // The original defect: `getStoragePath` — the very first call
    // src/preconditions.ts makes to build RemoteStorage — was missing from
    // both Rails allow-lists, refusing `lazy create`, `edit`, `comment`,
    // `tag`, `journal` and accept's continuation path with a 404 before any
    // of them could do anything. Pin it so pruning the table fails here.
    expect(tables.storageMethods.has('getStoragePath')).toBe(true);
  });

  test('the task-creation read is admitted — the storage-route bar is decided in the Rails table', () => {
    // Which POLICY VERB admits getProjectSettings (admin bar vs the
    // create-task bar) is pinned by the Rails controller suite
    // (rpc_controller_test.rb, storage:getProjectSettings); here it only
    // matters that the method stays admitted at all — the CLI's create/edit
    // paths read it before anything else.
    expect(tables.storageMethods.has('getProjectSettings')).toBe(true);
  });
});