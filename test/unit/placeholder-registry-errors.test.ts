import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { bindTurnCredential, clearSessionCredentialCache, getTaskSessionBinding } from '../../src/daemon/session-credentials';
import { mintCredentialGrant, clearCredentialGrantCache, lookupCredentialGrant } from '../../src/proxy/credential-broker';
import { getProxyTokensPath, getSessionCredentialsPath } from '../../src/daemon/paths';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

let root: string;
let unpin: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-placeholder-errors-'));
  unpin = pinDaemonBaseDir(root);
  clearSessionCredentialCache(); clearCredentialGrantCache();
});
afterEach(async () => {
  clearSessionCredentialCache(); clearCredentialGrantCache();
  unpin();
  await rm(root, { recursive: true, force: true });
});

// INVARIANT: malformed credential registries refuse without exposing spendable placeholders. Runtime JSON syntax errors can include the registry's secret bytes.
test('corrupt session and grant registries report the path without echoing their token', async () => {
  const session = await bindTurnCredential(root, { taskId: 'task', sessionId: 'session', ownerUserId: 'member@example.com', kind: 'api-key' });
  const grant = await mintCredentialGrant(root, { role: 'builder', taskId: null, label: 'builder', envKey: 'ANTHROPIC_API_KEY' });
  for (const [path, token, read] of [
    [getSessionCredentialsPath(root), session.token, () => getTaskSessionBinding(root, 'task')],
    [getProxyTokensPath(root), grant, () => lookupCredentialGrant(root, grant)],
  ] as const) {
    // An unquoted identifier makes Bun include these bytes in its SyntaxError.
    const malformedSecret = 'syntheticSpendablePlaceholderSecret';
    await writeFile(path, `{"token":${malformedSecret},"other":"${token}"}`);
    clearSessionCredentialCache(); clearCredentialGrantCache();
    let message = '';
    try { await read(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain(path);
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain(token);
    expect(message).not.toContain(token.slice(0, 18));
    expect(message).not.toContain(malformedSecret);
  }
});
