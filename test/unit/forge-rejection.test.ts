import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { classifyForgeRefusal, forgeRefusalFix, isTransportFailure } from '../../src/remote/forge-rejection';
import { withRemoteRetry, RemoteRefusedError } from '../../src/utils/retry';

const fixture = (name: string) => readFile(join(import.meta.dir, '../fixtures/forge-refusals', name), 'utf-8');

describe('forge refusals', () => {
  test('a token without workflow scope names the scope and the workflow file', async () => {
    const r = classifyForgeRefusal(await fixture('workflow-scope.txt'));
    expect(r).toMatchObject({ kind: 'workflow_scope', workflowFile: '.github/workflows/ci.yml' });
    expect(forgeRefusalFix(r!)).toContain('`workflow` scope');
    expect(forgeRefusalFix(r!)).toContain('Workflows: Read and write');
  });

  test('SAML SSO names the organization and carries GitHub\'s authorization URL', async () => {
    const r = classifyForgeRefusal(await fixture('saml-sso.txt'));
    expect(r).toMatchObject({ kind: 'sso_required', org: 'acme' });
    expect(r!.ssoUrl).toBe('https://github.com/orgs/acme/sso?authorization_request=AB12CD');
    expect(forgeRefusalFix(r!)).toContain("the acme organization's SSO");
  });

  test('protected branch, 403 and 401', () => {
    expect(classifyForgeRefusal('remote: error: GH006: Protected branch update failed for refs/heads/main.')?.kind).toBe('protected_branch');
    expect(classifyForgeRefusal("remote: Permission to acme/app.git denied to octo.\nfatal: ... error: 403")?.kind).toBe('forbidden');
    expect(classifyForgeRefusal('remote: Invalid username or password.\nfatal: Authentication failed for')?.kind).toBe('unauthorized');
  });

  // INVARIANT: git asking for a username it cannot prompt for means NO
  // credential was offered — not a refused one. Telling the reader to
  // "reconnect with a fresh token" sends them after a token that does not exist.
  test('a missing credential is its own kind, with the connect-an-account fix', async () => {
    for (const [name, forge, label] of [
      ['no-credential-prompts-disabled.txt', 'github', 'GitHub'],
      ['no-credential-no-tty.txt', 'gitlab', 'GitLab'],
    ] as const) {
      const r = classifyForgeRefusal(await fixture(name));
      expect(r).toEqual({ kind: 'missing_credential' });
      const fix = forgeRefusalFix(r!, forge);
      expect(fix).toContain(`Connect your ${label} account`);
      expect(fix).not.toContain('fresh token');
    }
  });

  test('transport failures are not refusals', () => {
    const text = "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com";
    expect(isTransportFailure(text)).toBe(true);
  });
});

describe('withRemoteRetry and refusals', () => {
  // INVARIANT: a server-side refusal is final — never retried, never worded as
  // a network problem. The engineer's real case: a PAT without `workflow`
  // scope was retried 3 times and reported as "Check your network connection
  // … --offline-override" (2026-10-20).
  test('a [remote rejected] push fails at once with the fix, no network hint', async () => {
    const stderr = await fixture('workflow-scope.txt');
    let attempts = 0;
    const err = await withRemoteRetry(
      async () => { attempts++; throw new Error(`Failed to push branch x: ${stderr}`); },
      'push x to origin',
      { maxAttempts: 3, backoffMs: [10, 20] },
    ).catch((e) => e);
    expect(attempts).toBe(1);
    expect(err).toBeInstanceOf(RemoteRefusedError);
    expect(err.message).toContain('refusing to allow a Personal Access Token');
    expect(err.message).toContain('`workflow` scope');
    expect(err.message).not.toContain('Check your network connection');
    expect(err.message).not.toContain('--offline-override');
  });

  test('a transport failure is still retried', async () => {
    let attempts = 0;
    await withRemoteRetry(
      async () => { attempts++; throw new Error('Could not resolve host: github.com (403 in a URL is not a refusal here)'); },
      'push x', { maxAttempts: 2, backoffMs: [10] },
    ).catch(() => undefined);
    expect(attempts).toBe(2);
  });
});

describe('withRemoteRetry: transport failures keep their retries', () => {
  // INVARIANT: only a server-side REFUSAL is final. A transport failure — a
  // reset connection, a timeout, DNS, a gateway 5xx — or an error lazy does not
  // recognise is retried exactly as before (AGENTS.md "Fail hard on remote
  // failures"); narrowing must never turn a flaky network into a hard stop.
  const transport = [
    "fatal: unable to access 'https://github.com/a/b.git/': Recv failure: Connection reset by peer",
    "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 21000 ms: Operation timed out",
    'error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly\nfatal: the remote end hung up unexpectedly',
    "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 502",
    "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
  ];
  for (const text of transport) {
    test(`retried: ${text.split('\n')[0].slice(0, 60)}`, async () => {
      expect(classifyForgeRefusal(text)).toBeNull();
      let attempts = 0;
      const err = await withRemoteRetry(
        async () => { attempts++; throw new Error(text); },
        'push x', { maxAttempts: 3, backoffMs: [1, 1] },
      ).catch((e) => e);
      expect(attempts).toBe(3);
      expect(err).not.toBeInstanceOf(RemoteRefusedError);
      expect(err.message).toContain('Check your network connection');
    });
  }

  test('an unrecognised failure is retried, with no network guess', async () => {
    let attempts = 0;
    const err = await withRemoteRetry(
      async () => { attempts++; throw new Error('error: something nobody has seen before'); },
      'push x', { maxAttempts: 3, backoffMs: [1, 1] },
    ).catch((e) => e);
    expect(attempts).toBe(3);
    expect(err.message).toContain('failed after 3 attempts');
    expect(err.message).not.toContain('Check your network connection');
  });

  test('numbers that are not HTTP statuses are not refusals', () => {
    expect(classifyForgeRefusal('Writing objects: 100% (403/403), 41.4 KiB | 401 KiB/s, done.')).toBeNull();
    expect(classifyForgeRefusal('Total 404 (delta 12), reused 0')).toBeNull();
  });

  test('git\'s "RPC failed; HTTP 403" is a refusal, not transport', () => {
    expect(classifyForgeRefusal('error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403')?.kind).toBe('forbidden');
  });
});

describe('SSO and rate limits are not over-matched', () => {
  // INVARIANT: SSO is recognised only in GitHub's own phrasings. A repository
  // or branch NAMED after sso/saml must not turn a transport error into a
  // final "authorize your token for SSO", nor a plain 403 into the wrong fix.
  test('an sso- or saml-named repository or branch with a transport error keeps its retries', async () => {
    const text = "fatal: unable to access 'https://github.com/acme/sso-gateway.git/': Recv failure: Connection reset by peer\n" +
      "error: failed to push some refs to 'lazy/saml-login-fix'";
    expect(classifyForgeRefusal(text)).toBeNull();
    let attempts = 0;
    await withRemoteRetry(async () => { attempts++; throw new Error(text); }, 'push x', { maxAttempts: 3, backoffMs: [1, 1] })
      .catch(() => undefined);
    expect(attempts).toBe(3);
  });

  test('an sso-named repository with a plain 403 is a permission refusal, not SSO', () => {
    const text = "remote: Permission to acme/sso-gateway.git denied to octo.\nfatal: unable to access 'https://github.com/acme/sso-gateway.git/': The requested URL returned error: 403";
    expect(classifyForgeRefusal(text)?.kind).toBe('forbidden');
  });

  test("the API's SAML enforcement message is SSO", () => {
    expect(classifyForgeRefusal('Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.')?.kind)
      .toBe('sso_required');
  });

  // INVARIANT: GitHub's rate-limit 403s are throttling, not refusal — they
  // clear by themselves, so they keep their retries.
  test('rate-limit 403s are retried, not final', async () => {
    for (const text of [
      'remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\nfatal: unable to access: The requested URL returned error: 403',
      'API rate limit exceeded for user ID 1234. (HTTP 403)',
    ]) {
      expect(classifyForgeRefusal(text)).toBeNull();
      let attempts = 0;
      const err = await withRemoteRetry(async () => { attempts++; throw new Error(text); }, 'push x', { maxAttempts: 3, backoffMs: [1, 1] })
        .catch((e) => e);
      expect(attempts).toBe(3);
      expect(err).not.toBeInstanceOf(RemoteRefusedError);
    }
  });
});
