/**
 * `startBuilderSession`'s credential grant names the MEMBER, not a terminal
 * (docs/design/actor-identity-and-remote-clients.md §5.5 — the gap Part C
 * closes: today's docker builder binds per SESSION, `builder-<id>`; a
 * daemon-owned session names the MEMBER and the launch,
 * `member-builder:<email>:<builderId>`, so its release can revoke it).
 *
 * `src/daemon/builder-sessions.ts` calls `getLaunchAuthEnvVars` (the
 * daemon-internal credential path — see the comment at its call site for why
 * `resolveAuthEnvFromDaemon` would be wrong here) with an identity whose label
 * is `sessionLaunchGrantLabel(email, builderId)`. This test proves that identity really does
 * produce a grant registered under that label — real `mintCredentialGrant`,
 * not the e2e module mock (`test/mocks/claude.ts`'s `getLaunchAuthEnvVars`
 * fabricates a placeholder-shaped value without ever registering a grant, so
 * this must be a plain unit test, not one that runs under the e2e preload).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm } from 'fs/promises';
import { getLaunchAuthEnvVars } from '../../src/capture/claude';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import { sessionLaunchGrantLabel } from '../../src/daemon/builder-sessions';
import {
  clearCredentialGrantCache,
  lookupCredentialGrant,
} from '../../src/proxy/credential-broker';
import { makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findLazyRoot } from '../../src/project-paths';

describe("startBuilderSession's grant names the member", () => {
  let undo: () => void;
  let baseDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    undo = pinDaemonBaseDir(baseDir);
    clearCredentialGrantCache();
    setDaemonContext({ webPort: 26024, token: 'test', proxyPort: 40001 });
    // getLaunchAuthEnvVars resolves its project root via findLazyRoot()
    // (process.cwd() upward) — this dev repo, when `bun test` runs from here.
    const root = findLazyRoot();
    if (!root) throw new Error('test must run inside a lazy project');
    projectRoot = root;
  });

  afterEach(async () => {
    clearDaemonContext();
    undo();
    clearCredentialGrantCache();
    await rm(baseDir, { recursive: true, force: true });
  });

  // INVARIANT: the grant label names the member AND the launch. The member so
  // the audit log names a person; the launch so releasing one launch revokes
  // exactly its own placeholder — a per-member label was reused by every
  // launch and never revoked on stop/end.
  test('sessionLaunchGrantLabel names the member and the launch', () => {
    expect(sessionLaunchGrantLabel('ivan@example.com', 'a1b2c3d4')).toBe('member-builder:ivan@example.com:a1b2c3d4');
    expect(sessionLaunchGrantLabel('ivan@example.com', 'a1b2c3d4')).not.toBe(sessionLaunchGrantLabel('ivan@example.com', 'e5f6a7b8'));
    expect(sessionLaunchGrantLabel('pete@example.com', 'a1b2c3d4')).not.toBe(sessionLaunchGrantLabel('ivan@example.com', 'a1b2c3d4'));
    expect(sessionLaunchGrantLabel(null, 'a1b2c3d4')).toBe('builder-session:a1b2c3d4');
  });

  test('a session start mints a grant registered under the member label', async () => {
    const email = 'ivan@example.com';
    const identity = {
      role: 'builder' as const, taskId: null, label: sessionLaunchGrantLabel(email, 'a1b2c3d4'), profile: 'claude-code',
    };

    const vars = await getLaunchAuthEnvVars(
      identity, undefined, { role: 'builder' }, 'container',
      [{ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-api03-real-credential-for-member-grant' }],
    );
    const token = vars.find(v => v.key === 'ANTHROPIC_API_KEY')?.value;
    expect(token).toBeDefined();
    expect(token).not.toBe('sk-ant-api03-real-credential-for-member-grant');

    const grant = await lookupCredentialGrant(projectRoot, token!);
    expect(grant, 'expected a registered grant for the minted placeholder').not.toBeNull();
    expect(grant!.role).toBe('builder');
    expect(grant!.taskId).toBeNull();
    expect(grant!.label).toBe(sessionLaunchGrantLabel(email, 'a1b2c3d4'));
  });

  test('two members get two DIFFERENT grants, never sharing one placeholder', async () => {
    const mint = (email: string) => getLaunchAuthEnvVars(
      { role: 'builder' as const, taskId: null, label: sessionLaunchGrantLabel(email, 'a1b2c3d4'), profile: 'claude-code' },
      undefined, { role: 'builder' }, 'container',
      [{ key: 'ANTHROPIC_API_KEY', value: `sk-ant-api03-real-credential-for-${email}` }],
    );

    const ivan = await mint('ivan@example.com');
    const pete = await mint('pete@example.com');
    const ivanToken = ivan.find(v => v.key === 'ANTHROPIC_API_KEY')!.value;
    const peteToken = pete.find(v => v.key === 'ANTHROPIC_API_KEY')!.value;

    expect(ivanToken).not.toBe(peteToken);
    expect((await lookupCredentialGrant(projectRoot, ivanToken))!.label).toBe(sessionLaunchGrantLabel('ivan@example.com', 'a1b2c3d4'));
    expect((await lookupCredentialGrant(projectRoot, peteToken))!.label).toBe(sessionLaunchGrantLabel('pete@example.com', 'a1b2c3d4'));
  });
});
