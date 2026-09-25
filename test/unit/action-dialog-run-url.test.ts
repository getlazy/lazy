/**
 * The action dialog's run poller builds its URL from the STAMPED task segment.
 *
 * INVARIANT: `data-lz-task-id` carries the ALREADY-escaped path segment
 * (`taskPathSegment`), so every client script interpolates it RAW. The poller
 * applied `encodeURIComponent` to it a second time, so for a code needing
 * escaping it polled `/tasks/my%2520task/action-runs/<id>` and its `/ws`
 * sibling, 404'd, and showed "Lost the action" — while the accept / unblock /
 * sync it was following was in fact still running. A silent success reported
 * as a loss is the worst shape of the double-escape bug, which is why this one
 * gets its own suite.
 *
 * WHY THIS DRIVES THE REAL SCRIPT rather than asserting on its text: the
 * re-escape happened at RUNTIME, on a value read from the DOM, so it was
 * invisible to `task-code-url-escaping.test.ts`, which pins the emitted
 * strings. A static "does not contain encodeURIComponent(taskId)" assertion
 * would pin today's spelling and not the behavior — rename the variable and it
 * passes again while the bug returns. So the script is executed and the URL it
 * actually requests is captured.
 */

import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { actionDialogChromeHtml, actionDialogScript } from '../../src/server/action-dialog';
import { taskPathSegment } from '../../src/server/task-urls';

const CODE = 'my task';
/** What the server stamps: escaped exactly once. */
const SEG = taskPathSegment({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', code: CODE });

interface Driven {
  fetched: string[];
  sockets: string[];
}

/**
 * Render a task page carrying an action form, run the shipped script in it,
 * submit the form, and return every URL the script requested.
 *
 * `socketFails` makes the WebSocket constructor throw, which is how the script
 * falls back to the HTTP poll — both URLs are built from the same base, and
 * both were wrong, so both are asserted.
 */
async function driveRun(
  stamped: string,
  postBody: Record<string, unknown>,
  socketFails = false,
): Promise<Driven> {
  const window = new Window({ url: `http://localhost/tasks/${stamped}` });
  const document = window.document;
  document.body.innerHTML =
    `<div data-lz-task-page data-lz-task-id="${stamped}">` +
    `<form action="/tasks/${stamped}/actions/accept" method="post" data-lz-action-form data-lz-action-when="always">` +
    `<button type="submit">Accept</button>` +
    `</form>` +
    `</div>` +
    actionDialogChromeHtml();

  const fetched: string[] = [];
  const sockets: string[] = [];

  // First call is the POST that starts the run; every later one is the poll.
  (window as unknown as { fetch: unknown }).fetch = (url: string) => {
    fetched.push(String(url));
    const body = fetched.length === 1 ? postBody : { status: 'running', events: [] };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  };
  class FakeSocket {
    constructor(url: string) {
      sockets.push(String(url));
      if (socketFails) throw new Error('no websocket here');
    }
    close(): void { /* nothing to tear down in the fake */ }
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

  // The helpers return the script wrapped in a <script> tag for embedding.
  const strip = (s: string) => s.replace(/^<script>/, '').replace(/<\/script>$/, '');
  window.eval(strip(actionDialogScript()));
  document.querySelector('form')!.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );

  // Let the POST promise chain settle into followRun.
  const wanted = socketFails ? 2 : 1;
  for (let i = 0; i < 20 && (fetched.length < wanted || sockets.length === 0); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await window.happyDOM.close();
  return { fetched, sockets };
}

describe('action dialog run follow URLs', () => {
  test('the run websocket carries the stamped segment verbatim — escaped once, never twice', async () => {
    const { sockets } = await driveRun(SEG, { runId: 'run-1' });

    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets[0]).toBe(`ws://localhost/tasks/${SEG}/action-runs/run-1/ws`);
    expect(sockets[0]).toBe('ws://localhost/tasks/my%20task/action-runs/run-1/ws');
    // The double-escape signature, named for what it is.
    expect(sockets[0]).not.toContain('my%2520task');
  });

  test('the HTTP poll fallback carries it too', async () => {
    // The poll is the backstop when the socket will not open — the path a
    // reviewer behind a proxy that drops websockets actually takes, and the
    // one that produced "Lost the action" while the run kept going.
    const { fetched } = await driveRun(SEG, { runId: 'run-2' }, true);

    // [0] is the POST that started the run; [1] is the run poll.
    expect(fetched.length).toBeGreaterThan(1);
    expect(fetched[1]).toBe(`/tasks/${SEG}/action-runs/run-2`);
    expect(fetched[1]).toBe('/tasks/my%20task/action-runs/run-2');
    expect(fetched[1]).not.toContain('my%2520task');
  });

  // The two sources of the segment differ in escaping, which is what made this
  // easy to get wrong: the stamp is escaped, while a taskId in the response
  // body is a RAW id from the daemon. Both must reach followRun escaped once.
  test('a raw task id from the response body is escaped exactly once', async () => {
    const rawId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { fetched } = await driveRun(SEG, { runId: 'run-3', taskId: rawId }, true);

    expect(fetched.length).toBeGreaterThan(1);
    // A uuid needs no escaping, so it appears verbatim — and not the stamped
    // code, since the body named a different task.
    expect(fetched[1]).toBe(`/tasks/${rawId}/action-runs/run-3`);
  });

  test('a plain kebab code is unaffected — the ordinary case still follows itself', async () => {
    const { fetched } = await driveRun('teams-cli-login', { runId: 'run-4' }, true);
    expect(fetched[1]).toBe('/tasks/teams-cli-login/action-runs/run-4');
  });
});
