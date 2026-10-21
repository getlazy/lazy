/**
 * A builder's MCP git writes (lazy_commit, accept) have no task, so no turn
 * owner: on a managed host they used to fall back to the service credential's
 * owner, or be refused. The builder session is bound to a member, and that
 * member authors them.
 */

import { test, expect, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { builderSessionMember } from '../../src/daemon/mcp-routes';
import { resolveGitAuthorForArgs, runWithGitAuthor } from '../../src/identity/git-author';
import { MANAGED_ENV } from '../../src/config/managed';
import type { Storage } from '../../src/storage/interface';

const storage = {
  listBuilderSessions: async () => [
    { builderId: 'b1', state: 'running', memberEmail: 'alice@example.com' },
    { builderId: 'b2', state: 'ended', memberEmail: 'bob@example.com' },
    { builderId: 'b3', state: 'running', memberEmail: null },
  ],
} as unknown as Storage;

const saved = process.env[MANAGED_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[MANAGED_ENV]; else process.env[MANAGED_ENV] = saved;
});

// INVARIANT: in managed mode a builder session's git writes are authored by
// the member the session belongs to, found through the authenticated token
// label — never the service owner, and never a request field.
test('a live builder session names its member in managed mode', async () => {
  process.env[MANAGED_ENV] = '1';
  const member = await builderSessionMember(storage, '/tmp/x', 'builder-b1');
  expect(member).toEqual({ email: 'alice@example.com' });
  const env = await runWithGitAuthor(member, () => resolveGitAuthorForArgs(['commit', '-m', 'x']));
  expect(env).toEqual({ env: {
    GIT_AUTHOR_NAME: 'alice@example.com', GIT_AUTHOR_EMAIL: 'alice@example.com',
    GIT_COMMITTER_NAME: 'alice@example.com', GIT_COMMITTER_EMAIL: 'alice@example.com',
  } });
  expect(await builderSessionMember(storage, '/tmp/x', 'builder-b2')).toBeNull();
  expect(await builderSessionMember(storage, '/tmp/x', 'builder-b3')).toBeNull();
  expect(await builderSessionMember(storage, '/tmp/x', 'builder-nope')).toBeNull();
  expect(await builderSessionMember(storage, '/tmp/x', 'not-a-builder')).toBeNull();
  expect(await builderSessionMember(storage, '/tmp/x', null)).toBeNull();
});

test('on a laptop the builder keeps the daemon\'s own git identity', async () => {
  delete process.env[MANAGED_ENV];
  expect(await builderSessionMember(storage, '/tmp/x', 'builder-b1')).toBeNull();
});

test('handleMcpToolCall scopes a builder call to its member', async () => {
  const mcp = await readFile(join(import.meta.dir, '../../src/daemon/mcp-routes.ts'), 'utf-8');
  expect(mcp).toMatch(/builderSessionMember\(storage, projectRoot, builderTokenLabel \?\? null\)/);
  expect(mcp).toMatch(/runWithGitAuthor\(builderMember,/);
});
