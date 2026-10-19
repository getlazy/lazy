import { describe, test, expect } from 'bun:test';
import { parseInstallCloneArgs, isInstallCloneArgs, typedCloneUrl } from '../../src/cli/commands/login';
import { normalizeTeamsUrl } from '../../src/teams/login';
import { renderGitAuthInclude } from '../../src/teams/git-bearer';
import { redirectMessage, authProxyMessage } from '../../src/teams/auth-proxy';
import { pollDeviceToken, requestDeviceCode, fetchProjects, TeamsRequestError } from '../../src/teams/device-auth';
import { discoverLoginMode } from '../../src/teams/loopback-login';

describe('lazy clone argument parsing', () => {
  // INVARIANT: `lazy clone` has ONE repository form, a full clone URL; an address-looking argument that is not one
  // is a usage error, never the task form.
  test('parses one full clone URL, with optional dir', () => {
    expect(parseInstallCloneArgs(['https://r.example.dev/git/lazy-dev/token-watch.git']))
      .toEqual({ install: 'https://r.example.dev', project: 'lazy-dev/token-watch', dir: undefined });
    expect(parseInstallCloneArgs(['http://r.example.dev/git/a/b', 'd']))
      .toEqual({ install: 'http://r.example.dev', project: 'a/b', dir: 'd' });
    expect(parseInstallCloneArgs(['fix-login'])).toBeNull();
    expect(parseInstallCloneArgs(['fix-login', '--parent', 'other'])).toBeNull();
  });

  test('bad URLs and the retired <install> <team>/<project> pair are usage errors naming the URL form', () => {
    expect(() => parseInstallCloneArgs(['https://r.example.dev/nope'])).toThrow(/clone URL/);
    expect(() => parseInstallCloneArgs(['r.example.dev/git/x'])).toThrow(/clone URL/);
    expect(() => parseInstallCloneArgs(['https://r.example.dev/nope', 'dir'])).toThrow(/clone URL/);
    expect(() => parseInstallCloneArgs(['r.example.dev', 'acme/api'])).toThrow(/https:\/\/<install>\/git/);
    expect(() => parseInstallCloneArgs(['https://r.example.dev', 'acme/api'])).toThrow(/https:\/\/<install>\/git/);
    expect(isInstallCloneArgs(['r.example.dev', 'acme/api'])).toBe(true);
    expect(isInstallCloneArgs(['teams.example.com', 'api'])).toBe(false);
  });
});

describe('install origin', () => {
  // INVARIANT: the typed scheme is never changed and nothing probes the network; only a bare host gets https://.
  test('scheme is kept as typed', () => {
    expect(normalizeTeamsUrl('http://box:3000')).toBe('http://box:3000');
    expect(normalizeTeamsUrl('http://r.getlazy.dev')).toBe('http://r.getlazy.dev');
    expect(normalizeTeamsUrl('https://box')).toBe('https://box');
    expect(normalizeTeamsUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeTeamsUrl('r.getlazy.dev')).toBe('https://r.getlazy.dev');
  });
});

describe('stored clone address', () => {
  // INVARIANT: the clone host is always the typed origin; only the stored PATH is taken from the install, so it can never steer git to another host.
  test('typed origin plus stored path', () => {
    expect(typedCloneUrl(new URL('https://box/git/a/b.git'), 'https://box')).toBe('https://box/git/a/b.git');
    expect(typedCloneUrl(new URL('http://r.getlazy.dev/git/a/b.git'), 'http://localhost:3000')).toBe('http://localhost:3000/git/a/b.git');
    expect(typedCloneUrl(new URL('https://other:81/git/a/b.git'), 'https://box')).toBe('https://box/git/a/b.git');
  });
});

describe('git auth include', () => {
  // INVARIANT: the include carries the Bearer header for exactly the typed origin, never follows redirects, and rewrites nothing.
  test('no insteadOf for either scheme', () => {
    for (const url of ['https://box.example', 'http://box:3000']) {
      const inc = renderGitAuthInclude(url, 'tok');
      expect(inc).not.toContain('insteadOf');
      expect(inc).toContain(`[http "${url}/"]`);
      expect(inc).toContain('followRedirects = false');
    }
  });
});

describe('redirects', () => {
  // INVARIANT: a redirect is reported in one clear line naming where it went; the token is never sent along.
  test('names the destination', () => {
    const r = (loc: string) => new Response(null, { status: 302, headers: { location: loc } });
    expect(redirectMessage('http://r.getlazy.dev', r('https://r.getlazy.dev/'))).toBe(
      'http://r.getlazy.dev redirected to https://r.getlazy.dev — use that address.');
    expect(redirectMessage('http://r.getlazy.dev', r('https://accounts.google.com/o/oauth2'))).toContain('sign-in page at accounts.google.com');
    expect(redirectMessage('http://r.getlazy.dev', new Response('{}', { status: 200 }))).toBeNull();
  });
});

describe('discovery redirect', () => {
  // INVARIANT: discovery never follows a redirect; it stops and names where it went.
  test('discoverLoginMode reports a redirect', async () => {
    let init: RequestInit | undefined;
    const fetcher = (async (_u: string, i?: RequestInit) => {
      init = i;
      return new Response(null, { status: 301, headers: { location: 'https://box/' } });
    }) as unknown as typeof fetch;
    await expect(discoverLoginMode('http://box', fetcher)).rejects.toThrow('http://box redirected to https://box — use that address.');
    expect(init?.redirect).toBe('manual');
  });
});

describe('cross-host redirect', () => {
  // INVARIANT: a redirect to another host is a sign-in proxy, not a wrong address: name only its host, give the proxy-policy guidance, never print its URL.
  test('google-style sign-in redirect', () => {
    const loc = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=' + 'x'.repeat(500);
    const msg = redirectMessage('https://r.getlazy.dev', new Response(null, { status: 302, headers: { location: loc } }))!;
    expect(msg).toContain('accounts.google.com');
    expect(msg).toContain('authenticating proxy');
    expect(msg).toContain('verifies Teams');
    expect(msg).not.toContain("install's own address");
    expect(msg).not.toContain('?');
    expect(msg).not.toContain('client_id');
  });
});

describe('redirects on every Teams request', () => {
  const long = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=' + 'x'.repeat(3000);
  const redirecting = (async () => new Response(null, { status: 302, headers: { location: long } })) as unknown as typeof fetch;
  const expectProxyMessage = (err: unknown) => {
    const msg = (err as Error).message;
    expect(err).toBeInstanceOf(TeamsRequestError);
    expect(msg).toContain('accounts.google.com');
    expect(msg).toContain('authenticating proxy');
    expect(msg).not.toContain('?');
    expect(msg.length).toBeLessThan(800);
  };

  // INVARIANT: a redirect on the device-login poll ends the login with the proxy message (commandLogin prints a TeamsRequestError and exits); it never polls forever.
  test('poll, device-code start and project list report a cross-host redirect', async () => {
    for (const call of [
      () => pollDeviceToken('https://r.getlazy.dev', 'dc', redirecting),
      () => requestDeviceCode('https://r.getlazy.dev', 'laptop', redirecting),
      () => fetchProjects('https://r.getlazy.dev', 'tok', redirecting),
    ]) {
      let caught: unknown;
      try { await call(); } catch (err) { caught = err; }
      expectProxyMessage(caught);
    }
  });

  // INVARIANT: authProxyMessage prints only the host of the page it was sent on to, never the URL.
  test('authProxyMessage prints the host only', () => {
    const msg = authProxyMessage('https://r.getlazy.dev', {
      status: 200, redirected: true, finalUrl: long, contentType: 'text/html', body: '', headers: new Headers(),
    });
    expect(msg).toContain('sent on to accounts.google.com');
    expect(msg).not.toContain('?');
    expect(msg).not.toContain('/o/oauth2');
  });
});
