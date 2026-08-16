import { describe, test, expect } from 'bun:test';
import { InteractiveCredentialError } from '../../src/cli/interactive-auth';

/**
 * INVARIANT (fail loud BEFORE the launch): when `lazy pair` / `lazy chat`
 * resolves no model credential, it must say so before spawning Claude Code, and
 * must name every source it consulted and what it found there.
 *
 * The behavior this replaces is the bug: pair launched happily, exit code 0, not
 * a word on stderr — and the human discovered the problem as a `/login` prompt
 * several seconds into an interactive session they believed was authenticated.
 * Same contract as the builder's MCP preflight: throw, never warn.
 *
 * These assertions are on the MESSAGE because the message is the whole feature.
 * A throw that doesn't tell the human which source was empty, or that leaves
 * them believing their shell was consulted, has not fixed anything.
 */
describe('InteractiveCredentialError', () => {
  test('names the daemon as the source and reports what it said', () => {
    const err = new InteractiveCredentialError('lazy pair', 'reachable, but it reported no credential', null);
    expect(err.message).toContain('lazy pair');
    expect(err.message).toContain('the lazy daemon');
    expect(err.message).toContain('reachable, but it reported no credential');
  });

  test('reports an empty shell without implying it would have been used', () => {
    const err = new InteractiveCredentialError('lazy pair', 'not reachable', null);
    expect(err.message).toContain('no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY');
    // The shell is not a fallback. A human whose shell IS exporting a token must
    // not be left thinking lazy simply failed to find one.
    expect(err.message).toContain('Your shell is not consulted');
  });

  // The single most confusing case: the human has a perfectly good token
  // exported and lazy still refuses. It must say the token is being ignored ON
  // PURPOSE and point at the override, or the message reads as a plain bug.
  test('says explicitly when a shell credential is present but deliberately unused', () => {
    const err = new InteractiveCredentialError('lazy pair', 'not reachable', 'CLAUDE_CODE_OAUTH_TOKEN');
    expect(err.message).toContain('CLAUDE_CODE_OAUTH_TOKEN is set, and is deliberately NOT used');
    expect(err.message).toContain('/login');
  });

  test('offers actionable remedies rather than just a diagnosis', () => {
    const err = new InteractiveCredentialError('lazy chat', 'not reachable', null);
    expect(err.message).toContain('lazy daemon status');
    expect(err.message).toContain('lazy daemon restart');
    expect(err.message).toContain('lazy doctor');
  });

  // Secrets hygiene: the message names the env var CARRYING a credential, never
  // its value. This class is constructed with a var NAME for exactly that reason
  // — the signature makes leaking a secret here impossible by construction.
  test('carries a variable name, never a credential value', () => {
    const err = new InteractiveCredentialError('lazy pair', 'not reachable', 'ANTHROPIC_API_KEY');
    expect(err.message).not.toContain('sk-');
  });
});
