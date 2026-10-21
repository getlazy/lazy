/**
 * The supervisor installs each turn's session placeholder in its own env
 * (src/supervisor/turn-credential-env.ts), so a reused task container serves a
 * turn whose credential kind differs from the one it was created with.
 *
 * INVARIANT: a running container — and the services a person is using in it —
 * survives a turn whose owner holds a different credential kind. The agent gets
 * the placeholder in the env var that kind needs; nothing else in the env moves.
 * Before this the daemon recreated the container on every such change
 * (engineer, 2026-10-20: starting a turn must leave a task's services alone).
 */

import { describe, test, expect } from 'bun:test';
import { turnCredentialEnvChanges } from '../../src/supervisor/turn-credential-env';
import { SESSION_TOKEN_PREFIX } from '../../src/daemon/session-credentials';

const OLD = `${SESSION_TOKEN_PREFIX}old-api-key-placeholder`;
const NEW = `${SESSION_TOKEN_PREFIX}new-oauth-placeholder`;

describe('turn credential env', () => {
  test('moves the placeholder to the env var the turn\'s kind needs', () => {
    const env = { ANTHROPIC_API_KEY: OLD, ANTHROPIC_BASE_URL: 'http://proxy' };
    expect(turnCredentialEnvChanges(env, [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: NEW }], 'claude-code')).toEqual({
      set: { CLAUDE_CODE_OAUTH_TOKEN: NEW },
      unset: ['ANTHROPIC_API_KEY'],
    });
    // And back: OAuth container, API-key turn.
    expect(turnCredentialEnvChanges({ CLAUDE_CODE_OAUTH_TOKEN: NEW }, [{ key: 'ANTHROPIC_API_KEY', value: OLD }], 'claude-code')).toEqual({
      set: { ANTHROPIC_API_KEY: OLD },
      unset: ['CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  test('same kind: the value is set again, nothing removed', () => {
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: OLD }, [{ key: 'ANTHROPIC_API_KEY', value: OLD }], 'claude-code')).toEqual({
      set: { ANTHROPIC_API_KEY: OLD },
      unset: [],
    });
  });

  // pi reads ANTHROPIC_AUTH_TOKEN for a bearer credential — mirrored exactly as
  // the launch mirrors it, and dropped again when the kind goes back.
  test('pi gets the OAuth placeholder mirrored, and loses the mirror on an API-key turn', () => {
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: OLD }, [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: NEW }], 'pi')).toEqual({
      set: { CLAUDE_CODE_OAUTH_TOKEN: NEW, ANTHROPIC_AUTH_TOKEN: NEW },
      unset: ['ANTHROPIC_API_KEY'],
    });
    expect(turnCredentialEnvChanges(
      { CLAUDE_CODE_OAUTH_TOKEN: NEW, ANTHROPIC_AUTH_TOKEN: NEW },
      [{ key: 'ANTHROPIC_API_KEY', value: OLD }],
      'pi',
    )).toEqual({ set: { ANTHROPIC_API_KEY: OLD }, unset: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] });
  });

  // INVARIANT: a command never ADDS an Anthropic credential to a container
  // launched without one (a codex or cursor task in team mode), never touches a
  // real credential, and never sets anything that is not a session placeholder.
  test('changes nothing in a container that holds no session placeholder, and never touches a real key', () => {
    const none = { set: {}, unset: [] };
    expect(turnCredentialEnvChanges({ OPENAI_API_KEY: 'x' }, [{ key: 'ANTHROPIC_API_KEY', value: OLD }], 'claude-code')).toEqual(none);
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: 'sk-ant-real' }, [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: NEW }], 'claude-code')).toEqual(none);
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: OLD }, [{ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-real' }], 'claude-code')).toEqual(none);
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: OLD }, [{ key: 'PATH', value: NEW }], 'claude-code')).toEqual(none);
    expect(turnCredentialEnvChanges({ ANTHROPIC_API_KEY: OLD }, undefined, 'claude-code')).toEqual(none);
  });
});
