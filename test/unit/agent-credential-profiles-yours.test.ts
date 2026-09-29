/**
 * The "connect your credentials" list, asked FOR a member: each profile says
 * whether a turn that member starts on it would find a credential — the launch
 * gate's own answer (src/daemon/member-credentials.ts), so a control plane's
 * Credentials page and its start refusal read one decision.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { agentCredentialProfiles, putProfileCredential } from '../../src/daemon/agent-credential-profiles';
import { memberCredentialFor } from '../../src/daemon/member-credentials';
import { clearUserCredentialCache, putUserCredential } from '../../src/daemon/user-credentials';
import { agentProfilesFor } from '../../src/config/agent-profiles';
import { loadConfig } from '../../src/config/loader';

const ALICE = 'alice@example.com';

describe('agentCredentialProfiles for a member', () => {
  let root: string;
  let undo: () => void;
  let saved: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-acp-yours-'));
    undo = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-acp-yours-daemon-')));
    saved = process.env.LAZY_CONFIG;
    await writeFile(join(root, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = join(root, 'lazy.toml');
    clearUserCredentialCache();
  });

  afterEach(() => {
    undo();
    if (saved === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = saved;
    clearUserCredentialCache();
  });

  async function yours() {
    const { profiles } = await agentCredentialProfiles(root, ALICE);
    return Object.fromEntries(profiles.map((p) => [p.name, p.yours]));
  }

  // INVARIANT: the list's per-member answer IS the launch gate's answer, for
  // every built-in profile that takes a member credential (cursor, both codex
  // spellings) — connected exactly when a turn would be let through, missing
  // (with the launch's own reason) exactly when it would be refused. A page
  // that decided "connected" from its own copy told a member with a Cursor key
  // that a refused start was a lie.
  test('connected and missing agree with the launch rule, per profile', async () => {
    const before = await yours();
    expect(before.cursor).toEqual({ state: 'missing', want: 'profile', detail: 'no Cursor credential is connected for it' });
    expect(before['codex-api']).toMatchObject({ state: 'missing', want: 'profile' });
    expect(before['claude-code']).toMatchObject({ state: 'missing', want: 'claude' });
    expect(before.pi).toEqual({ state: 'none-needed' });

    const { profiles } = await agentCredentialProfiles(root);
    for (const name of ['cursor', 'codex-api']) {
      const shown = profiles.find((p) => p.name === name)!;
      // What a control plane sends: the endpoint it SHOWED, '' for none.
      await putProfileCredential(root, {
        userId: ALICE, profile: name, kind: 'api-key', token: `${name}-key`, endpoint: shown.endpoint ?? '',
      });
    }
    await putUserCredential(root, { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice' });

    const after = await yours();
    expect(after.cursor).toEqual({ state: 'connected', via: 'profile' });
    expect(after['codex-api']).toEqual({ state: 'connected', via: 'profile' });
    expect(after['claude-code']).toEqual({ state: 'connected', via: 'claude' });
    // Not connected for it: still missing — the rule is not loosened.
    expect(after['codex-subscription']).toMatchObject({ state: 'missing', want: 'profile' });

    const config = await loadConfig(root);
    for (const [name, state] of Object.entries(after)) {
      const answer = await memberCredentialFor(root, ALICE, agentProfilesFor(config).get(name)!);
      expect(state!.state === 'connected').toBe(answer.kind === 'credential');
    }
  });

  // The same agreement for the two profile kinds the Cursor check does not
  // exercise: a ChatGPT-subscription session (codex-subscription) and a Pi
  // profile that takes a key.
  test('codex-subscription and a keyed Pi profile agree with the launch rule too', async () => {
    await writeFile(
      join(root, 'lazy.toml'),
      '[credentials]\nbackend = "file"\n\n[agents.pi-cloud]\nharness = "pi"\nmodel = "qwen3"\nendpoint = "https://ollama.com"\n',
    );
    expect((await yours())['pi-cloud']).toMatchObject({ state: 'missing', want: 'profile' });
    expect((await yours())['codex-subscription']).toMatchObject({ state: 'missing', want: 'profile' });

    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const access = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    const session = JSON.stringify({ tokens: { access_token: access, refresh_token: 'rt-alice', account_id: 'acct-1' } });

    const { profiles } = await agentCredentialProfiles(root);
    const shown = (name: string) => profiles.find((p) => p.name === name)!.endpoint ?? '';
    await putProfileCredential(root, {
      userId: ALICE, profile: 'codex-subscription', kind: 'oauth', token: session, endpoint: shown('codex-subscription'),
    });
    await putProfileCredential(root, {
      userId: ALICE, profile: 'pi-cloud', kind: 'api-key', token: 'pi-key', endpoint: shown('pi-cloud'),
    });

    const after = await yours();
    expect(after['codex-subscription']).toEqual({ state: 'connected', via: 'profile' });
    expect(after['pi-cloud']).toEqual({ state: 'connected', via: 'profile' });
    const config = await loadConfig(root);
    for (const name of ['codex-subscription', 'pi-cloud']) {
      const answer = await memberCredentialFor(root, ALICE, agentProfilesFor(config).get(name)!);
      expect(answer.kind).toBe('credential');
    }
  });

  test('without a principal the list carries no per-member answer', async () => {
    const { profiles } = await agentCredentialProfiles(root);
    expect(profiles.every((p) => p.yours === undefined)).toBe(true);
  });
});
