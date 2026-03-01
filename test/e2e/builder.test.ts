import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';

describe('lazy builder', () => {
  let ctx: TestContext;
  let markerDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // The marker now lives under ~/.lazy/<project>/ where project = basename of root
    // (no git remote in test repos, so getProjectName falls back to basename)
    markerDir = join(homedir(), '.lazy', basename(ctx.root));
  });

  afterEach(async () => {
    await ctx.cleanup();
    // Clean up the marker directory created under ~/.lazy/
    if (existsSync(markerDir)) {
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  test('shows session disclosure message', async () => {
    // Builder shows disclosure before spawning claude.
    // In non-TTY mode, it prints the message then proceeds.
    // We use a PATH without claude to make it fail after disclosure.
    const result = await ctx.lazy(['builder'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should show the disclosure message regardless of whether claude exists
    expect(result.stdout).toContain('Launching Claude Code in a new session with lazy\'s system prompt.');
  });

  test('creates .builder-launched marker in ~/.lazy/<project>/ after first run', async () => {
    // Run builder (it will fail if claude not available, but marker should be set)
    await ctx.lazy(['builder'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Check that the marker file was created in the user-local directory
    const markerPath = join(markerDir, '.builder-launched');
    expect(existsSync(markerPath)).toBe(true);

    // Verify it's NOT in the old in-repo location
    const oldMarkerPath = join(ctx.root, '.lazy', '.builder-launched');
    expect(existsSync(oldMarkerPath)).toBe(false);
  });

  test('shows --help', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expect(result.stdout).toContain('Launch an interactive Claude Code session');
    expect(result.stdout).toContain('--append-system-prompt');
  });

  // Conversation history is captured and searchable alongside task data.
  test('help mentions conversation capture', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Conversations are captured');
  });

  // INVARIANT: Every builder run starts a new session (no resume).
  test('always starts new session without prompting', async () => {
    const result = await ctx.lazy(['builder'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should go straight to disclosure — no resume prompt
    expectOutput(result, 'Launching Claude Code in a new session');
    expectOutputExcludes(result, 'Resume previous builder session');
  });
});
