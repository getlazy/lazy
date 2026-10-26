/**
 * The reconnect policy every browser terminal follows, run against BOTH copies:
 * the dashboard's embedded script (src/server/terminal-reconnect.ts) and Lazy
 * Teams' module (lazy-teams/app/javascript/terminal_reconnect.js).
 */

import { describe, test, expect } from 'bun:test';
import { TERMINAL_RECONNECT_JS } from '../../src/server/terminal-reconnect';
import { join } from 'path';

type Policy = {
  delay(attempt: number): number;
  outcome(o: { code: number; ended: boolean; resumable: boolean; restartable: boolean }): string;
  keepTrying(o: { restartable: boolean; startedAt: number; now: number }): boolean;
  finalMessage(code: number): string;
};

const dashboard: Policy = new Function(`${TERMINAL_RECONNECT_JS}
  return { delay: lzReconnectDelay, outcome: lzCloseOutcome, keepTrying: lzKeepTrying, finalMessage: lzFinalCloseMessage };`)();
// Read as SOURCE, not imported: lazy-teams/ is not part of a lazy release, and
// a shipped test must not import from it. Where it is absent (a release
// archive) only the dashboard copy is checked.
const teamsFile = Bun.file(join(import.meta.dir, '../../lazy-teams/app/javascript/terminal_reconnect.js'));
const teamsPolicy: Policy | null = (await teamsFile.exists())
  ? new Function(`${(await teamsFile.text()).replace(/^export /gm, '')}
      return { delay: reconnectDelay, outcome: closeOutcome, keepTrying, finalMessage: finalCloseMessage };`)()
  : null;

const policies: Array<[string, Policy]> = [['dashboard', dashboard]];
if (teamsPolicy) policies.push(['teams', teamsPolicy]);

for (const [name, p] of policies) {
  describe(`terminal reconnect policy (${name})`, () => {
    const base = { code: 1006, ended: false, resumable: true, restartable: false };

    // INVARIANT: a dropped connection to a session that is still running
    // reconnects by itself — "Reload" is never the advice for something the
    // page can do. 1000 counts as a drop too: a relay that lost its daemon
    // closes the browser with 1000, and only an exit/error frame (`ended`)
    // says the session itself is over.
    test('a drop reconnects', () => {
      for (const code of [1000, 1001, 1005, 1006, 1011, 1012]) expect(p.outcome({ ...base, code })).toBe('reconnect');
      expect(p.outcome({ ...base, resumable: false, restartable: true })).toBe('reconnect');
    });

    // INVARIANT: never reconnect when the session really ended — the program
    // exited or the server said why (`ended`), the person closed it, or a
    // close code that is a decision (refused, expired, taken over elsewhere).
    test('a real end never reconnects', () => {
      expect(p.outcome({ ...base, ended: true })).toBe('ended');
      for (const code of [1008, 4000, 4001]) expect(p.outcome({ ...base, code })).toBe('ended');
      expect(p.finalMessage(4001)).toBe('This terminal was opened in another window.');
    });

    test('a terminal that cannot be resumed lost its session with the connection', () => {
      expect(p.outcome({ ...base, resumable: false })).toBe('lost');
    });

    // INVARIANT: backoff is bounded — a few quick tries, then every 30s, and a
    // resumable terminal gives up once the daemon's 5-minute hold is over.
    test('backoff is quick, then capped, and bounded in time', () => {
      expect(p.delay(0)).toBe(250);
      expect(p.delay(1)).toBe(1000);
      expect(p.delay(6)).toBe(30_000);
      expect(p.delay(100)).toBe(30_000);
      expect(p.keepTrying({ restartable: false, startedAt: 0, now: 4 * 60_000 })).toBe(true);
      expect(p.keepTrying({ restartable: false, startedAt: 0, now: 5 * 60_000 + 1 })).toBe(false);
      expect(p.keepTrying({ restartable: true, startedAt: 0, now: 60 * 60_000 })).toBe(true);
    });
  });
}
