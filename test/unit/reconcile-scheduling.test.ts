import { describe, test, expect, beforeEach } from 'bun:test';
import {
  signalPendingRequest,
  clearPendingRequest,
  hasPendingRequests,
} from '../../src/daemon/context';

// INVARIANT: HTTP requests take priority over the reconcile loop.
// The pending-request counter enables cooperative scheduling so the
// single-threaded event loop serves CLI/MCP requests promptly.

describe('daemon pending request signaling', () => {
  beforeEach(() => {
    // Drain any leftover state from other tests
    while (hasPendingRequests()) clearPendingRequest();
  });

  test('initially has no pending requests', () => {
    expect(hasPendingRequests()).toBe(false);
  });

  test('signalPendingRequest makes hasPendingRequests return true', () => {
    signalPendingRequest();
    expect(hasPendingRequests()).toBe(true);
    clearPendingRequest();
  });

  test('clearPendingRequest decrements the counter', () => {
    signalPendingRequest();
    signalPendingRequest();
    expect(hasPendingRequests()).toBe(true);

    clearPendingRequest();
    // Still one pending
    expect(hasPendingRequests()).toBe(true);

    clearPendingRequest();
    expect(hasPendingRequests()).toBe(false);
  });

  test('clearPendingRequest does not go below zero', () => {
    // Should not throw or go negative
    clearPendingRequest();
    clearPendingRequest();
    expect(hasPendingRequests()).toBe(false);

    // And a subsequent signal still works
    signalPendingRequest();
    expect(hasPendingRequests()).toBe(true);
    clearPendingRequest();
  });

  test('multiple concurrent requests are tracked independently', () => {
    // Simulate 3 concurrent HTTP requests arriving
    signalPendingRequest();
    signalPendingRequest();
    signalPendingRequest();
    expect(hasPendingRequests()).toBe(true);

    // First two complete
    clearPendingRequest();
    clearPendingRequest();
    expect(hasPendingRequests()).toBe(true);

    // Last one completes
    clearPendingRequest();
    expect(hasPendingRequests()).toBe(false);
  });
});
