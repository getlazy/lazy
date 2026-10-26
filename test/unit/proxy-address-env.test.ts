/**
 * A task container outlives daemon restarts (src/runner/agent-stop.ts), and
 * the daemon's proxy port is OS-assigned per daemon, so the supervisor moves
 * its own env to the port each command names before it starts the agent
 * (src/supervisor/proxy-address-env.ts).
 */

import { describe, test, expect } from 'bun:test';
import { PROXY_BASE_ENV, proxyAddressEnvChanges } from '../../src/supervisor/proxy-address-env';

describe('proxyAddressEnvChanges', () => {
  const env = {
    [PROXY_BASE_ENV]: 'http://host.docker.internal:41234',
    ANTHROPIC_BASE_URL: 'http://host.docker.internal:41234',
    CURSOR_API_ENDPOINT: 'http://host.docker.internal:41234/_lazy/cursor',
    LAZY_CODEX_API_BASE: 'http://host.docker.internal:41234/_lazy/codex/v1',
    ANTHROPIC_AUTH_TOKEN: 'lazy-placeholder-abc',
    UNRELATED_URL: 'http://host.docker.internal:41234x/not-the-proxy',
    PATH: '/usr/bin',
  };

  // INVARIANT: only the PORT of values that start with the recorded proxy base
  // moves; credentials and every other value are left exactly as they were. A
  // kept container's placeholders are persisted grants that outlive the daemon.
  test('moves every proxy-based value to the new port and nothing else', () => {
    expect(proxyAddressEnvChanges(env, 50000)).toEqual({
      [PROXY_BASE_ENV]: 'http://host.docker.internal:50000',
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:50000',
      CURSOR_API_ENDPOINT: 'http://host.docker.internal:50000/_lazy/cursor',
      LAZY_CODEX_API_BASE: 'http://host.docker.internal:50000/_lazy/codex/v1',
    });
  });

  test('nothing to do when the port is unchanged, missing or invalid', () => {
    expect(proxyAddressEnvChanges(env, 41234)).toEqual({});
    expect(proxyAddressEnvChanges(env, undefined)).toEqual({});
    expect(proxyAddressEnvChanges(env, 0)).toEqual({});
    expect(proxyAddressEnvChanges(env, 70000)).toEqual({});
  });

  test('a container from before the recorded base is read off its container-spelled ANTHROPIC_BASE_URL', () => {
    expect(proxyAddressEnvChanges({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:41234' }, 50000)).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:50000',
      [PROXY_BASE_ENV]: 'http://host.docker.internal:50000',
    });
  });

  test('an ANTHROPIC_BASE_URL lazy did not write is never guessed at', () => {
    expect(proxyAddressEnvChanges({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 50000)).toEqual({});
    expect(proxyAddressEnvChanges({ ANTHROPIC_BASE_URL: 'not a url' }, 50000)).toEqual({});
    expect(proxyAddressEnvChanges({}, 50000)).toEqual({});
  });
});
