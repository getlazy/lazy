/**
 * The read/write partition every RPC command must belong to
 * (src/daemon/rpc-command-kinds.ts).
 *
 * WHY THIS IS A SOURCE SCAN: the identity gate refuses a store write it cannot
 * attribute, and the classification is what tells it which calls those are. A
 * command added later and classified by nobody would take the runtime default
 * — treated as a write — and the person who added it would find out from a
 * refusal in an unrelated place. Forcing the decision at test time is the
 * cheapest moment to make it.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  READ_ONLY_RPC_COMMANDS,
  STORE_WRITING_RPC_COMMANDS,
  READ_ONLY_STORAGE_METHODS,
  TELEMETRY_STORAGE_METHODS,
  PERSON_ATTRIBUTED_STORAGE_METHODS,
  PERSON_ATTRIBUTED_STORAGE_ACTORS,
  HUMAN_INITIATED_RPC_COMMANDS,
  CONTROL_PLANE_RPC_COMMANDS,
  isStoreWritingRpc,
  isHumanInitiatedRpc,
} from '../../src/daemon/rpc-command-kinds';
import { STORAGE_METHODS } from '../../src/daemon/rpc-handlers';

const HANDLERS = join(import.meta.dir, '..', '..', 'src', 'daemon', 'rpc-handlers.ts');
const FILE_STORAGE = join(import.meta.dir, '..', '..', 'src', 'storage', 'file-storage.ts');

/** Every `case '<command>':` label in the dispatch table. */
function dispatchedCommands(): string[] {
  const source = readFileSync(HANDLERS, 'utf8');
  const start = source.indexOf('async function dispatchRpc');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('Unknown RPC command', start);
  expect(end).toBeGreaterThan(start);
  const table = source.slice(start, end);
  return [...table.matchAll(/case '([^']+)':/g)].map(m => m[1]!);
}

describe('rpc command kinds', () => {
  // INVARIANT: every dispatched command is classified as exactly one of read or
  // store-writing. The identity gate's default is the safe one (an unclassified
  // command is refused when nobody can be attributed), so the cost of missing
  // one is a command that mysteriously stops working — this is what catches it.
  test('every dispatched command is classified exactly once', () => {
    const commands = dispatchedCommands();
    expect(commands.length).toBeGreaterThan(50);

    const unclassified = commands.filter(
      c => !READ_ONLY_RPC_COMMANDS.has(c) && !STORE_WRITING_RPC_COMMANDS.has(c),
    );
    const both = commands.filter(
      c => READ_ONLY_RPC_COMMANDS.has(c) && STORE_WRITING_RPC_COMMANDS.has(c),
    );

    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
  });

  test('both sets only name commands the daemon actually dispatches', () => {
    const dispatched = new Set(dispatchedCommands());
    const strays = [...READ_ONLY_RPC_COMMANDS, ...STORE_WRITING_RPC_COMMANDS]
      .filter(c => !dispatched.has(c));

    expect(strays).toEqual([]);
  });

  // INVARIANT: every MUTATING command says whether a human initiates it. In
  // managed mode a human-initiated command may not ride the control token
  // (docs/design/actor-identity-and-remote-clients.md §3.6) — and that gate's
  // runtime default is permissive, deliberately, so a verb nobody classified
  // would silently keep being attributed to a machine. This test is what makes
  // the classification a decision instead.
  test('every mutating command is classified as human-initiated or control-plane', () => {
    const mutating = dispatchedCommands().filter(c => !READ_ONLY_RPC_COMMANDS.has(c));
    expect(mutating.length).toBeGreaterThan(30);

    const unclassified = mutating.filter(
      c => !HUMAN_INITIATED_RPC_COMMANDS.has(c) && !CONTROL_PLANE_RPC_COMMANDS.has(c),
    );
    const both = mutating.filter(
      c => HUMAN_INITIATED_RPC_COMMANDS.has(c) && CONTROL_PLANE_RPC_COMMANDS.has(c),
    );

    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
  });

  test('neither human-initiated set names a command the daemon does not dispatch', () => {
    const dispatched = new Set(dispatchedCommands());
    const strays = [...HUMAN_INITIATED_RPC_COMMANDS, ...CONTROL_PLANE_RPC_COMMANDS]
      .filter(c => !dispatched.has(c));

    expect(strays).toEqual([]);
  });

  // The verbs §3.6 names explicitly: the five Rails relied on the control token
  // for, plus `editTask`, which read no actor at all before this.
  test('the task verbs a person takes are human-initiated', () => {
    for (const command of [
      'acceptTask', 'rejectTask', 'closeTask', 'stopTask', 'editTask', 'startTask', 'unblockTask',
    ]) {
      expect(isHumanInitiatedRpc(command, {})).toBe(true);
    }
  });

  // The other half of §3.6's table: handing somebody a credential is not that
  // person acting, and neither is operating a project or a container.
  test('the control-plane surfaces are not human-initiated', () => {
    for (const command of [
      'mintActorToken', 'revokeActorToken', 'putUserCredential', 'revokeUserCredential',
      'concurrency', 'setProjectSettings', 'ensureTaskContainer', 'builderSlot',
      'getDaemonMcpConfig', 'runOneshot',
    ]) {
      expect(isHumanInitiatedRpc(command, {})).toBe(false);
    }
  });

  // A read is never refused on either token, exactly as with the identity gate.
  test('reads are never human-initiated, whoever calls them', () => {
    for (const command of ['list', 'show', 'diff', 'search', 'identity', 'reviewQueue']) {
      expect(isHumanInitiatedRpc(command, {})).toBe(false);
    }
  });

  // The storage proxy again, and by the same rule as the write gate: every
  // WRITE through it is somebody's act. Including the writers that carry no
  // actor at all — `lazy edit` does its whole job through those, so gating only
  // the person-carrying ones would refuse `editTask` while leaving the
  // identical change one `storage` call away.
  test('every storage write is human-initiated, reads are not', () => {
    expect(isHumanInitiatedRpc('storage', { method: 'createComment' })).toBe(true);
    expect(isHumanInitiatedRpc('storage', { method: 'createTask' })).toBe(true);
    expect(isHumanInitiatedRpc('storage', { method: 'resolveRaisedItem' })).toBe(true);
    expect(isHumanInitiatedRpc('storage', { method: 'updateTaskModel' })).toBe(true);
    expect(isHumanInitiatedRpc('storage', { method: 'updateTaskPrompt' })).toBe(true);
    expect(isHumanInitiatedRpc('storage', { method: 'listTasks' })).toBe(false);
    expect(isHumanInitiatedRpc('storage', { method: 'getTaskComments' })).toBe(false);
    expect(isHumanInitiatedRpc('storage', {})).toBe(false);
  });

  // Permissive by default, and the opposite of the write gate on purpose: a
  // command nobody classified must not become a 403 on a fleet host.
  test('an unknown command is not treated as human-initiated', () => {
    expect(isHumanInitiatedRpc('someCommandAddedLater', {})).toBe(false);
  });

  test('every read-only storage method exists on the storage proxy', () => {
    const strays = [...READ_ONLY_STORAGE_METHODS].filter(m => !(m in STORAGE_METHODS));

    expect(strays).toEqual([]);
  });

  // INVARIANT: the telemetry exemption stays pinned to real proxy methods. The
  // managed-mode gate refuses to let a control token carry a human action, and
  // TELEMETRY_STORAGE_METHODS is the exemption from that gate — a name that
  // drifts from STORAGE_METHODS (a rename, a removal, or a method that later
  // grew a person column) must fail here rather than silently exempt nothing,
  // or silently exempt a writer a member actually reaches for.
  test('every telemetry storage method exists on the storage proxy', () => {
    const strays = [...TELEMETRY_STORAGE_METHODS].filter(m => !(m in STORAGE_METHODS));

    expect(strays).toEqual([]);
  });

  // The managed-mode gate must keep refusing every DOMAIN write on the control
  // token even though telemetry is exempt — the exemption is for rows with no
  // person column and no domain effect, not a crack in the gate.
  test('telemetry storage methods are exempt from the human gate, domain writers are not', () => {
    for (const method of ['appendTraceSpans', 'recordWaitStart', 'recordWaitEnd', 'saveToolStats']) {
      expect(isHumanInitiatedRpc('storage', { method })).toBe(false);
    }
    for (const method of ['createTask', 'createComment', 'updateTaskStatus', 'saveMemory']) {
      expect(isHumanInitiatedRpc('storage', { method })).toBe(true);
    }
  });

  // The storage proxy is one command covering the whole Storage interface, so
  // its answer comes from the method name — otherwise `lazy list` (a read) and
  // `lazy create` (a write) would be gated identically.
  test('the storage proxy is classified per method', () => {
    expect(isStoreWritingRpc('storage', { method: 'listTasks' })).toBe(false);
    expect(isStoreWritingRpc('storage', { method: 'createTask' })).toBe(true);
    // Fail closed: a call with no method at all is not evidence of a read.
    expect(isStoreWritingRpc('storage', {})).toBe(true);
  });

  test('reads a human needs while unconfigured are never gated', () => {
    for (const command of ['list', 'show', 'diff', 'search', 'identity', 'doctor.run']) {
      expect(isStoreWritingRpc(command, {})).toBe(false);
    }
  });

  // Fail closed at runtime: whatever the enumeration test missed is refused
  // rather than written with nobody's name on it.
  test('an unknown command is treated as a store write', () => {
    expect(isStoreWritingRpc('someCommandAddedLater', {})).toBe(true);
  });

  // INVARIANT: only a writer that takes an `ActorInput` may be stamped with a
  // person. The rest take a bare role, and their rows have no person columns —
  // handing one an `{ role, email }` object writes the OBJECT into the row's
  // `actor` field, a corrupt record that fails nowhere near the cause. The
  // declaration in the Storage interface is the source of truth, so the set is
  // checked against it rather than against a second list somebody maintains.
  test('every person-attributed storage method declares an ActorInput', () => {
    const iface = readFileSync(
      join(import.meta.dir, '..', '..', 'src', 'storage', 'interface.ts'),
      'utf8',
    );

    const wrong = [...PERSON_ATTRIBUTED_STORAGE_METHODS].filter(method => {
      if (!(method in STORAGE_METHODS)) return true;
      // The two DEPRECATED follow-up adapters exist only in the proxy table and
      // are not Storage methods at all: each forwards into `resolveRaisedItem` /
      // `promoteRaisedItem`, which this test checks on their behalf.
      if (method === 'triageFollowUp' || method === 'promoteFollowUp') return false;
      // The declaration plus the ~25 lines of signature that follow it — long
      // enough to reach an `actor` nested in an options bag, short enough not
      // to run into the next method's.
      const at = iface.indexOf(`  ${method}(`);
      if (at === -1) return true;
      const signature = iface.slice(at, at + 1200);
      const end = signature.indexOf('): Promise');
      const declaration = signature.slice(0, end === -1 ? undefined : end);
      if (declaration.includes('ActorInput')) return false;

      // `createTurn(options: CreateTurnOptions)` carries its actor inside a
      // named type, so follow the name one hop.
      return ![...declaration.matchAll(/\b([A-Z]\w+(?:Options|Input))\b/g)].some(m => {
        const typeAt = iface.indexOf(`interface ${m[1]} {`);
        if (typeAt === -1) return false;
        const body = iface.slice(typeAt, iface.indexOf('\n}', typeAt));
        return /actor\??: ActorInput/.test(body);
      });
    });

    expect(wrong).toEqual([]);
  });

  // INVARIANT: the declared actor LOCATION has to be where the proxy really
  // reads it from. A path pointing at a key the method does not use stamps
  // nothing and fails silently — the row simply comes back with no person on
  // it, which is indistinguishable from "this caller had none".
  test('every declared actor path matches where the proxy reads it', () => {
    const handlers = readFileSync(HANDLERS, 'utf8');

    const wrong = [...PERSON_ATTRIBUTED_STORAGE_ACTORS].filter(([method, path]) => {
      const at = handlers.indexOf(`\n  ${method}: `);
      if (at === -1) return true;
      // The entry body: from this method's line up to the next table entry,
      // which is the next `\n  <name>: [async ](s, a)` — the table's own shape.
      const rest = handlers.slice(at + 1);
      const next = /\n {2}[a-zA-Z]\w*: (?:async )?\(s/.exec(rest.slice(1));
      const body = rest.slice(0, next ? next.index + 1 : 900);
      // ['actor'] → reads `a.actor`; ['resolution','actor'] → reads
      // `a.resolution`, whose own `actor` the storage method then consumes.
      const container = path.length === 1 ? 'actor' : path[0]!;
      return !body.includes(`a.${container}`);
    }).map(([method]) => method);

    expect(wrong).toEqual([]);
  });

  // --- The map is COMPLETE, not merely correct ---
  //
  // The three tests above all check that what the map SAYS is right. This one
  // checks that it says enough: a writer that records a person and is missing
  // from the map is invisible to every check there is.

  /**
   * FileStorage methods that put a PERSON in a row, resolved through one level
   * of private helper.
   *
   * The three person-extractors from src/actor-ref are the signal — a writer
   * that calls none of them cannot be recording a person, and one that calls
   * any of them is. `readAndAppendStatusChange` is the reason the helper hop
   * exists: `updateTaskStatus`, `abandonTask` and `reopenTask` all attribute a
   * status change through it rather than inline.
   */
  function personWritingStorageMethods(): { direct: Set<string>; viaHelper: Set<string> } {
    const source = readFileSync(FILE_STORAGE, 'utf8');
    const lines = source.split('\n');
    // Class members sit at exactly two-space indentation.
    const MEMBER = /^ {2}(?:(private|protected)\s+)?(?:static\s+)?(?:async\s+)?\*?([A-Za-z_]\w*)\s*[(<]/;
    const PERSON = /\b(?:actorFields|actorEmail|actorName)\s*\(/;

    const members: Array<{ name: string; hidden: boolean; body: string[] }> = [];
    let current: { name: string; hidden: boolean; body: string[] } | null = null;
    for (const line of lines) {
      const m = MEMBER.exec(line);
      if (m) {
        current = { name: m[2]!, hidden: m[1] !== undefined, body: [] };
        members.push(current);
      }
      // Everything up to the next member declaration belongs to this one. Crude
      // versus a real parser, and enough: a call cannot hide between members.
      if (current) current.body.push(line);
    }

    const writes = (b: string[]) => b.some(l => PERSON.test(l) && !l.startsWith('import'));
    const direct = new Set(members.filter(m => !m.hidden && writes(m.body)).map(m => m.name));
    const helpers = members.filter(m => m.hidden && writes(m.body)).map(m => m.name);

    const viaHelper = new Set<string>();
    for (const m of members) {
      if (m.hidden) continue;
      for (const h of helpers) {
        if (m.body.some(l => new RegExp(`\\bthis\\.${h}\\s*\\(`).test(l))) viaHelper.add(m.name);
      }
    }
    return { direct, viaHelper };
  }

  /**
   * Writers the scan finds that deliberately record NO person, with the reason.
   *
   * Not a convenience allowlist: each entry is a claim that this call site
   * attributes nothing on purpose, and it has to stay true.
   */
  const RECORDS_NO_PERSON_ON_PURPOSE: ReadonlyMap<string, string> = new Map([
    // Reaches readAndAppendStatusChange with NO actor argument: a best-effort
    // self-healing repair of a status that disagrees with its session, run
    // during a plain read. Nobody asked for it, so no person may be named.
    ['listTasksWithOptions', 'self-healing status repair during a read; passes no actor'],
  ]);

  /**
   * Map entries with no FileStorage method behind them, with the reason.
   *
   * Both are the DEPRECATED follow-up adapters, documented as such on the map
   * itself: neither is on the Storage interface — each is an adapter in the
   * proxy table forwarding to `resolveRaisedItem` / `promoteRaisedItem`, which
   * are where the real ActorInput lives and are themselves declared.
   */
  const PROXY_ADAPTERS_NOT_ON_FILE_STORAGE: ReadonlySet<string> = new Set([
    'triageFollowUp',
    'promoteFollowUp',
  ]);

  // INVARIANT: every FileStorage writer that records a person is declared in
  // PERSON_ATTRIBUTED_STORAGE_ACTORS. Both the daemon's own stamping and a user
  // token's pinning write the acting identity ONLY at a path this map declares,
  // so a writer missing from it silently records nobody — no error, no failing
  // test, just rows that name no one.
  //
  // WHY IT EXISTS: `addRaisedItemComment` was exactly that. It persists
  // actor_email/actor_name and was never declared, which nobody noticed while
  // the pinning path happened to walk every argument container. The moment
  // pinning was narrowed to the declared paths — correctly — a person's reply
  // on a raised item stopped naming them, on the surface that GATES an accept,
  // and the same omission had already left a laptop's reply unattributed
  // through the stamping path. The map was treated as complete when it was one
  // entry short, and only a reviewer caught it. This is the check that would
  // have.
  test('every person-writing storage method is declared', () => {
    const { direct, viaHelper } = personWritingStorageMethods();

    // The scan must keep working: if it stops finding the writers we know are
    // there, it would pass by finding nothing at all.
    expect(direct.has('addRaisedItemComment')).toBe(true);
    expect(direct.has('createComment')).toBe(true);
    expect(viaHelper.has('updateTaskStatus')).toBe(true);

    const undeclared = [...new Set([...direct, ...viaHelper])]
      .filter(name => !PERSON_ATTRIBUTED_STORAGE_METHODS.has(name))
      .filter(name => !RECORDS_NO_PERSON_ON_PURPOSE.has(name))
      .sort();

    expect(undeclared).toEqual([]);
  });

  // INVARIANT: and nothing is declared that does not write a person. A stray
  // entry makes the daemon stamp an ActorRef OBJECT into a row typed for a bare
  // role — the `[object Object]` corruption, in append-only state — which is
  // the failure the map exists to prevent in the first place.
  test('every declared method actually writes a person', () => {
    const { direct, viaHelper } = personWritingStorageMethods();
    const writers = new Set([...direct, ...viaHelper]);

    const declaredButInert = [...PERSON_ATTRIBUTED_STORAGE_METHODS]
      .filter(name => !writers.has(name))
      .filter(name => !PROXY_ADAPTERS_NOT_ON_FILE_STORAGE.has(name))
      .sort();

    expect(declaredButInert).toEqual([]);
  });
});
