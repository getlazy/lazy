import { describe, test, expect, afterEach } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import {
  enableLastKnownGood,
  lastKnownGoodFor,
  lastKnownGoodState,
  rememberGoodConfig,
  resetLastKnownGood,
  type LastKnownGoodEvent,
} from '../../src/config/last-good';

afterEach(() => resetLastKnownGood());

describe('last known good config', () => {
  // INVARIANT: the fallback is keyed by the resolved path and nothing else.
  // It never hands out a config read from another file — which is what keeps
  // "a task worktree's lazy.toml has no authority" intact while it is on.
  test('only a config remembered from the SAME path is ever returned', () => {
    enableLastKnownGood();
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.server.dashboard_url = 'https://root.example';
    rememberGoodConfig('/proj/lazy.toml', cfg);

    expect(lastKnownGoodFor('/proj/.lazy/worktrees/x/lazy.toml', new Error('bad'))).toBeNull();
    expect(lastKnownGoodFor('/proj/lazy.toml', new Error('bad'))?.server.dashboard_url).toBe('https://root.example');
  });

  // INVARIANT: off unless a daemon turns it on — a CLI command reports a broken
  // file as broken.
  test('does nothing unless enabled', () => {
    rememberGoodConfig('/p/lazy.toml', structuredClone(DEFAULT_CONFIG));
    expect(lastKnownGoodFor('/p/lazy.toml', new Error('bad'))).toBeNull();
  });

  test('reports each episode once, and its end', () => {
    const events: LastKnownGoodEvent[] = [];
    enableLastKnownGood((e) => events.push(e));
    rememberGoodConfig('/p/lazy.toml', structuredClone(DEFAULT_CONFIG));
    lastKnownGoodFor('/p/lazy.toml', new Error('first'));
    lastKnownGoodFor('/p/lazy.toml', new Error('second'));
    expect(events.map((e) => e.kind)).toEqual(['fallback']);
    expect(lastKnownGoodState('/p/lazy.toml')?.error).toBe('second');

    rememberGoodConfig('/p/lazy.toml', structuredClone(DEFAULT_CONFIG));
    expect(events.map((e) => e.kind)).toEqual(['fallback', 'recovered']);
    expect(lastKnownGoodState('/p/lazy.toml')).toBeNull();
  });

  test('a caller mutating its fallback copy cannot change the next one', () => {
    enableLastKnownGood();
    rememberGoodConfig('/p/lazy.toml', structuredClone(DEFAULT_CONFIG));
    lastKnownGoodFor('/p/lazy.toml', new Error('x'))!.server.port = 1;
    expect(lastKnownGoodFor('/p/lazy.toml', new Error('x'))!.server.port).toBe(DEFAULT_CONFIG.server.port);
  });
});
