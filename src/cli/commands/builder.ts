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
import { homedir } from 'os';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { requireLazyRoot } from '../helpers';
import { loadConfig, hasExplicitModelConfig } from '../../config/loader';
import { isTTY, promptLine } from '../editor';
import { createStorage, getProjectName } from '../../storage';
import { theme } from '../theme';
import { createRunner, type Runner } from '../../runner';
import { generateBuilderConfig, startBuilderServer } from '../../builder/server';

// Embedded at build/compile time — changes to these files require rebuild
import lazySystemPrompt from '../../prompts/builder-system-prompt.md' with { type: 'text' };
import modelGuidance from '../../prompts/model-guidance.md' with { type: 'text' };

function buildSystemPrompt(lazyRoot: string, runner: Runner): string {
  // Inject runner-specific instructions into the template
  const runnerInstructions = runner.getBuilderInstructions().trimEnd();
  let prompt = lazySystemPrompt.replace('{{RUNNER_INSTRUCTIONS}}', runnerInstructions).trimEnd();

  if (hasExplicitModelConfig(lazyRoot)) {
    // User configured a default model — tell builder to respect it
    const config = loadConfig(lazyRoot);
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
function builderMarkerDir(root: string): string {
  const projectName = getProjectName(root);
  return join(homedir(), '.lazy', projectName);
}

/**
 * Check if this is the first time builder has been run for this project.
 * Uses a marker file in ~/.lazy/<project>/ to track.
 */
function isFirstBuilderRun(root: string): boolean {
  const markerPath = join(builderMarkerDir(root), '.builder-launched');
  return !existsSync(markerPath);
}

function markBuilderRun(root: string): void {
  const markerDir = builderMarkerDir(root);
  if (!existsSync(markerDir)) {
    mkdirSync(markerDir, { recursive: true });
  }
  writeFileSync(join(markerDir, '.builder-launched'), new Date().toISOString());
}

// --- Subcommand: list ---

async function commandBuilderList(lazyRoot: string): Promise<void> {
  const storage = await createStorage(lazyRoot);

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

// --- Main command ---

export async function commandBuilder(args: string[]): Promise<void> {
  const root = requireLazyRoot();

  // Handle subcommands before launching Claude
  const subcommand = args[0];
  if (subcommand === 'list' || subcommand === 'ls') {
    await commandBuilderList(root);
    return;
  }

  // Extract --autonomous and --yes flags, pass through everything else to Claude Code
  let autonomous = false;
  let yes = false;
  const claudeExtraArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--autonomous') {
      autonomous = true;
    } else if (arg === '--yes') {
      yes = true;
    } else {
      // Pass through all other args to Claude Code
      claudeExtraArgs.push(arg);
    }
  }

  // Create the runner — determines Docker vs host-process mode
  const runner = createRunner(root);
  const config = loadConfig(root);

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
    runner.checkAvailability();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(root, runner);

  // Session disclosure
  const agentName = config.agent.agent_id === 'claude-code' ? 'Claude Code' : config.agent.agent_id;
  const firstRun = isFirstBuilderRun(root);

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

  markBuilderRun(root);

  // Ensure runner infrastructure is ready (builds Docker image if needed)
  await runner.ensureReady();

  // Add --dangerously-skip-permissions when in autonomous mode
  const finalClaudeExtraArgs = autonomous
    ? [...claudeExtraArgs, '--dangerously-skip-permissions']
    : claudeExtraArgs;

  let exitCode: number;

  if (runner.usesSandbox()) {
    // Container mode (Docker/Podman): start an HTTP server on localhost for tool calls.
    // The supervisor inside the container connects via host.docker.internal.
    const dataDir = config.data.path;
    const { configPath, config: builderConfig } = generateBuilderConfig(root, dataDir);
    const { cleanup: cleanupServer } = startBuilderServer(builderConfig, configPath);

    try {
      exitCode = await runner.launchBuilderInteractive(root, systemPrompt, configPath, finalClaudeExtraArgs);
    } finally {
      cleanupServer();
      try {
        if (existsSync(configPath)) {
          unlinkSync(configPath);
        }
      } catch {
        // Best effort
      }
    }
  } else {
    // Host-process mode: launch Claude Code directly (no HTTP server needed).
    // The runner handles conversation capture internally.
    exitCode = await runner.launchBuilderInteractive(root, systemPrompt, '', finalClaudeExtraArgs);
  }

  process.exit(exitCode);
}

export function builderUsage(): void {
  console.log(`Usage: lazy builder [list | claude-args...]

Launch an interactive Claude Code session with Lazy builder instructions.

This starts Claude Code with the Lazy system prompt injected via --append-system-prompt.
Your CLAUDE.md is untouched — Lazy's orchestration instructions are appended to the system
prompt, not written to any file.

The host's ~/.claude/ directory is shared with the container, so Claude Code settings,
credentials, and conversation history are available. Conversations are captured
into lazy's store so they're searchable alongside task data.

Subcommands:
  list, ls             List captured builder conversations

Flags:
  --autonomous         Run without permission prompts (adds --dangerously-skip-permissions)
  --yes                Auto-confirm prompts (required with --autonomous in non-TTY mode)

Any other arguments are passed through to claude.

Examples:
  lazy builder                    # Start new session
  lazy builder list               # List captured conversations
  lazy builder --model opus       # Start with a specific model
  lazy builder --autonomous       # Run without permission prompts`);
}
