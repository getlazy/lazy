/**
 * INVARIANT: every turn-launching path binds the turn's credential BEFORE it
 * writes the protocol command that starts the turn.
 *
 * A binding is revoked when its turn's process exits. A supervisor that
 * outlived its daemon — the daemon crashed rather than stopped, which is
 * exactly what "restart then resume" looks like — is already polling the
 * protocol directory and picks the next command up the instant it lands. Bind
 * after the write and there is a window in which the agent is talking to the
 * proxy on a revoked placeholder: 401, classified `fatal_auth`, non-retryable,
 * turn dead on attempt one.
 *
 * The ordering is a property of the call sites, not of any one function, so it
 * is asserted on the source. If you add a turn-launching path, add its
 * credential call above its `writeCommand` and this test keeps passing.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');

/** Files that launch a turn, and the call that binds its credential. */
const SITES: Array<{ file: string; bind: RegExp }> = [
  { file: 'src/daemon/task-lifecycle.ts', bind: /await prepareTurnLaunch\(/g },
  { file: 'src/daemon/auto-deliver.ts', bind: /await planTurnCredential\(/g },
  { file: 'src/utils/auto-resume.ts', bind: /await planTurnCredential\(/g },
];

/** The write that hands the turn to the supervisor. */
const WRITE = /writeCommand\(protoDir,/g;

function offsets(source: string, re: RegExp): number[] {
  return [...source.matchAll(re)].map((m) => m.index ?? -1);
}

describe('turn credential ordering', () => {
  for (const site of SITES) {
    test(`${site.file} binds the credential before writing the command`, async () => {
      const source = await readFile(join(REPO, site.file), 'utf-8');
      const binds = offsets(source, site.bind);
      const writes = offsets(source, WRITE);

      // Every turn-launching command write has its own credential call.
      expect(binds.length).toBe(writes.length);
      expect(writes.length).toBeGreaterThan(0);

      // Pairwise, in source order: bind N precedes write N, and (for all but
      // the last) write N precedes bind N+1 — so no site borrows another's.
      for (let i = 0; i < writes.length; i++) {
        expect(binds[i]).toBeLessThan(writes[i]);
        if (i + 1 < binds.length) expect(writes[i]).toBeLessThan(binds[i + 1]);
      }
    });
  }

  // INVARIANT (deliberate exception): the mechanical acceptance gate writes
  // its command into its OWN sibling mailbox (`${taskId}-gate`) under the
  // local name `gateProtoDir`, and binds NO credential — no agent runs, so
  // there is nothing to bind for. A distinct local name keeps the pairing
  // scan above counting agent-turn writes only. This test pins that the
  // exception stays mechanical: if the gate ever grows an agent session (or
  // someone renames the local back to `protoDir`), the pairing scan will
  // start failing here and the gate then needs a real credential bind BEFORE
  // its write, like every turn-launching path.
  test('the acceptance gate writes its sibling mailbox without a credential bind, by design', async () => {
    const source = await readFile(join(REPO, 'src/daemon/task-lifecycle.ts'), 'utf-8');
    // The gate mailbox write exists and keeps its distinct local name.
    expect(source).toContain('writeCommand(gateProtoDir, gateCommand)');
    // No prepareTurnLaunch between the gate mailbox assignment and its write:
    // the gate section binds no credential.
    // No credential bind between the gate mailbox assignment and its write:
    // the gate section binds nothing. Comment lines are stripped first — the
    // gate's own comment names this scan, and a source scan must not count
    // prose.
    const gateSection = source
      .slice(
        source.indexOf('gateProtoDir = acceptGateProtocolDir('),
        source.indexOf('writeCommand(gateProtoDir, gateCommand)'),
      )
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(gateSection).not.toContain('prepareTurnLaunch(');
  });
});
