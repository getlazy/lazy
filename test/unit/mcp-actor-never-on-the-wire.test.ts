/**
 * INVARIANT: an MCP actor that names a PERSON never travels on an RPC request.
 *
 * `mcpActor` returns `{role: 'agent', email, name}` once the daemon has
 * resolved the turn owner, and several MCP tools pass that value straight into
 * a daemon VERB's parameters rather than writing to storage themselves —
 * `lazy_stop` builds `StopTaskParams.actor`, and it is not the only one. A
 * request carrying a person is a hard 403 in `applyCallerActor`
 * (docs/design/actor-identity-and-remote-clients.md §3.4): identity is derived
 * from the caller's token or the daemon's environment, never sent.
 *
 * It holds today for a reason that is easy to miss and easier to break, because
 * it lives in two modules that do not mention each other:
 *
 *   1. A person is put on an MCP context in exactly ONE place, the daemon's own
 *      route handler, which resolves it from the task the presented token is
 *      bound to. Every context built anywhere else carries no person and
 *      therefore cannot put one on a request.
 *   2. Inside the daemon those verb calls never reach the wire at all —
 *      `tryRpc` short-circuits on `LAZY_IS_DAEMON=1` and the handler is invoked
 *      in-process, so the actor travels as a function argument.
 *
 * Either half moving breaks it, and the symptom would be an agent's `lazy_stop`
 * failing mid-turn with a permission error on a path that has nothing to do
 * with permissions. This project's stated direction is daemons that live
 * somewhere other than their caller, so the surface half 2 depends on is one we
 * intend to move. These two tests are what makes that a failing test rather
 * than a field report.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { isDaemonRpcBypassed } from '../../src/daemon/client';
import { mcpActor } from '../../src/mcp/tools';
import { isActorRef } from '../../src/actor-ref';

/** The ONE module allowed to put a person on an MCP tool context. */
const PERSON_RESOLVING_MODULE = join('src', 'daemon', 'mcp-routes.ts');

/** Where the field itself is declared and read — not a context construction. */
const CONTEXT_DECLARING_MODULE = join('src', 'mcp', 'tools.ts');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) out.push(...await tsFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('an MCP actor naming a person never reaches the wire', () => {
  // Both seams `isDaemonRpcBypassed` reads are restored, not just the one this
  // suite is about: a test file that leaves LAZY_TEST unset changes how every
  // later file in the same run reaches the daemon.
  const previous = {
    LAZY_IS_DAEMON: process.env.LAZY_IS_DAEMON,
    LAZY_TEST: process.env.LAZY_TEST,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Half 2. The daemon does not talk to itself over the wire, so an actor
  // carrying a person stays a function argument all the way to the handler.
  test('the daemon bypasses the RPC transport, so an in-process actor never serializes', () => {
    process.env.LAZY_IS_DAEMON = '1';
    expect(isDaemonRpcBypassed()).toBe(true);

    delete process.env.LAZY_IS_DAEMON;
    delete process.env.LAZY_TEST;
    expect(isDaemonRpcBypassed()).toBe(false);
  });

  // Half 1. A context built outside the daemon cannot name anybody, so the
  // non-bypassed transport above can only ever be handed a bare role.
  //
  // The scan is deliberately crude — ANY mention of the field outside the two
  // modules that own it is the signal, because a context that names a person is
  // not something a third module should be doing quietly. A local variable that
  // merely shares the name trips it too; rename the local, which is the right
  // answer anyway (one has nothing to do with the other).
  test('only the daemon route resolves a person onto an MCP context', async () => {
    const offenders: string[] = [];

    for (const file of await tsFiles('src')) {
      if (file.endsWith(PERSON_RESOLVING_MODULE) || file.endsWith(CONTEXT_DECLARING_MODULE)) continue;
      const source = await readFile(file, 'utf-8');
      if (/actorPerson/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  // The scan must still SEE the one legitimate assignment: a source guard whose
  // pattern stops matching passes by finding nothing.
  test('the scan still finds the daemon route that does resolve one', async () => {
    const source = await readFile(PERSON_RESOLVING_MODULE, 'utf-8');
    expect(source).toContain('actorPerson');
    expect(source).toContain('taskTurnOwner');
  });

  // And the value itself: with no person resolved — which is every context
  // built outside the daemon — this is a plain string, the shape that has
  // always travelled on these requests.
  test('without a resolved person the actor is a bare role string', () => {
    const agent = mcpActor({ taskId: 'task-uuid', worktreePath: '/tmp/wt' });
    const builder = mcpActor({ taskId: '', worktreePath: '/tmp/wt' });

    expect(isActorRef(agent)).toBe(false);
    expect(isActorRef(builder)).toBe(false);
    expect(agent).toBe('agent');
    expect(builder).toBe('builder');
  });
});
