/**
 * Unit tests for the :taskId path-segment guard on POST /mcp/:taskId/:toolName.
 *
 * The e2e counterpart (test/e2e/mcp-route-status.test.ts) proves the route
 * answers 400 for a malformed segment. This file pins the other half: every
 * shape a real task reference can take must still pass through to resolution,
 * so the guard can never regress into rejecting legitimate calls.
 */

import { describe, test, expect } from 'bun:test';
import { validateMcpTaskSegment, httpStatusForError } from '../../src/daemon/mcp-routes';
import { RpcError } from '../../src/daemon/rpc-handlers';
import { RpcApplicationError } from '../../src/daemon/client';

describe('validateMcpTaskSegment', () => {
  // INVARIANT: every shape the CLI and MCP accept as a task reference reaches
  // task resolution untouched. `_` is the builder/project-wide segment.
  test('accepts the builder segment, task ids, short ids and codes', () => {
    const valid = [
      '_',
      '3f2b1c8e-9a4d-4c7e-8f10-2b6d5a1c0e77', // full UUID task id
      '3f2b1c8e',                              // short id
      'fix-mcp-route-status',                  // code
      'release.v0.20',                         // code with dots
      'a1',                                    // shortest plausible code
    ];
    for (const segment of valid) {
      expect(validateMcpTaskSegment(segment, 'a'.repeat(64))).toBeNull();
    }
  });

  test('rejects the daemon token by exact match, naming the mistake', () => {
    const token = 'b'.repeat(64);
    const err = validateMcpTaskSegment(token, token);
    expect(err).toContain('daemon auth token');
    expect(err).toContain('Authorization');
  });

  test('rejects a token-shaped segment even when it is not this daemon token', () => {
    expect(validateMcpTaskSegment('c'.repeat(64), 'd'.repeat(64))).toContain('daemon auth token');
  });

  test('rejects characters a task id or code can never contain', () => {
    for (const segment of ['not a task id!', 'foo/bar', '../etc/passwd', '-leading-dash', '']) {
      expect(validateMcpTaskSegment(segment, undefined)).toContain('Invalid :taskId path segment');
    }
  });

  test('rejects a segment longer than the maximum task code length', () => {
    expect(validateMcpTaskSegment('z'.repeat(81), undefined)).toContain('exceeds the 80-character maximum');
  });
});

describe('httpStatusForError', () => {
  // INVARIANT: a status carried by the error survives to the HTTP response.
  // Flattening a 400 to 500 makes an argument mistake read as a daemon crash.
  test('preserves RpcError and RpcApplicationError statuses', () => {
    expect(httpStatusForError(new RpcError(400, 'taskId is required'))).toBe(400);
    expect(httpStatusForError(new RpcError(404, 'Task not found'))).toBe(404);
    expect(httpStatusForError(new RpcApplicationError(409, 'conflict'))).toBe(409);
  });

  test('falls back to 500 only for errors that carry no status', () => {
    expect(httpStatusForError(new Error('boom'))).toBe(500);
    expect(httpStatusForError('boom')).toBe(500);
  });
});
