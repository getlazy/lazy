/**
 * How proxy traffic reads on screen.
 *
 * The renderer is pure so the shape can be pinned without a daemon, a proxy or
 * a terminal. Two things matter most here and both are invariants, not
 * cosmetics: failures are LOUD (a revoked placeholder hammering the proxy is
 * the reason someone is watching), and a line never leaks a credential or any
 * request/response content.
 */
import { describe, test, expect } from 'bun:test';
import {
  renderProxyActivity,
  credentialRefusalHint,
  PROXY_LINE_PREFIX,
} from '../../src/cli/proxy-activity-renderer';
import {
  CREDENTIAL_REFUSED_PREFIX,
  type ProxyActivityClose,
  type ProxyActivityOpen,
} from '../../src/proxy/activity';

const OPEN: ProxyActivityOpen = {
  kind: 'open',
  id: 'id-1',
  seq: 1,
  ts: Date.parse('2026-08-22T10:11:12'),
  role: 'agent',
  taskId: 'abcdef1234567890',
  backend: 'proxy',
  method: 'POST',
  path: '/v1/messages',
  model: 'claude-opus-5',
};

const CLOSE: ProxyActivityClose = {
  ...OPEN,
  kind: 'close',
  status: 200,
  durationMs: 1_250,
  error: null,
  totalTokens: 12_345,
  denials: 0,
  rerouted: false,
  failed: false,
};

/** Strip ANSI so assertions are about content, not colour. */
function plain(line: string): string {
  return line.replace(new RegExp('\\[[0-9;]*m', 'g'), '');
}

describe('renderProxyActivity', () => {
  test('an open line says who, what and which model, with the net> prefix', () => {
    const line = plain(renderProxyActivity(OPEN));
    expect(line).toContain(PROXY_LINE_PREFIX);
    expect(line).toContain('10:11:12');
    expect(line).toContain('agent');
    expect(line).toContain('POST /v1/messages');
    expect(line).toContain('claude-opus-5');
  });

  test('a close line adds status, duration and tokens', () => {
    const line = plain(renderProxyActivity(CLOSE));
    expect(line).toContain('200');
    expect(line).toContain('1.3s');
    expect(line).toContain('12,345 tok');
  });

  test('sub-second requests render in ms, not 0.1s', () => {
    expect(plain(renderProxyActivity({ ...CLOSE, durationMs: 87 }))).toContain('87ms');
  });

  test('the task id appears only when asked for', () => {
    expect(plain(renderProxyActivity(OPEN, { includeTask: true }))).toContain('agent/abcdef12');
    expect(plain(renderProxyActivity(OPEN, { includeTask: false }))).not.toContain('abcdef12');
  });

  // Traffic the proxy could not tie to a grant is itself worth noticing, so it
  // renders as a visible `-` rather than a blank that looks like a glitch.
  test('unattributed traffic is visibly unattributed', () => {
    const line = plain(
      renderProxyActivity({ ...OPEN, role: null, taskId: null }, { includeTask: true }),
    );
    expect(line).toContain('-/-');
  });

  // Cursor's wire format is opaque connect-rpc protobuf that lazy deliberately
  // does not parse — so these records ARE coarse, and the line says which
  // backend it is rather than inventing model/token detail it does not have.
  test('cursor traffic is tagged and carries no invented detail', () => {
    const line = plain(renderProxyActivity({
      ...CLOSE, backend: 'cursor', model: null, totalTokens: null,
    }));
    expect(line).toContain('[cursor]');
    expect(line).toContain('POST /v1/messages');
    expect(line).not.toContain('tok');
  });

  test('a failure is marked with a grep-able word, not only a colour', () => {
    const line = plain(renderProxyActivity({
      ...CLOSE, failed: true, status: 500, error: 'upstream overloaded',
    }));
    expect(line).toContain('FAIL(500)');
    expect(line).toContain('upstream overloaded');
  });

  test('a forward that never got a response says so', () => {
    const line = plain(renderProxyActivity({
      ...CLOSE, failed: true, status: null, error: 'connect ECONNREFUSED',
    }));
    expect(line).toContain('FAIL(no-response)');
  });

  test('denials and reroutes are called out', () => {
    expect(plain(renderProxyActivity({ ...CLOSE, denials: 2 }))).toContain('DENY(2)');
    expect(plain(renderProxyActivity({ ...CLOSE, rerouted: true }))).toContain('REROUTE');
  });

  // INVARIANT: proxy lines show the PASSAGE of a request, never its content and
  // never a credential. The event type carries no body and no header values;
  // this pins that the renderer does not start printing them either.
  test('no credential-shaped or content-shaped value can reach a line', () => {
    const line = plain(renderProxyActivity(CLOSE, { includeTask: true }));
    expect(line).not.toContain('sk-ant');
    expect(line).not.toMatch(/authorization|x-api-key|bearer/i);
  });

  // INVARIANT: every rendered field comes from the agent's OWN request, and the
  // reader is a human operator at a terminal. An ESC in a path can retitle
  // their window, erase the lines above, or forge a green ✓ over a denial — so
  // C0/C1 controls are stripped from every field rather than trusted.
  test('terminal escape sequences in agent-controlled fields cannot reach the screen', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const hostile = `${ESC}]0;pwned${BEL}${ESC}[2J${ESC}[31mFAKE${ESC}[0m\r\n`;
    const line = renderProxyActivity(
      {
        ...CLOSE,
        failed: true,
        status: 500,
        path: `/v1/messages${hostile}`,
        method: `POST${hostile}`,
        model: `claude${hostile}`,
        error: `boom${hostile}`,
        role: `agent${hostile}`,
        taskId: `task${hostile}`,
      },
      { includeTask: true },
    );
    // Only the renderer's OWN colour codes may remain; nothing from the event.
    expect(line).not.toContain(`${ESC}]`);
    expect(line).not.toContain(`${ESC}[2J`);
    expect(line).not.toContain(BEL);
    expect(line).not.toContain('\r');
    expect(line).not.toContain('\n');
    // The legible remains of each field still render.
    expect(plain(line)).toContain('/v1/messages');
    expect(plain(line)).toContain('boom');
  });

  // A 20 KB path is a scroll-wipe by other means, even with no escapes in it.
  test('an absurdly long field is truncated', () => {
    const line = plain(renderProxyActivity({ ...CLOSE, path: '/' + 'a'.repeat(5_000) }));
    expect(line.length).toBeLessThan(600);
    expect(line).toContain('…');
  });
});

describe('credentialRefusalHint', () => {
  // A proxy 401 is NOT an upstream auth problem to go debug at Anthropic — it
  // means a container is presenting a placeholder with no live grant. Saying so
  // once is the difference between a useful watch and a confusing one.
  test('fires for a credential refusal and names the real cause', () => {
    const hint = plain(credentialRefusalHint({
      ...CLOSE, failed: true, status: 401, error: 'credential refused: no live grant',
    })!);
    expect(hint).toContain('placeholder');
    expect(hint).toContain('lazy doctor');
  });

  // INVARIANT: this remedy is keyed off a STRING the proxy writes into the
  // audit record, so the two must be one shared constant. Reworded in
  // src/proxy/server.ts alone, the remedy would silently stop appearing and
  // nothing would fail — the watcher would just be left to guess again.
  test('the refusal prefix is the same constant the proxy writes', () => {
    const refusalFromProxy = `${CREDENTIAL_REFUSED_PREFIX}: unknown placeholder`;
    expect(credentialRefusalHint({
      ...CLOSE, failed: true, status: 401, error: refusalFromProxy,
    })).not.toBeNull();
  });

  test('does not fire for other 401s or other failures', () => {
    expect(credentialRefusalHint({
      ...CLOSE, failed: true, status: 401, error: 'upstream said no',
    })).toBeNull();
    expect(credentialRefusalHint({
      ...CLOSE, failed: true, status: 500, error: 'credential refused',
    })).toBeNull();
    expect(credentialRefusalHint(CLOSE)).toBeNull();
    expect(credentialRefusalHint(OPEN)).toBeNull();
  });
});
