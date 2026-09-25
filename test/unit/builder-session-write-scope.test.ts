/**
 * Every Storage-proxy method that WRITES a builder-session row is member-scoped.
 *
 * The read scoping (a member sees only their own builder sessions) was once
 * bypassable in one call: `updateBuilderSession` through the proxy accepted any
 * row and any patch key, so a member could rewrite another member's row onto
 * their own email and then read it. The write scoping is an allowlist beside
 * the dispatch, which means it fails OPEN for a method nobody added to it —
 * this test is what makes a new builder-session write fail closed instead.
 */

import { describe, test, expect } from 'bun:test';
import {
  STORAGE_METHODS,
  BUILDER_SESSION_MEMBER_SCOPED_METHODS,
  BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS,
} from '../../src/daemon/rpc-handlers';
import { READ_ONLY_STORAGE_METHODS } from '../../src/daemon/rpc-command-kinds';

describe('builder-session storage-proxy scoping covers every method', () => {
  // INVARIANT: every builder-session method on the storage proxy is scoped to
  // the caller's member in team mode — reads by BUILDER_SESSION_MEMBER_SCOPED_METHODS,
  // writes by BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS. An unscoped write
  // re-opens the cross-member bypass the read scoping depends on.
  test('every builder-session storage method is in the read or the write scope', () => {
    const sessionMethods = Object.keys(STORAGE_METHODS).filter(m => /BuilderSession/.test(m));
    expect(sessionMethods.length).toBeGreaterThan(0);
    const unscoped = sessionMethods.filter(m =>
      !BUILDER_SESSION_MEMBER_SCOPED_METHODS.has(m) && !BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS.has(m));
    expect(unscoped).toEqual([]);
  });

  test('the write scope holds only writes, and the read scope only reads', () => {
    for (const m of BUILDER_SESSION_MEMBER_SCOPED_WRITE_METHODS) {
      expect(m in STORAGE_METHODS).toBe(true);
      expect(READ_ONLY_STORAGE_METHODS.has(m)).toBe(false);
    }
    for (const m of BUILDER_SESSION_MEMBER_SCOPED_METHODS) {
      expect(READ_ONLY_STORAGE_METHODS.has(m)).toBe(true);
    }
  });
});
