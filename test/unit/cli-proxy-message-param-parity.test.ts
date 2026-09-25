/**
 * The Rails proxy route's `TaskAction` params, checked against the request
 * bodies lazy's own CLI actually sends.
 *
 * The route writes a `TaskAction` row BEFORE relaying to the daemon — root
 * CLAUDE.md's first invariant, so a refused `lazy unblock` or `lazy ask`
 * still has the human's words on it. WHERE those words live in the body is a
 * wire contract: `CliRpcCommand::Mapping` names a `message_param` and Rails
 * reads exactly that key. Name a key the CLI does not send and the row is
 * written with a NULL message — the surface looks like it is saving feedback
 * and is silently dropping it, which no Rails test can see (the Rails suite
 * writes the bodies it asserts on) and no lazy test can see either (nothing
 * on this side reads the Ruby).
 *
 * That is exactly how `askTask` shipped mapped to `"question"` while
 * `queryAskTask` sends `message`: two halves that could not disagree, the
 * same shape as the `getStoragePath` defect its sibling test
 * (`cli-storage-policy-parity.test.ts`) exists for.
 *
 * Scope: the top-level commands the Rails table maps that `rpc-fallback.ts`
 * — the one module that issues top-level RPCs for the CLI — actually calls.
 * A mapped command with no `tryRpc` call site is dormant and is reported as
 * such rather than silently skipped.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadRailsPolicyTables } from '../helpers/rails-policy-tables';
import { cliRpcBodies } from '../helpers/cli-rpc-bodies';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Command → the body keys lazy sends for it.
 *
 * Derived from `rpc-fallback.ts` by taking the enclosing exported function of
 * each `tryRpc…('<command>'` call and collecting every `key:` / `key?:` in
 * it. That union deliberately covers both spellings the module uses — an
 * inline object literal (`{ taskId: …, message: … }`) and a bare `params`
 * pass-through, whose keys are declared in the function's own parameter type
 * — because the question here is only whether the wire body carries the key
 * at all.
 */
function rpcBodyKeys(): Map<string, { keys: Set<string>; fn: string }> {
  const source = readFileSync(join(REPO_ROOT, 'src', 'daemon', 'rpc-fallback.ts'), 'utf8');

  const bounds: Array<{ start: number; name: string }> = [];
  for (const match of source.matchAll(/export async function (\w+)/g)) {
    bounds.push({ start: match.index!, name: match[1] });
  }

  const byCommand = new Map<string, { keys: Set<string>; fn: string }>();
  for (const match of source.matchAll(/tryRpc(?:Void)?(?:<[^>]*>)?\(\s*'([A-Za-z.]+)'/g)) {
    const command = match[1];
    let fnIndex = -1;
    for (let i = 0; i < bounds.length; i++) {
      if (bounds[i].start < match.index!) fnIndex = i;
      else break;
    }
    if (fnIndex === -1) continue;
    const body = source.slice(bounds[fnIndex].start, bounds[fnIndex + 1]?.start ?? source.length);
    const keys = new Set<string>();
    for (const key of body.matchAll(/^\s*([A-Za-z_]\w*)\??:/gm)) keys.add(key[1]);
    // One command can be issued from more than one wrapper (awaited vs not);
    // union their keys rather than letting whichever came last win.
    const existing = byCommand.get(command);
    if (existing) for (const k of keys) existing.keys.add(k);
    else byCommand.set(command, { keys, fn: bounds[fnIndex].name });
  }
  return byCommand;
}

/**
 * Storage method → the `args` keys `RemoteStorage` sends for it. Same
 * question as `rpcBodyKeys`, one route down: a `storage` call's task id and
 * message live under `args`, and the Rails table names those keys too.
 */
function storageArgKeys(): Map<string, Set<string>> {
  const source = readFileSync(join(REPO_ROOT, 'src', 'storage', 'remote-storage.ts'), 'utf8');
  const byMethod = new Map<string, Set<string>>();
  for (const match of source.matchAll(/this\.call(?:<[^>]*>)?\(\s*'([A-Za-z]+)'\s*,\s*\{([^}]*)\}/g)) {
    const keys = new Set<string>();
    for (const part of match[2].split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_]\w*$/.test(name)) keys.add(name);
    }
    byMethod.set(match[1], keys);
  }
  return byMethod;
}

describe('the Rails proxy table against the bodies the CLI sends', () => {
  const tables = loadRailsPolicyTables();
  const bodies = rpcBodyKeys();

  test('the scan itself is sound — it sees the known call sites and their keys', () => {
    // Without this an empty or broken scan would make every assertion below
    // pass by having nothing to check — the failure mode the sibling
    // storage-parity test's anchor exists for.
    for (const command of [ 'unblockTask', 'askTask', 'rejectTask', 'closeTask', 'stopTask', 'acceptTask' ]) {
      expect(bodies.has(command)).toBe(true);
    }
    expect(bodies.get('unblockTask')!.keys.has('message')).toBe(true);
    expect(bodies.get('rejectTask')!.keys.has('reason')).toBe(true);
    expect(bodies.size).toBeGreaterThanOrEqual(20);
  });

  // INVARIANT: every `message_param` the Rails route names is a key the CLI's
  // own request body carries. The route saves the human's words off that key
  // before the relay; a key the body never carries saves nothing, so a
  // refused command loses what the person typed — root CLAUDE.md's first
  // invariant, broken silently rather than loudly.
  test('every message param the Rails route reads is a key the CLI actually sends', () => {
    const broken: string[] = [];
    for (const [ command, params ] of tables.commandParams) {
      if (!params.messageParam) continue;
      const body = bodies.get(command);
      if (!body) continue; // dormant; reported by the test below
      if (body.keys.has(params.messageParam)) continue;
      broken.push(
        `${command}: Rails reads "${params.messageParam}" but ${body.fn}() sends ` +
        `{ ${[ ...body.keys ].sort().join(', ')} }`,
      );
    }
    if (broken.length > 0) {
      throw new Error(
        'The CLI proxy would save a TaskAction row with NO message for these commands, so a refusal loses the human\'s words.\n' +
        'Fix the message_param in lazy-teams/app/models/cli_rpc_command.rb to name the key the body really carries.\n' +
        broken.join('\n'),
      );
    }
  });

  // INVARIANT: the OTHER direction — a command that writes a TaskAction row
  // records the person's words if its CLI body carries any. The check above
  // only asked about keys the table already named, so `acceptTask` and
  // `reopenTask` — mapped with no message param while the CLI sends `reason`
  // — wrote rows with no message: the Activity record differed from the
  // browser's, and a refused accept or reopen lost what the person typed.
  // Read with the EXACT body scan (`cli-rpc-bodies.ts`), because the loose
  // scan above also collects return-type fields, and `syncTask`'s result has
  // a `message` its request never carries.
  test('every command that records a TaskAction records the words its CLI body carries', () => {
    const WORDS = [ 'reason', 'message', 'content' ];
    const exact = cliRpcBodies();
    // Anti-vacuity: the kinds must have parsed, and the scan must see words.
    expect(tables.commandParams.get('acceptTask')?.taskActionKind).toBe('accept');
    expect(exact.get('acceptTask')?.keys.has('reason')).toBe(true);

    const lost: string[] = [];
    for (const [ command, params ] of tables.commandParams) {
      if (!params.taskActionKind) continue;
      const body = exact.get(command);
      if (!body) continue;
      const sent = WORDS.filter((w) => body.keys.has(w));
      if (sent.length === 0) continue;
      if (params.messageParam && sent.includes(params.messageParam)) continue;
      lost.push(`${command} (${params.taskActionKind}): the CLI sends ${sent.join('/')}, the row records ${params.messageParam ?? 'nothing'}`);
    }
    if (lost.length > 0) {
      throw new Error(
        'These commands write a TaskAction row without the words the person typed — set message_param in lazy-teams/app/models/cli_rpc_command.rb.\n' +
        lost.join('\n'),
      );
    }
  });

  // Same contract for the other half of the row: a task id read off a key the
  // body does not carry leaves the row unattached to any task, so the audit
  // trail records that somebody did something to nothing.
  test('every task id param the Rails route reads is a key the CLI actually sends', () => {
    const broken: string[] = [];
    for (const [ command, params ] of tables.commandParams) {
      if (!params.taskIdParam) continue;
      const body = bodies.get(command);
      if (!body) continue;
      if (body.keys.has(params.taskIdParam)) continue;
      broken.push(`${command}: Rails reads "${params.taskIdParam}" but ${body.fn}() does not send it`);
    }
    expect(broken).toEqual([]);
  });

  // INVARIANT: the same contract on the storage route, whose `createComment`
  // is the note box a member types a paragraph into. `RemoteStorage` sends
  // named `args`, so this is checkable the same way.
  test('every storage message arg the Rails route reads is a key RemoteStorage actually sends', () => {
    const args = storageArgKeys();
    // Anti-vacuity: the scan must see the two methods that settle a row.
    expect(args.get('createTask')?.has('goal')).toBe(true);
    expect(args.get('createComment')?.has('content')).toBe(true);

    const broken: string[] = [];
    for (const [ method, messageArg ] of tables.storageMessageArgs) {
      if (!messageArg) continue;
      const keys = args.get(method);
      if (!keys) continue;
      if (!keys.has(messageArg)) {
        broken.push(`storage:${method}: Rails reads args["${messageArg}"], RemoteStorage sends { ${[ ...keys ].sort().join(', ')} }`);
      }
    }
    expect(broken).toEqual([]);
  });

  // Not a failure — a mapped command lazy never issues through this module is
  // dormant by design (`editTask` says so in the table itself). Pinning the
  // list keeps the two skips above honest: a reader can see WHICH commands
  // carrying a param the checks did not cover, instead of assuming they
  // covered everything. Reads are not here because they name no param at all.
  test('the param-carrying commands the CLI never issues are the known dormant ones', () => {
    const dormant = [ ...tables.commandParams ]
      .filter(([ c, p ]) => (p.taskIdParam || p.messageParam) && !bodies.has(c))
      .map(([ c ]) => c)
      .sort();
    expect(dormant).toEqual([ 'editTask' ]);
  });
});
