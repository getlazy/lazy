/**
 * lazy builder — Launch Claude Code with the Lazy builder system prompt.
 *
 * This command starts an interactive Claude Code session with the Lazy builder
 * instructions injected via --append-system-prompt. The user's CLAUDE.md is untouched.
 *
 * Sessions share the host's ~/.claude/ directory, so Claude Code settings, credentials,
 * and conversation history are available inside the container. The builder supervisor
 * captures conversations into lazy's store so they're searchable alongside task data.
 *
 * Subcommands:
 *   lazy builder list     List captured builder conversations
 *
 * Prompt content lives in src/prompts/*.md and is embedded at build time via
 * Bun's `import ... with { type: 'text' }`.
 */

import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { getHome } from '../../utils/home';
import { requireLazyRoot, requireStorage, tryRemoteStorage, parseFlags, type FlagDefinition } from '../helpers';
import { loadConfig, hasExplicitModelConfig } from '../../config/loader';
import { isTTY, promptLine, promptYesNo } from '../editor';
import { getProjectName } from '../../storage';
import { theme } from '../theme';
import { createRunner, type Runner } from '../../runner';
import { generateBuilderConfig } from '../../builder/server';
import { queryDaemonMcpConfig } from '../../daemon/rpc-fallback';
import { checkDaemonHealth } from '../../daemon/lifecycle';
import { runBuilderRelaunchLoop, type BuilderLaunchResult } from '../../builder/relaunch';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';

// Embedded at build/compile time — changes to these files require rebuild
import lazySystemPrompt from '../../prompts/builder-system-prompt.md' with { type: 'text' };
import modelGuidance from '../../prompts/model-guidance.md' with { type: 'text' };

async function buildSystemPrompt(lazyRoot: string, runner: Runner): Promise<string> {
  // Inject runner-specific instructions into the template
  const runnerInstructions = runner.getBuilderInstructions().trimEnd();
  let prompt = lazySystemPrompt.replace('{{RUNNER_INSTRUCTIONS}}', runnerInstructions).trimEnd();

  if (await hasExplicitModelConfig(lazyRoot)) {
    // User configured a default model — tell builder to respect it
    const config = await loadConfig(lazyRoot);
    const defaultModel = config.models.default;
    prompt += `\n\n## Model selection\n\nThe project is configured to use **${defaultModel}** as the default model (in lazy.toml).\nDo NOT pass \`--model\` when creating or starting tasks unless the engineer explicitly asks for a different model.\nOmitting \`--model\` lets the CLI use the configured default automatically.`;
  } else {
    prompt += '\n\n' + modelGuidance.trimEnd();
  }

  return prompt;
}

/**
 * Return the per-project marker directory under ~/.lazy/<project>/.
 * This is user-local state (not project state) for tracking first-run disclosure.
 */
async function builderMarkerDir(root: string): Promise<string> {
  const projectName = await getProjectName(root);
  return join(getHome(), '.lazy', projectName);
}

/**
 * Check if this is the first time builder has been run for this project.
 * Uses a marker file in ~/.lazy/<project>/ to track.
 */
async function isFirstBuilderRun(root: string): Promise<boolean> {
  const markerPath = join(await builderMarkerDir(root), '.builder-launched');
  return !existsSync(markerPath);
}

async function markBuilderRun(root: string): Promise<void> {
  const markerDir = await builderMarkerDir(root);
  if (!existsSync(markerDir)) {
    mkdirSync(markerDir, { recursive: true });
  }
  writeFileSync(join(markerDir, '.builder-launched'), new Date().toISOString());
}

// --- Subcommand: list ---

async function commandBuilderList(_lazyRoot: string): Promise<void> {
  const storage = await requireStorage();

  try {
    const conversations = await storage.listConversations();

    if (conversations.length === 0) {
      console.log('No captured builder conversations yet.');
      console.log(`Run 'lazy builder' to start a builder session.`);
      return;
    }

    console.log(`${conversations.length} captured conversation(s):\n`);

    const header = `${'SESSION'.padEnd(10)} ${'STARTED'.padEnd(18)} ${'LAST'.padEnd(18)} ${'TURNS'.padEnd(12)} FIRST PROMPT`;
    console.log(header);

    for (const conv of conversations) {
      const shortId = conv.sessionId.substring(0, 8);
      // Format ISO timestamps as "YYYY-MM-DD HH:MM"
      const started = conv.startedAt
        ? conv.startedAt.replace('T', ' ').substring(0, 16)
        : '-';
      const ended = conv.endedAt
        ? conv.endedAt.replace('T', ' ').substring(0, 16)
        : '-';

      const humanTurns = conv.stats.userMessageCount;
      const agentTurns = conv.stats.assistantMessageCount;
      const turns = `${humanTurns}h/${agentTurns}a`;

      // First line of first user prompt
      const firstUserMsg = conv.messages.find(m => m.role === 'user');
      const firstLine = firstUserMsg
        ? firstUserMsg.text.split('\n')[0].substring(0, 60)
        : '(no prompt)';
      const truncated = firstUserMsg && firstUserMsg.text.split('\n')[0].length > 60 ? '...' : '';

      console.log(`${theme.taskId(shortId).padEnd(19)} ${started.padEnd(18)} ${ended.padEnd(18)} ${turns.padEnd(12)} ${firstLine}${truncated}`);
    }

    console.log(`\nUse 'lazy show <session-id>' to view a full conversation.`);
  } finally {
    await storage.close();
  }
}

// --- Resume helpers ---

/**
 * Get the last builder session ID from the LAZY_LAST_SESSION_ID env var.
 * This is the only source — no file scanning or marker files.
 * The env var is inherently terminal-scoped, which prevents race conditions
 * between concurrent builder sessions in different terminals.
 */
function getLastSessionId(): string | null {
  const envId = process.env.LAZY_LAST_SESSION_ID;
  if (envId && envId.trim()) return envId.trim();
  return null;
}

// --- Main command ---

export async function commandBuilder(args: string[]): Promise<void> {
  const root = requireLazyRoot();

  // Handle subcommands before launching Claude
  const subcommand = args[0];
  if (subcommand === 'list' || subcommand === 'ls') {
    await commandBuilderList(root);
    return;
  }

  // Parse and validate all flags — unknown flags exit with an error
  const BUILDER_FLAGS: FlagDefinition[] = [
    { name: 'autonomous', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'resume', takesValue: true, optionalValue: true },
    { name: 'effort', takesValue: true },
  ];
  const parsed = parseFlags(args, BUILDER_FLAGS, 'builder');
  const autonomous = parsed.flags.get('autonomous') === true;
  const yes = parsed.flags.get('yes') === true;
  const resumeArg = parsed.flags.get('resume') ?? null;

  // --effort override > config.builder.effort > built-in default (enforced in loader: "high")
  let effortOverride: EffortLevel | undefined;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effortOverride = effortValue as EffortLevel;
  }

  // Create the runner — determines Docker vs host-process mode
  const runner = await createRunner(root);
  const config = await loadConfig(root);

  // Autonomous mode warnings and confirmation
  // Show these BEFORE pre-flight checks so users see the warnings even if infrastructure fails
  if (autonomous) {
    console.log('');
    console.log('⚠ Autonomous mode: the builder will run without permission prompts.');

    // Additional warning for host-process runner
    if (runner.type === 'dangerously-host-process-without-any-isolation') {
      console.log('⚠ DANGER: Running on the host WITHOUT isolation.');
      console.log('  The agent has unrestricted access to your system.');
      console.log('  Only proceed on an isolated/disposable machine.');
    }

    console.log('');

    // Require confirmation
    if (isTTY()) {
      const response = await promptLine("Type 'yes' to proceed");
      if (response !== 'yes') {
        console.log('Aborted.');
        process.exit(0);
      }
    } else {
      if (!yes) {
        console.error('Error: --autonomous requires --yes flag in non-interactive mode.');
        process.exit(1);
      }
    }

    console.log('');
  }

  // Pre-flight: check that infrastructure is available before showing prompts.
  // This validates Docker availability and API key presence early, so the user
  // doesn't go through disclosure prompts only to hit a failure.
  try {
    await runner.checkAvailability();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  const systemPrompt = await buildSystemPrompt(root, runner);

  // Determine if we're resuming and which session ID to use.
  // Resume source: LAZY_LAST_SESSION_ID env var (terminal-scoped) or explicit --resume <id>.
  let resumeId: string | null = null;
  const lastSessionId = getLastSessionId();

  if (resumeArg === true) {
    // Bare --resume: use LAZY_LAST_SESSION_ID env var
    if (!lastSessionId) {
      console.error('LAZY_LAST_SESSION_ID is not set.');
      console.error('Use --resume <id> with an explicit session ID, or set the env var.');
      console.error(`Find session IDs with: lazy builder list`);
      process.exit(1);
    }
    resumeId = lastSessionId;
    console.log(`Resuming session ${resumeId.substring(0, 8)}`);
  } else if (typeof resumeArg === 'string') {
    // Explicit session ID — pass directly to Claude (no storage scanning)
    resumeId = resumeArg;
    console.log(`Resuming session ${resumeId.substring(0, 8)}`);
  } else if (lastSessionId && isTTY()) {
    // No --resume flag but LAZY_LAST_SESSION_ID is set — offer to resume
    const shortId = lastSessionId.substring(0, 8);
    const shouldResume = await promptYesNo(`Resume previous builder session ${shortId}?`);
    if (shouldResume) {
      resumeId = lastSessionId;
      console.log(`Resuming session ${shortId}`);
    }
  }

  const isResuming = resumeId !== null;

  // Session disclosure — skip on resume (user already saw it in the original session)
  if (!isResuming) {
    const agentName = config.agent.agent_id === 'claude-code' ? 'Claude Code' : config.agent.agent_id;
    const firstRun = await isFirstBuilderRun(root);

    console.log(`Launching ${agentName} in a new session with lazy's system prompt.`);

    // Warn about prompt injection risk when running on host without isolation
    if (runner.type === 'dangerously-host-process-without-any-isolation') {
      console.log('');
      console.log('WARNING: Builder is running on the host without isolation.');
      console.log('Agent output may contain prompt injection from untrusted sources.');
      console.log('Configure [runner] type = "docker" in lazy.toml for safe-by-default execution.');
    }

    if (isTTY()) {
      if (firstRun) {
        console.log('');
        console.log('This is your first time running lazy builder. We recommend reviewing the');
        console.log('system prompt to understand what instructions the agent will receive.');
        const response = await promptLine("Press 'v' to view system prompt, or Enter to continue");
        if (response.toLowerCase() === 'v') {
          console.log('');
          console.log('--- System Prompt ---');
          console.log(systemPrompt);
          console.log('--- End System Prompt ---');
          console.log('');
          await promptLine('Press Enter to continue');
        }
      } else {
        const response = await promptLine("(press 'v' to view system prompt, or Enter to continue)");
        if (response.toLowerCase() === 'v') {
          console.log('');
          console.log('--- System Prompt ---');
          console.log(systemPrompt);
          console.log('--- End System Prompt ---');
          console.log('');
          await promptLine('Press Enter to continue');
        }
      }
    }
  }

  await markBuilderRun(root);

  // Ensure runner infrastructure is ready (builds Docker image if needed)
  await runner.ensureReady();

  // Resolve builder effort: --effort flag > config.builder.effort (default "high").
  const builderEffort = effortOverride ?? config.builder.effort;

  // Launch the builder child once for a given resume id. The relaunch loop calls
  // this repeatedly: after an upgrade stops the child it re-launches with the
  // resolved --resume id. Each call builds its own args/config so the resume id
  // (and a fresh container) is correct per iteration.
  const launchOnce = async (rid: string | null): Promise<BuilderLaunchResult> => {
    // Add --dangerously-skip-permissions when in autonomous mode,
    // and --resume <id> when resuming a session.
    const claudeExtraArgs = [
      ...(autonomous ? ['--dangerously-skip-permissions'] : []),
      ...(rid ? ['--resume', rid] : []),
      // When Ollama is enabled, force Claude Code to use the Ollama model.
      // Without this, Claude Code defaults to its own model (opus) which doesn't exist in Ollama.
      ...(config.ollama.enabled && config.ollama.model ? ['--model', config.ollama.model] : []),
      '--effort', builderEffort,
    ];

    if (runner.usesSandbox()) {
      // Container mode: use daemon MCP proxy so tool calls route through the daemon.
      // The daemon generates the MCP config (it knows its own webPort and token).
      const { configPath: daemonConfigPath } = await queryDaemonMcpConfig({
        name: `builder-${Date.now()}`,
      });

      // Still need a builder config for conversation capture (the supervisor reads it)
      // but we don't start a separate HTTP server. `id` is this builder's stable
      // identifier — it matches the `lazy-builder-<id>` container name and is how
      // a resume intent written by `lazy upgrade` is keyed.
      const dataDir = config.data.path;
      const { configPath, config: builderConfig, id } = generateBuilderConfig(root, dataDir);
      writeFileSync(configPath, JSON.stringify(builderConfig, null, 2));

      try {
        const result = await runner.launchBuilderInteractive(
          root, systemPrompt, configPath, claudeExtraArgs, undefined, daemonConfigPath,
        );
        return { exitCode: result.exitCode, sessionId: result.sessionId, builderId: id };
      } finally {
        for (const tmpFile of [daemonConfigPath, configPath]) {
          try {
            if (existsSync(tmpFile)) unlinkSync(tmpFile);
          } catch { /* best effort */ }
        }
      }
    } else {
      // Host-process mode: launch Claude Code directly (no HTTP server needed).
      // The runner handles conversation capture internally. There is no container
      // for upgrade to stop, so builderId is null — the loop never relaunches.
      const result = await runner.launchBuilderInteractive(root, systemPrompt, '', claudeExtraArgs);
      return { exitCode: result.exitCode, sessionId: result.sessionId, builderId: null };
    }
  };

  // Supervised relaunch loop: in docker/podman mode, an upgrade can stop the
  // builder container mid-session and leave a durable resume intent. When it
  // does, wait for the upgrade to finish and re-launch --resume into THIS
  // terminal. In host-process mode (canRelaunch=false) the loop runs exactly
  // once — upgrade does not stop host builders, so there is nothing to relaunch.
  const loopResult = await runBuilderRelaunchLoop({
    initialResumeId: resumeId,
    canRelaunch: runner.usesSandbox(),
    projectRoot: root,
    launch: launchOnce,
    // Re-resolve storage per access so a fresh daemon token is used after the
    // upgrade restarts the daemon. Returns null (not exit) when unavailable so a
    // normal builder quit is never turned into an error by a daemon hiccup.
    getStorage: () => tryRemoteStorage(root),
    daemonStatus: () => checkDaemonHealth(root),
    ensureReady: () => runner.ensureReady(),
    log: (m) => console.log(m),
    errorOut: (m) => console.error(m),
  });

  // Print the session ID so the user can resume later (suppressed when the loop
  // already printed an actionable manual-resume fallback).
  if (loopResult.sessionId) {
    console.log('');
    console.log(`Session: ${loopResult.sessionId}`);
    console.log(`Resume:  lazy builder --resume ${loopResult.sessionId}`);
  }

  process.exit(loopResult.exitCode);
}

export function builderUsage(): void {
  console.log(`Usage: lazy builder [list | --resume [id]]

Launch an interactive Claude Code session with Lazy builder instructions.

This starts Claude Code with the Lazy system prompt injected via --append-system-prompt.
Your CLAUDE.md is untouched — Lazy's orchestration instructions are appended to the system
prompt, not written to any file.

The host's ~/.claude/ directory is shared with the container, so Claude Code settings,
credentials, and conversation history are available. Conversations are captured
into lazy's store so they're searchable alongside task data.

Subcommands:
  list, ls             List captured builder conversations

Resume options:
  --resume             Resume the session from LAZY_LAST_SESSION_ID
  --resume <id>        Resume a specific session by Claude session ID

When a builder session exits, the session ID is printed so you can resume it
with --resume <id>. Set LAZY_LAST_SESSION_ID in your shell to enable bare
--resume and the interactive resume prompt.

The interactive system prompt warning is automatically skipped when resuming.

Auto-resume across upgrade (docker/podman only):
  If 'lazy upgrade' stops this builder to rebuild the image, the session is
  automatically relaunched in place — same conversation, same terminal — once
  the upgrade finishes; no manual --resume needed. (Host-process builders are
  not stopped by upgrade, so there is nothing to relaunch there.) Finish typing
  any in-progress message before upgrading: unsent input cannot be recovered.
  If the relaunch can't complete, the command prints the exact
  'lazy builder --resume <id>' to run.

Flags:
  --autonomous         Run without permission prompts (adds --dangerously-skip-permissions)
  --yes                Auto-confirm prompts (required with --autonomous in non-TTY mode)
  --effort <level>     Claude Code reasoning effort (low, medium, high, xhigh, max)
                       Defaults to lazy.toml [builder].effort (default "high")

Examples:
  lazy builder                    # Start new session
  lazy builder --resume <uuid>    # Resume a specific session
  lazy builder --resume           # Resume from LAZY_LAST_SESSION_ID
  lazy builder list               # List captured conversations
  lazy builder --autonomous       # Run without permission prompts`);
}
