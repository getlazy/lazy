import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';

/** Replace the [runner] section's type value in a lazy.toml config string. */
function setRunnerType(config: string, type: string): string {
  return config.replace(/^type\s*=\s*"[^"]*"/m, `type = "${type}"`);
}

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

    // Verify it's NOT in the .lazy directory
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

  // The supervised relaunch loop is docker/podman-only — host-process builders
  // are not stopped by upgrade, so help must say auto-resume applies there only.
  test('help documents docker-only auto-resume across upgrade', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expectOutput(result, 'Auto-resume across upgrade (docker/podman only)');
    // Honesty about the unsent-input loss (spike §4 / S3).
    expectOutput(result, 'unsent input cannot be recovered');
    // Actionable manual fallback is documented.
    expectOutput(result, 'lazy builder --resume');
  });

  test('--help shows resume options', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expectOutput(result, '--resume');
    expectOutput(result, 'LAZY_LAST_SESSION_ID');
    expectOutput(result, 'Resume a specific session');
  });

  // INVARIANT: --resume without LAZY_LAST_SESSION_ID errors clearly.
  // No file scanning — env var is the only source for bare --resume.
  test('--resume fails when LAZY_LAST_SESSION_ID is not set', async () => {
    const result = await ctx.lazy(['builder', '--resume'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    expectError(result, 'LAZY_LAST_SESSION_ID is not set');
  });

  // INVARIANT: --resume (bare) reads from LAZY_LAST_SESSION_ID env var.
  test('--resume reads session ID from env var', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const result = await ctx.lazy(['builder', '--resume'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LAZY_LAST_SESSION_ID: sessionId,
      },
    });

    expectOutput(result, 'Resuming session aaaaaaaa');
  });

  // INVARIANT: --resume <id> passes the ID directly to Claude.
  test('--resume with explicit ID uses that ID', async () => {
    const result = await ctx.lazy(['builder', '--resume', 'cafebabe-1234-5678-9abc-def012345678'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    expectOutput(result, 'Resuming session cafebabe');
  });

  // INVARIANT: Resume skips the interactive system prompt warning.
  // Users have already seen the warning in the original session.
  test('resume skips session disclosure message', async () => {
    const result = await ctx.lazy(['builder', '--resume', 'abcdef01-2345-6789-abcd-ef0123456789'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should show the resume message
    expectOutput(result, 'Resuming session abcdef01');
    // Should NOT show the new-session disclosure
    expectOutputExcludes(result, 'Launching Claude Code in a new session');
  });

  // INVARIANT: When LAZY_LAST_SESSION_ID is set in TTY mode, offer to resume.
  // promptYesNo with LAZY_PROMPT_DEFAULTS="accept" returns true.
  test('offers resume prompt in TTY mode when env var is set', async () => {
    const sessionId = 'faceb00c-cafe-babe-dead-beefcafebabe';

    const result = await ctx.lazy(['builder'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: 'accept',
        LAZY_LAST_SESSION_ID: sessionId,
      },
    });

    // Should show the yes/no prompt with session ID
    expectOutput(result, 'Resume previous builder session faceb00c');
    // Accepted → resuming
    expectOutput(result, 'Resuming session faceb00c');
    // Resume should skip disclosure
    expectOutputExcludes(result, 'Launching Claude Code in a new session');
  });

  // INVARIANT: Declining resume in TTY mode starts a new session with disclosure.
  test('declining resume in TTY mode starts new session', async () => {
    const sessionId = 'faceb00c-cafe-babe-dead-beefcafebabe';

    const result = await ctx.lazy(['builder'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: 'decline',
        LAZY_LAST_SESSION_ID: sessionId,
      },
    });

    // Should show the yes/no prompt
    expectOutput(result, 'Resume previous builder session faceb00c');
    // Declined → new session with disclosure
    expectOutput(result, 'Launching Claude Code in a new session');
  });

  // INVARIANT: Without env var or flag, no resume prompt — straight to new session.
  test('no env var and no flag starts new session without prompting', async () => {
    const result = await ctx.lazy(['builder'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should go straight to disclosure — no resume prompt
    expectOutput(result, 'Launching Claude Code in a new session');
    expectOutputExcludes(result, 'Resume previous builder session');
  });

  test('--autonomous shows warning and requires confirmation in TTY mode', async () => {
    // Configure host-process runner to bypass Docker check
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(lazyTomlPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['builder', '--autonomous'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: 'decline',
      },
    });

    // Should show autonomous mode warning
    expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
    expectOutput(result, "Type 'yes' to proceed");
    expectOutput(result, 'Aborted.');
  });

  test('--autonomous with --yes skips confirmation in non-TTY mode', async () => {
    // Configure host-process runner to bypass Docker check
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(lazyTomlPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['builder', '--autonomous', '--yes'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should show warning but not prompt for confirmation
    expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
    // Should not ask for confirmation (proceeds directly, then fails on missing claude)
    expectOutputExcludes(result, "Type 'yes' to proceed");
  });

  test('--autonomous without --yes fails in non-TTY mode', async () => {
    // Configure host-process runner to bypass Docker check
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(lazyTomlPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['builder', '--autonomous'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should show warning
    expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
    // Should fail with error (error goes to stderr)
    expectError(result, 'Error: --autonomous requires --yes flag in non-interactive mode.');
    expect(result.exitCode).toBe(1);
  });

  test('--autonomous with host-process runner shows additional danger warning', async () => {
    // Configure host-process runner
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(lazyTomlPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const result = await ctx.lazy(['builder', '--autonomous', '--yes'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // Should show autonomous warning
    expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
    // Should show additional danger warning
    expectOutput(result, '⚠ DANGER: Running on the host WITHOUT isolation.');
    expectOutput(result, 'The agent has unrestricted access to your system.');
    expectOutput(result, 'Only proceed on an isolated/disposable machine.');
  });

  test('--help shows --autonomous flag', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expectOutput(result, '--autonomous');
    expectOutput(result, 'Run without permission prompts');
  });

  // INVARIANT: builder rejects unknown flags with a non-zero exit code.
  // Silently forwarding unknown flags to Claude Code masks mistakes — agents
  // and humans need to know when lazy isn't doing what they think.
  test('unknown flag causes non-zero exit with error message', async () => {
    const result = await ctx.lazy(['builder', '--unblocked']);

    expectFailure(result, 1);
    expectError(result, 'Unknown flag: --unblocked');
  });

  test('unknown flag error message includes command hint', async () => {
    const result = await ctx.lazy(['builder', '--bogus-flag']);

    expectFailure(result, 1);
    expectError(result, 'lazy builder --help');
  });
});
