/**
 * Host-runner agents are denied lazy's own state — end to end.
 *
 * The unit suite (test/unit/host-sandbox-posture.test.ts) checks the settings
 * builder; this checks the real chain: daemon → supervisor → the agent argv the
 * fake `claude` actually received.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { basename, dirname, join, resolve, sep } from 'path';
import { realpath } from 'fs/promises';
import { projectRootWriteDenyRules } from '../../src/runner/host-sandbox';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { storageDirFor } from '../helpers/storage';
import { sandboxSuiteSkipped } from '../helpers/sandbox-deps';

describe.skipIf(sandboxSuiteSkipped('host sandbox denies lazy state'))(
  'host-runner agent settings deny the daemon dir and the store',
  () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy({ fakeClaude: true, hostPermissionMode: 'sandbox' });
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // INVARIANT: a host-runner agent can neither read nor write the lazy daemon
    // base dir (per-task env values, credentials, MCP tool-access tokens) or the
    // project's external store — on both the OS-sandbox and file-tool boundaries.
    test('work-turn --settings carries both paths', async () => {
      await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-deny' }));
      const taskId = await createTask(ctx, 'Deny lazy state', 'Do a small thing');
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));

      // Same resolution setupTestLazy uses for the fakeClaude daemon.
      const daemonBase = resolve(
        process.env.LAZY_DAEMON_BASE_DIR || join(process.env.HOME ?? homedir(), '.lazy', 'daemon'),
      );
      const store = resolve(storageDirFor(ctx.root));

      const inv = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
      expect(inv).toBeDefined();
      const i = inv!.argv.indexOf('--settings');
      expect(i).toBeGreaterThanOrEqual(0);
      const settings = JSON.parse(inv!.argv[i + 1]);
      for (const p of [daemonBase, store]) {
        expect(settings.sandbox.filesystem.denyRead).toContain(p);
        expect(settings.permissions.deny).toContain(`Read(/${p})`);
        expect(settings.permissions.deny).toContain(`Read(/${p}/**)`);
      }
    }, 180_000);

    // INVARIANT: a host-runner agent's file tools cannot write the project
    // root (the root lazy.toml decides its next turn's rules) but can write its
    // own worktree. The rules are per worktree, so they are added by the
    // supervisor — this checks they reach the agent argv through the real chain.
    test('work-turn --settings confines the file tools to the task worktree', async () => {
      await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-root' }));
      const taskId = await createTask(ctx, 'Deny project root', 'Do a small thing');
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));

      const inv = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
      expect(inv).toBeDefined();
      const deny: string[] = JSON.parse(inv!.argv[inv!.argv.indexOf('--settings') + 1]).permissions.deny;
      const root = await realpath(ctx.root);
      const worktreeName = basename(await realpath(inv!.cwd));
      const expected = projectRootWriteDenyRules({ projectRoots: [root], dataDir: '.lazy', worktreeName });
      expect(deny).toEqual(expect.arrayContaining(expected));
    }, 180_000);

    // INVARIANT: a host-runner agent cannot write its worktree's git pointers,
    // the common config or hooks (Bash and file tools), and its file tools
    // cannot write the common git dir — added per worktree by the supervisor
    // (docs/design/git-pointer-boundary.md). Checked on the argv the agent
    // really received, not on the settings builder.
    test('work-turn --settings carries the git-pointer denies for its worktree', async () => {
      await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-ptr' }));
      const taskId = await createTask(ctx, 'Deny git pointers', 'Do a small thing');
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));

      const inv = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
      expect(inv).toBeDefined();
      const settings = JSON.parse(inv!.argv[inv!.argv.indexOf('--settings') + 1]);
      const denyWrite: string[] = settings.sandbox.filesystem.denyWrite ?? [];
      const common = await realpath(join(ctx.root, '.git'));

      const dotGit = denyWrite.find(p => p.includes(`${sep}.lazy${sep}worktrees${sep}`) && p.endsWith(`${sep}.git`));
      expect(dotGit).toBeDefined();
      const id = basename(dirname(dotGit!));
      for (const p of [
        join(common, 'worktrees', id, 'commondir'),
        join(common, 'worktrees', id, 'gitdir'),
        join(common, 'config'),
        join(common, 'hooks'),
      ]) {
        expect(denyWrite).toContain(p);
        expect(settings.permissions.deny).toContain(`Edit(/${p})`);
      }
      expect(settings.permissions.deny).toContain(`Write(/${common}/**)`);
      expect(denyWrite).not.toContain(common);
    }, 180_000);
  },
);
