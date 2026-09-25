import { describe, test, expect, afterEach } from 'bun:test';
import {
  MAX_HOST_LABEL_LENGTH,
  isHostLabel,
  parseServeHost,
  serviceHostLabel,
  serviceSubdomainUrl,
  setDashboardAuthority,
  dashboardAuthority,
  taskHostLabel,
  withPublicUrls,
  displayUrlFor,
} from '../../src/serve/subdomain';
import type { ResolvedService } from '../../src/serve/ports';

/**
 * `<service>.<task>.lazy.localhost` — the naming layer over a task's published
 * ports (src/serve/subdomain.ts). `parseServeHost` is the predicate that decides
 * whether a request leaves the daemon for a container, so most of what is pinned
 * here is what it must REFUSE.
 */
describe('isHostLabel', () => {
  test('accepts ordinary codes and service names', () => {
    expect(isHostLabel('web')).toBe(true);
    expect(isHostLabel('my-task')).toBe(true);
    expect(isHostLabel('a')).toBe(true);
  });

  // A bare `[serve] ports = [3000]` entry is named by its port, so `3000.<task>`
  // has to be addressable. RFC 1123 allows a leading digit and browsers accept it.
  test('accepts an all-digit label', () => {
    expect(isHostLabel('3000')).toBe(true);
  });

  test('rejects what cannot stand as one DNS label', () => {
    expect(isHostLabel('')).toBe(false);
    expect(isHostLabel('has.dot')).toBe(false);
    expect(isHostLabel('under_score')).toBe(false);
    expect(isHostLabel('-leading')).toBe(false);
    expect(isHostLabel('trailing-')).toBe(false);
    expect(isHostLabel('UPPER')).toBe(false);
  });

  test('rejects a label past the DNS length limit', () => {
    expect(isHostLabel('a'.repeat(MAX_HOST_LABEL_LENGTH))).toBe(true);
    expect(isHostLabel('a'.repeat(MAX_HOST_LABEL_LENGTH + 1))).toBe(false);
  });
});

describe('taskHostLabel', () => {
  test('uses the code when it is a valid label', () => {
    expect(taskHostLabel({ id: 'abcdef1234', code: 'my-task' })).toBe('my-task');
  });

  // INVARIANT: existing dotted codes are never renamed or migrated. A dot in the
  // code would split into extra labels and address a task that does not exist,
  // so such a task is reachable by its short id instead — and every URL surface
  // prints that form for it.
  test('falls back to the short id for a code that is not a label', () => {
    expect(taskHostLabel({ id: 'abcdef1234567890', code: 'release.v0.5' })).toBe('abcdef12');
    expect(taskHostLabel({ id: 'abcdef1234567890', code: 'has_underscore' })).toBe('abcdef12');
    expect(taskHostLabel({ id: 'abcdef1234567890', code: null })).toBe('abcdef12');
    expect(taskHostLabel({ id: 'abcdef1234567890' })).toBe('abcdef12');
  });
});

describe('serviceHostLabel', () => {
  test('uses the service name when it is a valid label', () => {
    expect(serviceHostLabel({ name: 'web', port: 3000 })).toBe('web');
  });

  // `[serve.services]` names may contain `_` and uppercase, neither of which
  // belongs in a hostname. The port is always a valid label and `findService`
  // accepts it, so it is the fallback rather than mangling the human's name.
  test('falls back to the port for a name that is not a label', () => {
    expect(serviceHostLabel({ name: 'web_app', port: 3000 })).toBe('3000');
  });

  test('lowercases a name that is otherwise a valid label', () => {
    expect(serviceHostLabel({ name: 'Web', port: 3000 })).toBe('web');
  });
});

describe('parseServeHost', () => {
  const SUFFIX = 'lazy.localhost';

  test('splits a service and a task out of the host', () => {
    expect(parseServeHost('web.my-task.lazy.localhost', SUFFIX)).toEqual({
      service: 'web',
      task: 'my-task',
    });
  });

  test('ignores the port', () => {
    expect(parseServeHost('web.my-task.lazy.localhost:26024', SUFFIX)).toEqual({
      service: 'web',
      task: 'my-task',
    });
  });

  test('takes a port label as the service', () => {
    expect(parseServeHost('3000.my-task.lazy.localhost:26024', SUFFIX)).toEqual({
      service: '3000',
      task: 'my-task',
    });
  });

  test('takes a short id as the task', () => {
    expect(parseServeHost('web.abcdef12.lazy.localhost', SUFFIX)).toEqual({
      service: 'web',
      task: 'abcdef12',
    });
  });

  test('is case-insensitive, as hostnames are', () => {
    expect(parseServeHost('WEB.My-Task.Lazy.LocalHost', SUFFIX)).toEqual({
      service: 'web',
      task: 'my-task',
    });
  });

  // INVARIANT: everything the dashboard itself must keep serving resolves to
  // null here, because this predicate runs FIRST in the daemon's request chain —
  // a false positive would send the dashboard's own routes into a container.
  test('leaves the dashboard host itself alone', () => {
    expect(parseServeHost('lazy.localhost', SUFFIX)).toBeNull();
    expect(parseServeHost('lazy.localhost:26024', SUFFIX)).toBeNull();
    expect(parseServeHost('127.0.0.1:26024', SUFFIX)).toBeNull();
    expect(parseServeHost('[::1]:26024', SUFFIX)).toBeNull();
    expect(parseServeHost(null, SUFFIX)).toBeNull();
    expect(parseServeHost('', SUFFIX)).toBeNull();
  });

  test('ignores a foreign suffix', () => {
    expect(parseServeHost('web.my-task.example.com', SUFFIX)).toBeNull();
    // A suffix that only ENDS the same is not the same: `evillazy.localhost`
    // must not be read as a subdomain of `lazy.localhost`.
    expect(parseServeHost('web.my-task.evillazy.localhost', SUFFIX)).toBeNull();
  });

  // Strict about the shape: exactly two labels in front of the suffix. One is
  // the dashboard's own namespace, three is ambiguous, and neither is something
  // to guess about when the answer decides whether a request leaves the daemon.
  test('requires exactly two labels before the suffix', () => {
    expect(parseServeHost('my-task.lazy.localhost', SUFFIX)).toBeNull();
    expect(parseServeHost('a.web.my-task.lazy.localhost', SUFFIX)).toBeNull();
  });

  test('rejects labels that are not valid labels', () => {
    expect(parseServeHost('web.my_task.lazy.localhost', SUFFIX)).toBeNull();
    expect(parseServeHost('web..lazy.localhost', SUFFIX)).toBeNull();
    expect(parseServeHost('-web.my-task.lazy.localhost', SUFFIX)).toBeNull();
  });

  // The suffix is a PARAMETER, never a literal: Teams will serve these names
  // under a different one.
  test('follows the suffix it is given', () => {
    expect(parseServeHost('web.my-task.lazy.example.dev', 'lazy.example.dev')).toEqual({
      service: 'web',
      task: 'my-task',
    });
    expect(parseServeHost('web.my-task.lazy.localhost', 'lazy.example.dev')).toBeNull();
  });
});

describe('serviceSubdomainUrl', () => {
  test('composes host and authority, with no trailing slash', () => {
    expect(serviceSubdomainUrl('web', 'my-task', 'lazy.localhost:26024')).toBe(
      'http://web.my-task.lazy.localhost:26024',
    );
  });

  test('round-trips through parseServeHost', () => {
    const url = new URL(serviceSubdomainUrl('3000', 'abcdef12', 'lazy.localhost:26024'));
    expect(parseServeHost(url.host, 'lazy.localhost')).toEqual({
      service: '3000',
      task: 'abcdef12',
    });
  });
});

describe('withPublicUrls', () => {
  const task = { id: 'abcdef1234567890', code: 'my-task' };
  const service = (over: Partial<ResolvedService> = {}): ResolvedService => ({
    name: 'web',
    port: 3000,
    binding: { containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 },
    url: 'http://127.0.0.1:49154',
    ...over,
  });

  test('decorates a published service with its name', () => {
    const [decorated] = withPublicUrls(task, [service()], 'lazy.localhost:26024');
    expect(decorated!.publicUrl).toBe('http://web.my-task.lazy.localhost:26024');
    // The raw mapping is kept: `lazy url --direct`, curl and lazy-teams need it.
    expect(decorated!.url).toBe('http://127.0.0.1:49154');
  });

  // INVARIANT: publicUrl is null exactly when url is. An unpublished port has no
  // container-side listener for the proxy to reach either, so a name that could
  // only ever 502 is a worse answer than the "not published" already shown.
  test('leaves an unpublished service without a name', () => {
    const [decorated] = withPublicUrls(task, [service({ binding: null, url: null })], 'lazy.localhost:26024');
    expect(decorated!.publicUrl).toBeNull();
  });

  test('addresses a dotted-code task by short id', () => {
    const [decorated] = withPublicUrls(
      { id: 'abcdef1234567890', code: 'release.v0.5' },
      [service()],
      'lazy.localhost:26024',
    );
    expect(decorated!.publicUrl).toBe('http://web.abcdef12.lazy.localhost:26024');
  });

  // Null authority is a supported state, not a failure: a process that does not
  // know where the dashboard answers (no daemon reachable) still prints the
  // direct URL, which is what it printed before subdomains existed.
  test('leaves services untouched when there is no authority', () => {
    const services = [service()];
    expect(withPublicUrls(task, services, null)).toBe(services);
  });
});

describe('dashboardAuthority', () => {
  afterEach(() => setDashboardAuthority(null));

  test('round-trips, and treats blank as unset', () => {
    setDashboardAuthority('lazy.localhost:26024');
    expect(dashboardAuthority()).toBe('lazy.localhost:26024');
    setDashboardAuthority('   ');
    expect(dashboardAuthority()).toBeNull();
    setDashboardAuthority(null);
    expect(dashboardAuthority()).toBeNull();
  });
});

describe('displayUrlFor', () => {
  test('prefers the name and falls back to the raw mapping', () => {
    expect(displayUrlFor({
      name: 'web', port: 3000, binding: null,
      url: 'http://127.0.0.1:49154',
      publicUrl: 'http://web.my-task.lazy.localhost:26024',
    })).toBe('http://web.my-task.lazy.localhost:26024');

    expect(displayUrlFor({
      name: 'web', port: 3000, binding: null, url: 'http://127.0.0.1:49154',
    })).toBe('http://127.0.0.1:49154');

    expect(displayUrlFor({ name: 'web', port: 3000, binding: null, url: null })).toBeNull();
  });
});
