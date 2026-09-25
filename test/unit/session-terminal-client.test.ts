/**
 * The CLIENT half of the terminal protocol, as a bound clone's `lazy builder`
 * uses it through Lazy Teams (src/teams/session-terminal.ts): the relay URL it
 * opens, and how it reads the daemon's control frames.
 */

import { describe, test, expect } from 'bun:test';
import { remoteAttachUrl, localTerminalSize } from '../../src/teams/session-terminal';
import { parseShellServerMessage, shellClientMessage, parseShellClientMessage } from '../../src/server/shell-protocol';

describe('remoteAttachUrl', () => {
  // INVARIANT: the clone attaches through TEAMS' relay route, never a daemon
  // address, and the session id stays one path segment whatever it contains.
  test('targets the Teams relay route for the bound project, over ws/wss', () => {
    expect(remoteAttachUrl({ teamsUrl: 'https://teams.example.com', project: 'acme/lazy-toy', sessionId: 's-1', cols: 120, rows: 40 }))
      .toBe('wss://teams.example.com/api/projects/acme/lazy-toy/sessions/s-1/attach?cols=120&rows=40');
    expect(remoteAttachUrl({ teamsUrl: 'http://127.0.0.1:3000/', project: 'a/b', sessionId: '../x?y', cols: 80, rows: 24, mode: 'pair' }))
      .toBe('ws://127.0.0.1:3000/api/projects/a/b/sessions/..%2Fx%3Fy/attach?cols=80&rows=24&mode=pair');
  });

  test('a builder attach sends no mode', () => {
    expect(remoteAttachUrl({ teamsUrl: 'http://h', project: 'a/b', sessionId: 's', cols: 80, rows: 24, mode: 'attach' }))
      .not.toContain('mode=');
  });

  test('the local size is clamped to what the protocol accepts', () => {
    expect(localTerminalSize({ columns: 5000, rows: 1 })).toEqual({ cols: 1000, rows: 2 });
    expect(localTerminalSize({})).toEqual({ cols: 80, rows: 24 });
  });
});

describe('the client half of shell-protocol', () => {
  test('a resize the client writes is one the server parses', () => {
    expect(parseShellClientMessage(shellClientMessage({ type: 'resize', cols: 100, rows: 30 })))
      .toEqual({ ok: true, message: { type: 'resize', cols: 100, rows: 30 } });
  });

  test('reads ready, exit and error', () => {
    expect(parseShellServerMessage('{"type":"ready","container":"c"}')).toEqual({ ok: true, message: { type: 'ready', container: 'c' } });
    expect(parseShellServerMessage('{"type":"exit","code":null}')).toEqual({ ok: true, message: { type: 'exit', code: null } });
    expect(parseShellServerMessage('{"type":"error","message":"m"}')).toEqual({ ok: true, message: { type: 'error', message: 'm' } });
  });

  // INVARIANT: a malformed control frame is reported, never thrown — one bad
  // frame must not take a live terminal down.
  test('rejects malformed frames without throwing', () => {
    for (const raw of ['nope', '[]', '{"type":"exit","code":1.5}', '{"type":"ready"}', '{"type":"other"}']) {
      expect(parseShellServerMessage(raw).ok).toBe(false);
    }
  });
});
