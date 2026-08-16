import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { rm } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes, expectError } from '../helpers/assertions';
import { sandboxSuiteSkipped } from '../helpers/sandbox-deps';

/**
 * Replace the [runner] section's type value in a lazy.toml config string, and
 * pin the permission mode alongside it.
 *
 * The mode defaults to 'bypass' for the same reason the fake-binary suites do
 * (see CLAUDE.md): none of these tests is ABOUT the OS sandbox — they assert on
 * builder's CLI surface (disclosure, resume, --model, warning text). Leaving the
 * product default of 'sandbox' made every one of them depend on `bwrap` and
 * `socat` being installed, and lazy correctly refuses to run without them
 * (`failIfUnavailable: true`, no silent unsandboxed fallback). The result was 13
 * failures on any machine missing two packages, all reported as sandbox errors
 * rather than as anything to do with the code under test.
 *
 * The one test that genuinely needs the real posture passes 'sandbox' explicitly
 * and lives in a `sandboxSuiteSkipped`-gated block below.
 *
 * permission_mode must land INSIDE [runner], so it is emitted immediately after
 * the type key it replaces.
 */
function setRunnerType(
  config: string,
  type: string,
  permissionMode: 'sandbox' | 'bypass' = 'bypass',
): string {
  return config.replace(
    /^type\s*=\s*"[^"]*"/m,
    `type = "${type}"\npermission_mode = "${permissionMode}"`,
  );
}

/**
 * Switch the project to the host-process runner.
 *
 * `lazy builder` runs `runner.checkAvailability()` BEFORE the disclosure /
 * resume / --model logic (it refuses to walk a user through prompts only to
 * die on missing infrastructure). Under the default docker runner that check
 * aborts with "binary 'docker' not found" in any environment without Docker —
 * so every test that asserts on output printed after it must pick a runner that
 * is actually available.
 */
function useHostProcessRunner(root: string): void {
  const lazyTomlPath = join(root, 'lazy.toml');
  const existing = readFileSync(lazyTomlPath, 'utf-8');
  writeFileSync(lazyTomlPath, setRunnerType(existing, 'dangerously-host-process-without-any-isolation'));
}

/**
 * Make `lazy builder` actually reach the disclosure / resume / launch code, and
 * return the env that gets it there.
 *
 * These tests used to prune `claude` off PATH and rely on "it fails at the
 * launch step, after printing what we assert on". That stopped working: the
 * pre-flight `runner.checkAvailability()` now runs BEFORE any of that output —
 * it aborts on missing `docker` under the default runner, and on missing
 * `claude` under the host-process one. So availability has to genuinely pass:
 * host-process runner plus a fake `claude` that exits 0.
 */
function launchableBuilderEnv(root: string): Record<string, string> {
  useHostProcessRunner(root);
  const binDir = installFakeClaude(root, join(root, 'claude-args.log'));
  return { PATH: `${binDir}:${process.env.PATH}` };
}

/**
 * Serve just enough of the Ollama HTTP API for the role-target preflight.
 *
 * Enabling `[ollama]` makes the builder role resolve to the ollama backend, and
 * preflightRoleTarget then probes `<endpoint>/api/tags` and FAILS HARD when it
 * does not answer 200 (by design — lazy never silently falls back to another
 * backend). Tests about *which model gets forwarded* would otherwise be
 * asserting on a machine that happens to run `ollama serve`.
 */
function startFakeOllama(): { endpoint: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/api/tags'
        ? Response.json({ models: [] })
        : new Response('not found', { status: 404 }),
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/**
 * Install a fake `claude` executable that records each argv entry (one per line)
 * to `logPath`, then exits 0. Used to capture exactly what flags the builder
 * passes to the Claude Code invocation. Returns the bin dir to prepend to PATH.
 *
 * The fake also satisfies the host-process runner's `claude --version`
 * availability check (it exits 0 for any argv).
 */
function installFakeClaude(root: string, logPath: string): string {
  const binDir = join(root, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" >> "${logPath}"\nexit 0\n`;
  const claudePath = join(binDir, 'claude');
  writeFileSync(claudePath, script);
  chmodSync(claudePath, 0o755);
  return binDir;
}

/** Read the recorded argv (one entry per line) from the fake claude log. */
function readClaudeArgs(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.length > 0);
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
    // Builder shows disclosure before spawning claude, in non-TTY mode too.
    const result = await ctx.lazy(['builder'], {
      env: launchableBuilderEnv(ctx.root),
    });

    // Should show the disclosure message regardless of whether claude exists
    expect(result.stdout).toContain('Launching Claude Code in a new session with lazy\'s system prompt.');
  });

  test('creates .builder-launched marker in ~/.lazy/<project>/ after first run', async () => {
    await ctx.lazy(['builder'], {
      env: launchableBuilderEnv(ctx.root),
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
    expectOutput(result, 'lazy builder list');
    expectOutput(result, 'Resume a specific session');
    expectOutput(result, '--import');
  });

  // INVARIANT: --import is a modifier on a resume, not a mode of its own. Resuming
  // a session that never ran under builder isolation ADOPTS it into an overlay;
  // --import is how the user opts into that, so on its own it means nothing.
  test('--import without --resume is rejected with the correct usage', async () => {
    const result = await ctx.lazy(['builder', '--import'], {
      env: launchableBuilderEnv(ctx.root),
    });

    expectFailure(result);
    expectError(result, 'lazy builder --resume <id> --import');
  });

  // INVARIANT: an explicit session ID is the ONLY resume source. There is no
  // inference — bare --resume fails loudly and points at `lazy builder list`
  // rather than silently starting a fresh session.
  test('bare --resume fails with an actionable error', async () => {
    const result = await ctx.lazy(['builder', '--resume'], {
      env: launchableBuilderEnv(ctx.root),
    });

    expectFailure(result);
    expectError(result, '--resume needs a session ID');
    expectError(result, 'lazy builder list');
    // It must NOT fall back to starting a fresh session.
    expectOutputExcludes(result, 'Launching Claude Code in a new session');
  });

  // INVARIANT: --resume <id> passes the ID directly to Claude.
  test('--resume with explicit ID uses that ID', async () => {
    const result = await ctx.lazy(['builder', '--resume', 'cafebabe-1234-5678-9abc-def012345678'], {
      env: launchableBuilderEnv(ctx.root),
    });

    expectOutput(result, 'Resuming session cafebabe');
  });

  // INVARIANT: Resume skips the interactive system prompt warning.
  // Users have already seen the warning in the original session.
  test('resume skips session disclosure message', async () => {
    const result = await ctx.lazy(['builder', '--resume', 'abcdef01-2345-6789-abcd-ef0123456789'], {
      env: launchableBuilderEnv(ctx.root),
    });

    // Should show the resume message
    expectOutput(result, 'Resuming session abcdef01');
    // Should NOT show the new-session disclosure
    expectOutputExcludes(result, 'Launching Claude Code in a new session');
  });

  // INVARIANT: no session is resumed unless the user names one. A bare
  // `lazy builder` in TTY mode starts a fresh session — it never offers to
  // resume, because nothing tracks a "previous" session per terminal.
  test('bare builder in TTY mode starts a new session without a resume offer', async () => {
    const result = await ctx.lazy(['builder'], {
      env: {
        ...launchableBuilderEnv(ctx.root),
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: 'accept',
      },
    });

    expectOutput(result, 'Launching Claude Code in a new session');
    expectOutputExcludes(result, 'Resume previous builder session');
    expectOutputExcludes(result, 'Resuming session');
  });

  // INVARIANT: Without env var or flag, no resume prompt — straight to new session.
  test('no env var and no flag starts new session without prompting', async () => {
    const result = await ctx.lazy(['builder'], {
      env: launchableBuilderEnv(ctx.root),
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

  test('--autonomous with permission_mode = "bypass" shows the full danger warning', async () => {
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(
      lazyTomlPath,
      setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation', 'bypass'),
    );

    const result = await ctx.lazy(['builder', '--autonomous', '--yes'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
    expectOutput(result, '⚠ DANGER: Running on the host WITHOUT isolation (permission_mode = "bypass").');
    expectOutput(result, 'The agent has unrestricted access to your system.');
    expectOutput(result, 'Only proceed on an isolated/disposable machine.');
  });

  test('--help documents the --model flag (builder model, not per-task)', async () => {
    const result = await ctx.lazy(['builder', '--help']);

    expectSuccess(result);
    expectOutput(result, '--model <id>');
    // Must make the BUILDER-vs-per-task distinction explicit.
    expectOutput(result, "BUILDER's model");
  });

  // INVARIANT: `lazy builder --model <id>` passes `--model <id>` straight
  // through to the Claude Code invocation. This is the builder's own model
  // (distinct from the per-task --model used when starting tasks), and there is
  // no allow-list — whatever the user gives is forwarded verbatim so brand-new
  // models work.
  test('--model is passed through to the Claude Code invocation', async () => {
    const lazyTomlPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
    writeFileSync(lazyTomlPath, setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation'));

    const logPath = join(ctx.root, 'claude-args.log');
    const binDir = installFakeClaude(ctx.root, logPath);

    const result = await ctx.lazy(['builder', '--model', 'mythos'], {
      env: { PATH: `${binDir}:${process.env.PATH}` },
    });
    expectSuccess(result);

    const args = readClaudeArgs(logPath);
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('mythos');
  });

  // INVARIANT: an explicit --model flag takes precedence over the
  // Ollama-injected model. We must end up with exactly ONE --model arg (the
  // user's), never two — two would be ambiguous to Claude Code.
  test('explicit --model wins over the Ollama-injected model', async () => {
    const ollama = startFakeOllama();
    try {
      const lazyTomlPath = join(ctx.root, 'lazy.toml');
      let cfg = readFileSync(lazyTomlPath, 'utf-8');
      cfg = setRunnerType(cfg, 'dangerously-host-process-without-any-isolation');
      // Enable Ollama with its own model — this would normally inject --model.
      cfg += `\n[ollama]\nenabled = true\nmodel = "ollama-local-model"\nendpoint = "${ollama.endpoint}"\n`;
      writeFileSync(lazyTomlPath, cfg);

      const logPath = join(ctx.root, 'claude-args.log');
      const binDir = installFakeClaude(ctx.root, logPath);

      const result = await ctx.lazy(['builder', '--model', 'mythos'], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);

      const args = readClaudeArgs(logPath);
      const modelIndexes = args.flatMap((a, i) => (a === '--model' ? [i] : []));
      // Exactly one --model arg, and it's the explicit user value.
      expect(modelIndexes.length).toBe(1);
      expect(args[modelIndexes[0] + 1]).toBe('mythos');
      expect(args).not.toContain('ollama-local-model');
    } finally {
      ollama.stop();
    }
  });

  // Guards the existing behavior: with no --model flag, Ollama's model is still
  // injected so Claude Code targets the local model rather than its opus default.
  test('Ollama model is still injected when no --model flag is given', async () => {
    const ollama = startFakeOllama();
    try {
      const lazyTomlPath = join(ctx.root, 'lazy.toml');
      let cfg = readFileSync(lazyTomlPath, 'utf-8');
      cfg = setRunnerType(cfg, 'dangerously-host-process-without-any-isolation');
      cfg += `\n[ollama]\nenabled = true\nmodel = "ollama-local-model"\nendpoint = "${ollama.endpoint}"\n`;
      writeFileSync(lazyTomlPath, cfg);

      const logPath = join(ctx.root, 'claude-args.log');
      const binDir = installFakeClaude(ctx.root, logPath);

      const result = await ctx.lazy(['builder'], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);

      const args = readClaudeArgs(logPath);
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('ollama-local-model');
    } finally {
      ollama.stop();
    }
  });

  // INVARIANT: --model requires a non-empty value so we never append a dangling
  // --model arg to Claude Code.
  test('--model with empty value is rejected', async () => {
    const result = await ctx.lazy(['builder', '--model', '']);
    expectFailure(result, 1);
    expectError(result, 'Invalid --model');
  });

  // INVARIANT (fix-builder-model-ollama-precedence): an arbitrary (non-Anthropic)
  // model with NO local server configured resolves to the anthropic backend,
  // which can't serve it — reject up front instead of failing opaquely at runtime.
  // (claude-* and the known short names are accepted; a local server would allow
  // any name — that path is covered by the "wins over Ollama" test above.)
  test('--model with an unknown name and no local server is rejected up front', async () => {
    useHostProcessRunner(ctx.root);
    const result = await ctx.lazy(['builder', '--model', 'qwen3-coder']);
    expectFailure(result, 1);
    expectError(result, 'Unknown --model');
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

/**
 * The one builder test that genuinely exercises the real OS sandbox posture.
 *
 * It is split out and gated because it is the only assertion here that CANNOT be
 * made under `permission_mode = "bypass"` — it is checking the wording lazy uses
 * when the sandbox IS active. Everything else in this file pins builder's CLI
 * surface and runs under bypass (see setRunnerType above), so a machine without
 * `bwrap`/`socat` loses exactly this one test instead of thirteen.
 *
 * INVARIANT (same rule as slowSuiteSkipped): a skipped sandbox block prints one
 * line saying so. Never silently green-by-omission — the posture it covers is
 * the PRODUCTION default.
 */
describe.skipIf(sandboxSuiteSkipped('lazy builder sandbox posture'))(
  'lazy builder sandbox posture',
  () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // INVARIANT: --autonomous on the host runner always adds a second warning
    // naming the isolation posture. The severity depends on permission_mode:
    // the default 'sandbox' confines Bash, 'bypass' does not. Asserting only the
    // DANGER wording would fail on the safe default, which is now the norm.
    test('--autonomous on the host under the OS sandbox names the sandbox posture', async () => {
      const lazyTomlPath = join(ctx.root, 'lazy.toml');
      const existingConfig = readFileSync(lazyTomlPath, 'utf-8');
      writeFileSync(
        lazyTomlPath,
        setRunnerType(existingConfig, 'dangerously-host-process-without-any-isolation', 'sandbox'),
      );

      const result = await ctx.lazy(['builder', '--autonomous', '--yes'], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      });

      expectOutput(result, '⚠ Autonomous mode: the builder will run without permission prompts.');
      expectOutput(result, '⚠ Running on the host under the OS sandbox (permission_mode = "sandbox").');
      expectOutput(result, 'Bash is confined to the worktree');
    });
  },
);
