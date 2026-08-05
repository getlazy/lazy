/**
 * Unit tests for the container-side daemon MCP proxy error handling.
 *
 * The proxy forwards every lazy tool call from inside a builder/agent container
 * to the daemon over HTTP. When the daemon has restarted or moved since the
 * builder launched, those calls fail — and a bare "Unauthorized" / raw
 * ECONNREFUSED leaves the user with no idea what happened or how to recover
 * (the fix-builder-daemon-reauth incident). These tests pin the actionable,
 * recoverable messages the proxy must surface instead.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  classifyTransportFailure,
  createDaemonProxyHandler,
  daemonUnauthorizedMessage,
  daemonUnreachableMessage,
  probeDaemonStatus,
  type DaemonMcpConfig,
} from '../../src/daemon/mcp-proxy';
import {
  DaemonConnectionLostError,
  HEARTBEAT_HEADER,
  heartbeatEnvelopeResponse,
} from '../../src/daemon/heartbeat';

describe('daemon MCP proxy error handling', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { s.stop(true); } catch { /* ignore */ }
    }
    servers.length = 0;
  });

  function serve(handler: (req: Request) => Response): number {
    const s = Bun.serve({ port: 0, fetch: handler });
    servers.push(s);
    return s.port!;
  }

  function configFor(port: number): DaemonMcpConfig {
    return { token: 'stale-token', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}` };
  }

  // INVARIANT: a 401 from the daemon becomes an actionable, recoverable error —
  // it names the cause (stale credentials after a daemon restart) and the fix
  // (relaunch the builder), NOT the daemon's bare "Unauthorized".
  test('401 surfaces an actionable relaunch message, not bare Unauthorized', async () => {
    const port = serve(() => Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const handler = createDaemonProxyHandler(configFor(port), 'lazy_list');

    let thrown: unknown;
    try {
      await handler({});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('401');
    expect(msg).toContain('lazy_list');
    expect(msg).toContain('restarted');
    expect(msg).toContain('lazy builder --resume');
    // Must NOT be the useless bare token error.
    expect(msg).not.toBe('Unauthorized');
  });

  // INVARIANT: an unreachable daemon (connection refused — the daemon is down or
  // moved to a different port) becomes an actionable message pointing at
  // `lazy daemon status`/`start` and a builder relaunch, not a raw ECONNREFUSED.
  test('an unreachable daemon surfaces an actionable message, not a raw socket error', async () => {
    // Bind and immediately release a port so nothing is listening there.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const deadPort = probe.port!;
    probe.stop(true);

    const handler = createDaemonProxyHandler(configFor(deadPort), 'lazy_show');

    let thrown: unknown;
    try {
      await handler({});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('lazy_show');
    expect(msg).toContain('could not reach the daemon');
    expect(msg).toContain('lazy daemon status');
    expect(msg).toContain('lazy builder --resume');
  });

  // A successful call still returns the daemon's result unchanged — the new
  // error handling must not disturb the happy path.
  test('a successful call returns the daemon result', async () => {
    const port = serve(() => Response.json({ result: { ok: true, items: [1, 2, 3] } }));
    const handler = createDaemonProxyHandler(configFor(port), 'lazy_list');

    const result = await handler({});
    expect(result).toEqual({ ok: true, items: [1, 2, 3] });
  });

  // A non-401 error response still propagates the daemon's own error text (e.g.
  // a project-mismatch 400) so callers see the real reason.
  test('a non-401 error response propagates the daemon error text', async () => {
    const port = serve(() => Response.json({ error: 'Project mismatch: daemon serves /other' }, { status: 400 }));
    const handler = createDaemonProxyHandler(configFor(port), 'lazy_list');

    let thrown: unknown;
    try {
      await handler({});
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain('Project mismatch');
  });

  // The message builders are pure and self-contained (used above; asserted here
  // directly so the exact recovery guidance is pinned).
  test('message builders name the tool and the recovery path', () => {
    const unauthorized = daemonUnauthorizedMessage('lazy_create');
    expect(unauthorized).toContain('lazy_create');
    expect(unauthorized).toContain('lazy builder --resume');

    const unreachable = daemonUnreachableMessage('lazy_diff', 'http://host.docker.internal:26024', 'ECONNREFUSED');
    expect(unreachable).toContain('lazy_diff');
    expect(unreachable).toContain('host.docker.internal:26024');
    expect(unreachable).toContain('ECONNREFUSED');
  });
});

/**
 * A long tool call — `lazy_wait`'s 600s long-poll, `lazy_accept`'s merge — is
 * the case the proxy gets wrong most expensively, because the failure looks
 * like a dead daemon from inside the container and like nothing at all from
 * outside it.
 *
 * The field report these tests come from: two `lazy_wait` calls minutes apart
 * failed with "could not reach the daemon ... The daemon appears to be down",
 * while that same daemon answered `/daemon/status` in 5ms and served every
 * other tool call from the same builder session. The operator was sent to
 * relaunch a builder that did not need relaunching.
 */
describe('daemon MCP proxy long calls', () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { s.stop(true); } catch { /* ignore */ }
    }
    servers.length = 0;
  });

  // Deliberately shorter than the work below, so a call that is NOT kept alive
  // by heartbeat framing is reaped rather than merely slow. Bun degenerates
  // idleTimeout values of 2-4 into a ~4s hard deadline, so 5 is the floor.
  const TEST_IDLE_TIMEOUT_S = 5;
  const SLOW_OP_MS = 16_000;
  const TEST_HEARTBEAT_MS = 1_000;

  function serveWithIdleTimeout(handler: (req: Request) => Response | Promise<Response>): number {
    const s = Bun.serve({
      port: 0,
      idleTimeout: TEST_IDLE_TIMEOUT_S,
      fetch: handler,
    });
    servers.push(s);
    return s.port!;
  }

  function configFor(port: number): DaemonMcpConfig {
    return { token: 't', projectRoot: '/proj', taskId: '', target: `http://localhost:${port}` };
  }

  // INVARIANT: the proxy asks for heartbeat framing on EVERY tool call, and a
  // call that outlives the listener's idle timer completes normally because of
  // it. This is the `lazy_wait` reproduction: without the request header the
  // daemon replies unframed and the connection is reaped mid-flight.
  test('a tool call outliving the idle timeout completes via heartbeat framing', async () => {
    let sawHeartbeatHeader: string | null = null;
    const port = serveWithIdleTimeout(req => {
      const url = new URL(req.url);
      if (url.pathname === '/daemon/status') return Response.json({ projectRoot: '/proj' });
      sawHeartbeatHeader = req.headers.get(HEARTBEAT_HEADER);
      return heartbeatEnvelopeResponse(
        async () => {
          await Bun.sleep(SLOW_OP_MS);
          return { status: 200, body: { result: { task_id: 'abc12345', timed_out: true } } };
        },
        { intervalMs: TEST_HEARTBEAT_MS },
      );
    });

    const handler = createDaemonProxyHandler(configFor(port), 'lazy_wait');
    const result = await handler({ task_id: 'abc12345', timeout: 600 });

    expect(sawHeartbeatHeader).not.toBeNull();
    expect(result).toEqual({ task_id: 'abc12345', timed_out: true });
  }, SLOW_OP_MS + 20_000);

  // INVARIANT: the daemon's heartbeat frames are RELAYED to the MCP client as
  // progress, while the call is still running.
  //
  // The reproduction: `lazy_accept`'s pre-accept validation turn holds the
  // daemon request for up to 30 minutes. The HTTP connection survived that
  // (framing works), but the frames stopped here — so the MCP client, whose
  // watchdog counts only responses and progress notifications, aborted the call
  // at its own 30-minute idle limit and abandoned the accept mid-flight.
  test('daemon heartbeats are relayed as progress while the call is in flight', async () => {
    const port = serveWithIdleTimeout(req => {
      const url = new URL(req.url);
      if (url.pathname === '/daemon/status') return Response.json({ projectRoot: '/proj' });
      return heartbeatEnvelopeResponse(
        async () => {
          await Bun.sleep(SLOW_OP_MS);
          return { status: 200, body: { result: { status: 'merged' } } };
        },
        { intervalMs: TEST_HEARTBEAT_MS },
      );
    });

    const reports: string[] = [];
    let reportedBeforeResult = 0;
    const handler = createDaemonProxyHandler(configFor(port), 'lazy_accept');
    const result = await handler({ task_id: 'abc12345' }, {
      reportProgress: (message?: string) => {
        reports.push(message ?? '');
        reportedBeforeResult += 1;
      },
    });

    expect(result).toEqual({ status: 'merged' });
    // The op runs SLOW_OP_MS at TEST_HEARTBEAT_MS cadence, so several frames
    // land mid-call — plus the preamble, which is the daemon's first written
    // byte and counts as liveness too.
    expect(reportedBeforeResult).toBeGreaterThanOrEqual(3);
    expect(reports.every(m => m.includes('lazy_accept'))).toBe(true);
  }, SLOW_OP_MS + 20_000);

  // A handler whose caller supplied no progress channel (local mode, tests)
  // must behave exactly as before — the relay is additive, never required.
  test('a call with no progress channel still returns its result', async () => {
    const port = serveWithIdleTimeout(req => {
      if (new URL(req.url).pathname === '/daemon/status') return Response.json({ projectRoot: '/proj' });
      return heartbeatEnvelopeResponse(
        async () => ({ status: 200, body: { result: { ok: true } } }),
        { intervalMs: TEST_HEARTBEAT_MS },
      );
    });

    const handler = createDaemonProxyHandler(configFor(port), 'lazy_show');
    expect(await handler({ task_id: 'abc12345' })).toEqual({ ok: true });
  });

  // INVARIANT: relaying progress must never break the call it reports on. A
  // client that has already hung up makes the write throw; the daemon's result
  // still has to be read, or work that actually completed is misreported.
  test('a throwing progress channel does not fail the tool call', async () => {
    const port = serveWithIdleTimeout(req => {
      if (new URL(req.url).pathname === '/daemon/status') return Response.json({ projectRoot: '/proj' });
      return heartbeatEnvelopeResponse(
        async () => ({ status: 200, body: { result: { ok: true } } }),
        { intervalMs: TEST_HEARTBEAT_MS },
      );
    });

    const handler = createDaemonProxyHandler(configFor(port), 'lazy_show', {
      log: () => { /* silence the expected diagnostic */ },
    });
    const result = await handler({ task_id: 'abc12345' }, {
      reportProgress: () => { throw new Error('EPIPE: client gone'); },
    });

    expect(result).toEqual({ ok: true });
  });

  // INVARIANT: a daemon that answers /daemon/status is NOT down, and must never
  // be described as down — whatever the transport error said. This is the exact
  // misdiagnosis from the field report.
  test('an unrecognised transport failure against a LIVE daemon is not blamed on a down daemon', async () => {
    const port = serveWithIdleTimeout(() => Response.json({ projectRoot: '/proj' }));

    const err = await classifyTransportFailure(
      'lazy_wait',
      configFor(port),
      // Deliberately not in either classification list: the point is that an
      // unrecognised wording no longer decides the message by itself.
      'fetch failed: something nobody has seen before',
    );

    expect(err).toBeInstanceOf(DaemonConnectionLostError);
    expect(err.message).not.toContain('appears to be down');
    expect(err.message).toContain('so it is up');
  });

  // The other half: when the probe ALSO fails, "down or moved" is the correct
  // and actionable answer, and the message says the probe was actually made.
  test('an unrecognised transport failure with no daemon answering still reports unreachable', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const deadPort = probe.port!;
    probe.stop(true);

    const err = await classifyTransportFailure(
      'lazy_wait',
      configFor(deadPort),
      'fetch failed: something nobody has seen before',
    );

    expect(err).not.toBeInstanceOf(DaemonConnectionLostError);
    expect(err.message).toContain('could not reach the daemon');
    expect(err.message).toContain('got no answer either');
  });

  // A daemon that answers but serves a DIFFERENT project explains itself, since
  // relaunching the builder is genuinely the fix in that case.
  test('a foreign daemon on our port is named as the cause', async () => {
    const port = serveWithIdleTimeout(() => Response.json({ projectRoot: '/somewhere/else' }));

    const err = await classifyTransportFailure(
      'lazy_wait',
      configFor(port),
      'fetch failed: something nobody has seen before',
    );

    expect(err.message).toContain('DIFFERENT project');
    expect(err.message).toContain('/somewhere/else');
    expect(err.message).toContain('lazy builder --resume');
  });

  // probeDaemonStatus reports "responded" for anything speaking HTTP, including
  // an error status — the question it answers is "is something alive there",
  // not "is it healthy".
  test('probeDaemonStatus distinguishes answered from unreachable', async () => {
    const okPort = serveWithIdleTimeout(() => Response.json({ projectRoot: '/proj' }));
    expect(await probeDaemonStatus(`http://localhost:${okPort}`)).toEqual({
      responded: true,
      projectRoot: '/proj',
    });

    const errPort = serveWithIdleTimeout(() => new Response('nope', { status: 500 }));
    expect(await probeDaemonStatus(`http://localhost:${errPort}`)).toEqual({
      responded: true,
      projectRoot: null,
    });

    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const deadPort = probe.port!;
    probe.stop(true);
    expect(await probeDaemonStatus(`http://localhost:${deadPort}`)).toEqual({
      responded: false,
      projectRoot: null,
    });
  });
});
