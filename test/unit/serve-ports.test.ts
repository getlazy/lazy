import { describe, test, expect } from 'bun:test';
import {
  resolveServicePorts,
  buildPublishArgs,
  parsePortBindings,
  resolveServices,
  findService,
  urlForBinding,
  SERVE_BIND_HOST,
} from '../../src/serve/ports';

describe('resolveServicePorts', () => {
  test('no [serve] section resolves to an empty list', () => {
    expect(resolveServicePorts(undefined)).toEqual([]);
  });

  test('bare ports use the port as the service name', () => {
    expect(resolveServicePorts({ ports: [3000, 5173] })).toEqual([
      { name: '3000', port: 3000 },
      { name: '5173', port: 5173 },
    ]);
  });

  test('[serve.services] names the ports', () => {
    expect(resolveServicePorts({ services: { web: 3000, api: 8080 } })).toEqual([
      { name: 'web', port: 3000 },
      { name: 'api', port: 8080 },
    ]);
  });

  test('both spellings fill one list, in declaration order', () => {
    expect(resolveServicePorts({ ports: [5173], services: { api: 8080 } })).toEqual([
      { name: '5173', port: 5173 },
      { name: 'api', port: 8080 },
    ]);
  });

  // INVARIANT: a malformed [serve] fails loud at config load. The alternative is
  // a task that starts with nothing published and no explanation for why
  // `lazy url` is empty — a silent default here is a debugging trap.
  test('rejects a non-array ports value', () => {
    expect(() => resolveServicePorts({ ports: 3000 })).toThrow(/must be an array/);
  });

  test('rejects a non-integer port', () => {
    expect(() => resolveServicePorts({ ports: ['3000'] })).toThrow(/must be an integer/);
    expect(() => resolveServicePorts({ ports: [3000.5] })).toThrow(/must be an integer/);
  });

  test('rejects an out-of-range port', () => {
    expect(() => resolveServicePorts({ ports: [0] })).toThrow(/out of range/);
    expect(() => resolveServicePorts({ ports: [70000] })).toThrow(/out of range/);
  });

  test('rejects a services value that is not a table', () => {
    expect(() => resolveServicePorts({ services: [3000] })).toThrow(/table of name = port/);
  });

  // INVARIANT: `lazy url <task> <name-or-port>` takes a name OR a port in one
  // argument, so an all-digit name would be ambiguous. Names start with a letter.
  test('rejects a service name that could be mistaken for a port', () => {
    expect(() => resolveServicePorts({ services: { '3000': 3000 } })).toThrow(/invalid service name/);
    expect(() => resolveServicePorts({ services: { 'has space': 3000 } })).toThrow(/invalid service name/);
  });

  test('rejects a duplicate port and names the prior owner', () => {
    expect(() => resolveServicePorts({ ports: [3000], services: { web: 3000 } })).toThrow(
      /declared twice \(already declared as "3000"\)/,
    );
  });
});

describe('buildPublishArgs', () => {
  // INVARIANT: a project with no [serve] must produce byte-identical launch argv
  // to before this feature existed.
  test('is empty with no declared services', () => {
    expect(buildPublishArgs([])).toEqual([]);
  });

  test('publishes each port to an ephemeral loopback host port', () => {
    expect(buildPublishArgs([{ name: 'web', port: 3000 }, { name: 'vite', port: 5173 }])).toEqual([
      '-p', `${SERVE_BIND_HOST}:0:3000`,
      '-p', `${SERVE_BIND_HOST}:0:5173`,
    ]);
  });

  test('never binds off-loopback', () => {
    expect(buildPublishArgs([{ name: 'web', port: 3000 }]).join(' ')).not.toContain('0.0.0.0');
  });

  test('two names for one port are one binding', () => {
    expect(buildPublishArgs([{ name: 'a', port: 3000 }, { name: 'b', port: 3000 }])).toEqual([
      '-p', `${SERVE_BIND_HOST}:0:3000`,
    ]);
  });
});

describe('parsePortBindings', () => {
  test('parses docker port output', () => {
    const out = '3000/tcp -> 127.0.0.1:49154\n5173/tcp -> 127.0.0.1:49155\n';
    expect(parsePortBindings(out)).toEqual([
      { containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 },
      { containerPort: 5173, hostAddress: '127.0.0.1', hostPort: 49155 },
    ]);
  });

  test('skips udp and unparsable lines rather than throwing', () => {
    const out = '3000/udp -> 127.0.0.1:49154\nnot a mapping\n\n8080/tcp -> 127.0.0.1:49160';
    expect(parsePortBindings(out)).toEqual([
      { containerPort: 8080, hostAddress: '127.0.0.1', hostPort: 49160 },
    ]);
  });

  test('parses an IPv6 host address', () => {
    expect(parsePortBindings('3000/tcp -> ::1:49154')).toEqual([
      { containerPort: 3000, hostAddress: '::1', hostPort: 49154 },
    ]);
  });

  test('empty output yields no bindings', () => {
    expect(parsePortBindings('')).toEqual([]);
  });
});

describe('urlForBinding', () => {
  test('builds a loopback URL', () => {
    expect(urlForBinding({ containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 }))
      .toBe('http://127.0.0.1:49154');
  });

  test('brackets an IPv6 host', () => {
    expect(urlForBinding({ containerPort: 3000, hostAddress: '::1', hostPort: 49154 }))
      .toBe('http://[::1]:49154');
  });
});

describe('resolveServices', () => {
  const declared = [{ name: 'web', port: 3000 }, { name: 'api', port: 8080 }];

  test('joins declared services with live bindings in declaration order', () => {
    const resolved = resolveServices(declared, [
      { containerPort: 8080, hostAddress: '127.0.0.1', hostPort: 49160 },
      { containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 },
    ]);
    expect(resolved.map(s => s.name)).toEqual(['web', 'api']);
    expect(resolved[0].url).toBe('http://127.0.0.1:49154');
    expect(resolved[1].url).toBe('http://127.0.0.1:49160');
  });

  // A container created before a port was declared does not publish it. That is
  // a real, reachable state (published ports are fixed at create time), so it
  // must resolve to "declared but unpublished", not to an error.
  test('a declared port with no binding resolves to a null url', () => {
    const resolved = resolveServices(declared, [
      { containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 },
    ]);
    expect(resolved[1].binding).toBeNull();
    expect(resolved[1].url).toBeNull();
  });
});

describe('findService', () => {
  const resolved = resolveServices(
    [{ name: 'web', port: 3000 }, { name: '5173', port: 5173 }],
    [{ containerPort: 3000, hostAddress: '127.0.0.1', hostPort: 49154 }],
  );

  test('finds by name, case-insensitively', () => {
    expect(findService(resolved, 'web')?.port).toBe(3000);
    expect(findService(resolved, 'WEB')?.port).toBe(3000);
  });

  test('finds by container port', () => {
    expect(findService(resolved, '3000')?.name).toBe('web');
    expect(findService(resolved, '5173')?.port).toBe(5173);
  });

  test('returns null for an unknown query', () => {
    expect(findService(resolved, 'nope')).toBeNull();
    expect(findService(resolved, '9999')).toBeNull();
  });
});
