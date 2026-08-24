/**
 * JIT credential injection: minting placeholders, resolving them back, and
 * swapping in the real credential at the last hop.
 *
 * INVARIANT (the whole point of this machinery): a launched process holds a
 * PLACEHOLDER, never the human's real credential. Every test that asserts an
 * absence here is load-bearing — a regression that puts the real value back in
 * a container's environment would otherwise pass every other suite.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, stat, rm } from 'fs/promises';
import {
  mintCredentialGrant,
  lookupCredentialGrant,
  revokeTaskCredentialGrants,
  revokeBuilderCredentialGrant,
  clearCredentialGrantCache,
  looksLikeLazyPlaceholder,
  MAX_BUILDER_GRANTS,
} from '../../src/proxy/credential-broker';
import { placeholderizeAuthEnv } from '../../src/proxy/placeholder-env';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import {
  collectPresentedCredentials,
  applyCredential,
  stripPresentedCredential,
} from '../../src/proxy/inject';
import { getProxyTokensPath } from '../../src/daemon/paths';
import { makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const ROOT = '/tmp/jit-credentials-project';
const REAL = 'sk-ant-oat01-REAL-USER-SECRET';

describe('credential broker', () => {
  let undo: () => void;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    undo = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
  });

  afterEach(async () => {
    undo();
    clearCredentialGrantCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  test('a minted placeholder resolves back to the identity it was minted for', async () => {
    const token = await mintCredentialGrant(ROOT, {
      role: 'agent',
      taskId: 'task-1',
      label: 'lazy-task-1',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
    const grant = await lookupCredentialGrant(ROOT, token);
    expect(grant?.role).toBe('agent');
    expect(grant?.taskId).toBe('task-1');
    expect(grant?.envKey).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('the placeholder mimics the real credential shape for its env var', async () => {
    const oat = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'CLAUDE_CODE_OAUTH_TOKEN' });
    const api = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'ANTHROPIC_API_KEY' });
    const cur = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'CURSOR_API_KEY' });
    // Clients validate the format of the key they were given; a generic dummy
    // would be rejected before a single request reached the proxy.
    expect(oat.startsWith('sk-ant-oat01-')).toBe(true);
    expect(api.startsWith('sk-ant-api03-')).toBe(true);
    expect(cur.startsWith('key_')).toBe(true);
    // Distinct per env var: one launch can hold two at once.
    expect(new Set([oat, api, cur]).size).toBe(3);
  });

  // INVARIANT: minting is per-identity and REUSES. A live container holds its
  // placeholder in memory across turns; a fresh value per turn would either
  // invalidate a running turn or pile up equally-valid placeholders.
  test('the same identity gets the same placeholder back', async () => {
    const a = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't1', label: 'x', envKey: 'ANTHROPIC_API_KEY' });
    const b = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't1', label: 'different-label', envKey: 'ANTHROPIC_API_KEY' });
    expect(b).toBe(a);
  });

  test('an unknown value resolves to null rather than to some grant', async () => {
    await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'ANTHROPIC_API_KEY' });
    expect(await lookupCredentialGrant(ROOT, 'sk-ant-api03-lazy-forged')).toBeNull();
    expect(await lookupCredentialGrant(ROOT, null)).toBeNull();
  });

  // INVARIANT: the task's placeholder dies with its session. After accept /
  // reject / close the container must not be able to spend the human's
  // credential, even if it is still running.
  test('revoking a task kills its placeholders and only its own', async () => {
    const mine = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 'gone', label: 'l', envKey: 'ANTHROPIC_API_KEY' });
    const alsoMine = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 'gone', label: 'l', envKey: 'CURSOR_API_KEY' });
    const other = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 'stays', label: 'l', envKey: 'ANTHROPIC_API_KEY' });

    expect(await revokeTaskCredentialGrants(ROOT, 'gone')).toBe(2);
    expect(await lookupCredentialGrant(ROOT, mine)).toBeNull();
    expect(await lookupCredentialGrant(ROOT, alsoMine)).toBeNull();
    expect(await lookupCredentialGrant(ROOT, other)).not.toBeNull();
    // Idempotent: a second accept-path call must not throw.
    expect(await revokeTaskCredentialGrants(ROOT, 'gone')).toBe(0);
  });

  test('revoking a builder session kills the grants under its label', async () => {
    const token = await mintCredentialGrant(ROOT, { role: 'builder', label: 'builder-abc', envKey: 'ANTHROPIC_API_KEY' });
    expect(await revokeBuilderCredentialGrant(ROOT, 'builder-abc')).toBe(1);
    expect(await lookupCredentialGrant(ROOT, token)).toBeNull();
  });

  // A builder session has no lifecycle event to hang revocation on, so its
  // grants are bounded by a cap instead — and the grant just minted is the one
  // session we know is live, so it is never the one evicted.
  test('the builder cap evicts the oldest, never the one just minted', async () => {
    for (let i = 0; i <= MAX_BUILDER_GRANTS; i++) {
      await mintCredentialGrant(ROOT, { role: 'builder', label: `builder-${i}`, envKey: 'ANTHROPIC_API_KEY' });
    }
    const newest = await lookupCredentialGrant(ROOT, await mintCredentialGrant(ROOT, {
      role: 'builder', label: `builder-${MAX_BUILDER_GRANTS}`, envKey: 'ANTHROPIC_API_KEY',
    }));
    expect(newest).not.toBeNull();
    const registry = JSON.parse(await readFile(getProxyTokensPath(ROOT), 'utf8'));
    expect(registry.grants.filter((g: { role: string }) => g.role === 'builder').length)
      .toBeLessThanOrEqual(MAX_BUILDER_GRANTS);
  });

  // The registry is a bearer credential for this project's proxy — same posture
  // as the daemon token and the MCP token registry, and never under the project
  // root, which every task container bind-mounts.
  test('the registry is written 0600 in the daemon state dir', async () => {
    await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'ANTHROPIC_API_KEY' });
    const path = getProxyTokensPath(ROOT);
    expect(path.startsWith(baseDir)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('a placeholder survives a daemon restart (cold cache re-reads the file)', async () => {
    const token = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'ANTHROPIC_API_KEY' });
    clearCredentialGrantCache();
    expect((await lookupCredentialGrant(ROOT, token))?.taskId).toBe('t');
  });

  // Shape is used for ONE decision only: whether a lookup failure deserves a
  // 401 or a pass-through. It never authorises anything.
  test('looksLikeLazyPlaceholder recognises minted shapes and not real ones', async () => {
    const token = await mintCredentialGrant(ROOT, { role: 'agent', taskId: 't', label: 'l', envKey: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(looksLikeLazyPlaceholder(token)).toBe(true);
    expect(looksLikeLazyPlaceholder(REAL)).toBe(false);
  });
});

describe('placeholderizeAuthEnv', () => {
  let undo: () => void;
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    undo = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
  });

  afterEach(async () => {
    undo();
    clearCredentialGrantCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  // INVARIANT: no container holds a real credential. This is the assertion that
  // fails if a launch path ever regresses to passing the real value through.
  test('swaps credential values, keeps the keys, and leaves the rest alone', async () => {
    const out = await placeholderizeAuthEnv(
      ROOT,
      [
        { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: REAL },
        { key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8766' },
      ],
      { role: 'agent', taskId: 'task-9', label: 'lazy-task-9' },
    );

    // The key must survive: the client picks its auth wire shape from WHICH
    // variable is set, so swapping the key would change the request shape.
    expect(out.map((v) => v.key)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
    expect(out.find((v) => v.key === 'ANTHROPIC_BASE_URL')!.value).toBe('http://127.0.0.1:8766');
    expect(JSON.stringify(out)).not.toContain(REAL);

    const grant = await lookupCredentialGrant(ROOT, out[0]!.value);
    expect(grant?.taskId).toBe('task-9');
  });
});

describe('per-target credential resolution', () => {
  // INVARIANT: a target's credential is DATA looked up per target, never
  // assumed from the backend type — and an unmapped target gets NOTHING. Today
  // that is local Ollama; tomorrow it is a hosted one with its own key. Sending
  // the Anthropic credential to whatever the reroute chain points at is exactly
  // the leak this replaces.
  test('an unmapped target resolves to "none", not to the primary credential', async () => {
    const targets = new TargetCredentials();
    targets.set('https://api.anthropic.com', async () => ({
      kind: 'credential',
      placement: anthropicPlacement('ANTHROPIC_API_KEY', REAL),
      label: 'ANTHROPIC_API_KEY',
    }));
    expect((await targets.forTarget('http://127.0.0.1:11434')).kind).toBe('none');
    expect((await targets.forTarget('https://api.anthropic.com/v1/messages')).kind).toBe('credential');
  });

  test('the placement follows the credential kind, not the slot it arrived in', () => {
    expect(anthropicPlacement('ANTHROPIC_API_KEY', 'k')).toEqual({
      kind: 'header', header: 'x-api-key', value: 'k',
    });
    expect(anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', 'k')).toEqual({
      kind: 'header', header: 'authorization', value: 'Bearer k',
    });
  });
});

describe('header injection', () => {
  test('a header placement removes the carrying header and sets the canonical one', () => {
    const req = new Headers({ 'x-api-key': 'PLACEHOLDER' });
    const presented = collectPresentedCredentials(req);
    const fwd = new Headers(req);
    applyCredential(fwd, presented, 'PLACEHOLDER', anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', REAL));
    // The reroute target authenticates by OAuth even though the client sent an
    // x-api-key — the target's form wins, and the placeholder slot is gone.
    expect(fwd.get('x-api-key')).toBeNull();
    expect(fwd.get('authorization')).toBe(`Bearer ${REAL}`);
  });

  test('an in-place placement preserves the client framing', () => {
    const req = new Headers({ authorization: 'Bearer PLACEHOLDER' });
    const fwd = new Headers(req);
    applyCredential(fwd, collectPresentedCredentials(req), 'PLACEHOLDER', { kind: 'in-place', value: REAL });
    expect(fwd.get('authorization')).toBe(`Bearer ${REAL}`);
  });

  // INVARIANT: a placeholder must never reach a real upstream. It authenticates
  // nothing there, and the resulting error would quote lazy's placeholder while
  // looking like the user's own credential was wrong.
  test('a target needing no credential has the placeholder stripped, not forwarded', () => {
    const req = new Headers({ 'x-api-key': 'PLACEHOLDER', 'content-type': 'application/json' });
    const fwd = new Headers(req);
    stripPresentedCredential(fwd, collectPresentedCredentials(req), 'PLACEHOLDER');
    expect(fwd.get('x-api-key')).toBeNull();
    expect(fwd.get('content-type')).toBe('application/json');
  });
});
