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

  // INVARIANT: a bound clone names the project it bound to by ID as well as by
  // address. A project can be renamed and its old address taken by another;
  // Teams reaches the bound project by this id, never the address's new holder.
  test('carries the bound project id when the binding recorded one', () => {
    expect(remoteAttachUrl({ teamsUrl: 'https://t', project: 'a/b', projectId: '42', sessionId: 's', cols: 80, rows: 24 }))
      .toBe('wss://t/api/projects/a/b/sessions/s/attach?cols=80&rows=24&project_id=42');
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

  test('reads status, ready, exit and error', () => {
    expect(parseShellServerMessage('{"type":"status","message":"Preparing"}')).toEqual({ ok: true, message: { type: 'status', message: 'Preparing' } });
    expect(parseShellServerMessage('{"type":"ready","container":"c"}')).toEqual({ ok: true, message: { type: 'ready', container: 'c' } });
    expect(parseShellServerMessage('{"type":"exit","code":null}')).toEqual({ ok: true, message: { type: 'exit', code: null } });
    expect(parseShellServerMessage('{"type":"error","message":"m"}')).toEqual({ ok: true, message: { type: 'error', message: 'm' } });
  });

  // INVARIANT: a malformed control frame is reported, never thrown — one bad
  // frame must not take a live terminal down.
  test('rejects malformed frames without throwing', () => {
    for (const raw of ['nope', '[]', '{"type":"exit","code":1.5}', '{"type":"ready"}', '{"type":"status"}', '{"type":"other"}']) {
      expect(parseShellServerMessage(raw).ok).toBe(false);
    }
  });
});
