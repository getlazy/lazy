import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { access } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import {
  repositoryPluginsDisabled,
  REPOSITORY_PLUGINS_NOT_RUN,
} from '../../src/config/managed-repo-code';

describe('lazy customize proxy-plugin', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: scaffolding a plugin while repository plugins are not loaded says so up front, in the command output and the agent guide prompt. Inviting people to write code lazy will never run is a lie by omission; keyed off repositoryPluginsDisabled() so restoring loading removes the warning.
  test('warns up front that the plugin will not run, still scaffolds, and warns in the guide', async () => {
    const result = await ctx.lazy(['customize', 'proxy-plugin', 'demo']);
    expectSuccess(result);
    await access(join(ctx.root, '.lazy', 'plugins', 'demo.ts'));
    await access(join(ctx.root, '.lazy', 'plugins', 'demo.test.ts'));

    const out = result.stdout;
    if (repositoryPluginsDisabled()) {
      expect(out.startsWith(`WARNING: ${REPOSITORY_PLUGINS_NOT_RUN}`)).toBe(true);
      // The guide prompt carries the caveat too.
      const guide = out.slice(out.indexOf('--- Hand the prompt below'));
      expect(guide).toContain(REPOSITORY_PLUGINS_NOT_RUN);
    } else {
      expect(out).not.toContain(REPOSITORY_PLUGINS_NOT_RUN);
    }
  });
});
