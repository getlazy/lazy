import { describe, test, expect } from 'bun:test';
import {
  dashboardUrlFromStatus,
  dashboardAvailabilityFromStatus,
} from '../../src/daemon/dashboard-availability';
import { formatDashboardUrl } from '../../src/daemon/dashboard-url';

describe('dashboardUrlFromStatus', () => {
  // INVARIANT: a running daemon that sends dashboardUrl: null means the
  // dashboard is OFF (managed). Do not invent a URL from bindHost+webPort.
  test('explicit null wins over bindHost+webPort', () => {
    expect(dashboardUrlFromStatus({
      running: true,
      webPort: 26025,
      bindHost: '127.0.0.1',
      dashboardUrl: null,
    })).toBeNull();
  });

  test('a present URL is returned as-is', () => {
    expect(dashboardUrlFromStatus({
      running: true,
      webPort: 26025,
      bindHost: '127.0.0.1',
      dashboardUrl: 'http://lazy.localhost:26025',
    })).toBe('http://lazy.localhost:26025');
  });

  // INVARIANT: older daemons omit the field. Format from bindHost+webPort so
  // a missing field is not treated as "off".
  test('missing field falls back to formatting bindHost+webPort', () => {
    expect(dashboardUrlFromStatus({
      running: true,
      webPort: 26025,
      bindHost: '127.0.0.1',
    })).toBe(formatDashboardUrl('127.0.0.1', 26025));
  });

  test('a daemon that is not running yields null', () => {
    expect(dashboardUrlFromStatus({
      running: false,
      webPort: 26025,
      dashboardUrl: 'http://lazy.localhost:26025',
    })).toBeNull();
  });
});

describe('dashboardAvailabilityFromStatus', () => {
  test('classifies explicit null as off, not unreachable', () => {
    expect(dashboardAvailabilityFromStatus({
      running: true,
      webPort: 26025,
      dashboardUrl: null,
    })).toEqual({ available: false, reason: 'off' });
  });

  test('classifies a missing daemon as unreachable', () => {
    expect(dashboardAvailabilityFromStatus({ running: false })).toEqual({
      available: false,
      reason: 'unreachable',
    });
  });

  test('classifies a URL as available', () => {
    expect(dashboardAvailabilityFromStatus({
      running: true,
      dashboardUrl: 'http://lazy.localhost:26025',
    })).toEqual({ available: true, url: 'http://lazy.localhost:26025' });
  });
});
