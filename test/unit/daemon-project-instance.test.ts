/**
 * Unit tests: the supervisor-seeded project instance id.
 *
 * A fleet supervisor has to be able to ask "is the daemon answering on this port
 * the one I started for this project?". `projectRoot` cannot answer it across a
 * VM boundary and the per-process `instanceId` answers a different question
 * ("did it restart") — see src/daemon/project-instance.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  PROJECT_INSTANCE_ENV,
  ProjectInstanceIdInvalidError,
  readProjectInstanceId,
} from '../../src/daemon/project-instance';

const read = (value?: string) =>
  readProjectInstanceId(value === undefined ? {} : { [PROJECT_INSTANCE_ENV]: value });

describe('readProjectInstanceId', () => {
  test('returns the seeded id verbatim', () => {
    expect(read('7f1c2f0e-2a6b-4a6f-9a2a-9d1d2f5b8e11'))
      .toBe('7f1c2f0e-2a6b-4a6f-9a2a-9d1d2f5b8e11');
  });

  test('trims incidental whitespace from the environment', () => {
    expect(read('  proj-abc12345  ')).toBe('proj-abc12345');
  });

  // INVARIANT: unset is the ordinary single-user case and must stay free. Only a
  // fleet supervisor seeds this; a daemon nobody supervises has no identity to
  // report and must start exactly as before.
  test('unset is not an error — it is "nobody is supervising this daemon"', () => {
    expect(read()).toBeUndefined();
  });

  // A shell exporting an unset variable produces an empty string. That is "unset"
  // spelled awkwardly, not a malformed id.
  test('empty and whitespace-only values are treated as unset', () => {
    expect(read('')).toBeUndefined();
    expect(read('   ')).toBeUndefined();
  });

  // INVARIANT: set-but-malformed FAILS LOUD, like readFleetValues. A supervisor
  // tried to seed an identity and got it wrong; carrying on would leave every
  // later identity check reporting "not my daemon" with nothing saying why.
  test('a malformed id throws rather than being ignored', () => {
    expect(() => read('short')).toThrow(ProjectInstanceIdInvalidError);
    expect(() => read('has spaces in it')).toThrow(ProjectInstanceIdInvalidError);
    expect(() => read('newline\ninjected-value')).toThrow(ProjectInstanceIdInvalidError);
    expect(() => read('x'.repeat(129))).toThrow(ProjectInstanceIdInvalidError);
  });

  test('the error names the variable and what a good value looks like', () => {
    try {
      read('nope');
      throw new Error('expected a throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(PROJECT_INSTANCE_ENV);
      expect(message).toContain('UUID');
    }
  });

  test('accepts the punctuation a supervisor is likely to use', () => {
    expect(read('lazy-fleet.project_42:0a1b2c3d')).toBe('lazy-fleet.project_42:0a1b2c3d');
  });
});
