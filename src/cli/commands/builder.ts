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
import { resolveRoleTarget, isKnownAnthropicModel, KNOWN_ANTHROPIC_SHORT_NAMES } from '../../utils/role-target';
import { isTTY, promptLine } from '../editor';
import { getProjectName } from '../../storage';
import { theme } from '../theme';
import { createRunner, refreshRunnerProxyTargets, type Runner } from '../../runner';
import { buildBuilderPermissionArgs } from '../../runner/host-sandbox';
import { generateBuilderConfig } from '../../builder/server';
import { queryDaemonMcpConfig, queryConcurrency } from '../../daemon/rpc-fallback';
import { checkDaemonHealth } from '../../daemon/lifecycle';
import { runBuilderRelaunchLoop, type BuilderLaunchResult } from '../../builder/relaunch';
import { revokeBuilderMcpToken } from '../../builder/mcp-session';
import { startBuilderMcpReissueWatcher } from '../../builder/mcp-reissue';
import {
  resolveBuilderProjectsDirForLaunch,
  isTrustedResumeProjectsDir,
  classifyResumeSession,
  type BuilderLaunchProjects,
} from '../../builder/projects-isolation';
import { detectBuilderLaunchSessionId } from '../../builder/session-detect';
import { ensureBuilderScratchDir } from '../../builder/scratch';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import { resolveBuilderChattiness, renderChattinessSnippet } from '../../config/chattiness';
import { buildMemorySection } from '../../memory';

// Embedded at build/compile time — changes to these files require rebuild
import lazySystemPrompt from '../../prompts/builder-system-prompt.md' with { type: 'text' };
import modelGuidance from '../../prompts/model-guidance.md' with { type: 'text' };

async function buildSystemPrompt(lazyRoot: string, runner: Runner): Promise<string> {
  const config = await loadConfig(lazyRoot);

  // Inject runner-specific instructions into the template
  const runnerInstructions = runner.getBuilderInstructions().trimEnd();
  let prompt = lazySystemPrompt.replace('{{RUNNER_INSTRUCTIONS}}', runnerInstructions);

  // Inject the verbosity snippet near the top (placeholder sits right after the
  // intro). Empty when unset, so the placeholder collapses to nothing.
  const chattinessSnippet = renderChattinessSnippet(resolveBuilderChattiness(config));
  prompt = prompt.replace('{{CHATTINESS}}', chattinessSnippet ? chattinessSnippet + '\n\n' : '');
  prompt = prompt.trimEnd();

  // Auto-inject the shared-memory index (see src/memory). Empty when the
  // project has no records, so nothing is appended until there is something to
  // recall. Storage is opened just for this read and closed immediately.
  const storage = await requireStorage();
  try {
    const memorySection = await buildMemorySection(storage, 'builder', { warnBytes: config.memory.warn_bytes });
    if (memorySection) {
      prompt += '\n\n' + memorySection;
    }
  } finally {
    await storage.close();
  }

  if (await hasExplicitModelConfig(lazyRoot)) {
    // User configured a default model — tell builder to respect it
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
    { name: 'import', takesValue: false },
    { name: 'effort', takesValue: true },
    { name: 'model', takesValue: true },
  ];
  const parsed = parseFlags(args, BUILDER_FLAGS, 'builder');
  const autonomous = parsed.flags.get('autonomous') === true;
  const yes = parsed.flags.get('yes') === true;
  const resumeArg = parsed.flags.get('resume') ?? null;
  const importSession = parsed.flags.get('import') === true;

  if (importSession && resumeArg === null) {
    console.error('--import only applies to a resume: use it as `lazy builder --resume <id> --import`.');
    process.exit(1);
  }

  // --model overrides which model the BUILDER itself runs as (distinct from the
  // per-task --model used when starting tasks). No allow-list validation: new
  // models ship faster than we can hard-code them, so pass through whatever the
  // user gives. An empty value is rejected so we never append a dangling --model.
  let modelOverride: string | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    if (modelValue.trim() === '') {
      console.error('Invalid --model: a model id is required, e.g. --model mythos');
      process.exit(1);
    }
    modelOverride = modelValue.trim();
  }

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

    // Additional warning for host-process runner — severity depends on posture.
    if (runner.type === 'dangerously-host-process-without-any-isolation') {
      if (config.runner.permission_mode === 'bypass') {
        console.log('⚠ DANGER: Running on the host WITHOUT isolation (permission_mode = "bypass").');
        console.log('  The agent has unrestricted access to your system.');
        console.log('  Only proceed on an isolated/disposable machine.');
      } else {
        console.log('⚠ Running on the host under the OS sandbox (permission_mode = "sandbox").');
        console.log('  Autonomous + sandbox: Bash is confined to the worktree and the');
        console.log(`  network allowlist, but the agent will not prompt before acting.`);
      }
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

  // Concurrency cap: fail fast when the builder limit is reached. An interactive
  // session a human is waiting on must never be silently queued — tell them the
  // count and how to raise the cap. The effective limit comes from the daemon so
  // an ephemeral `lazy daemon config` override is honored. Best-effort: a daemon
  // hiccup must not block launching a builder, so a failed query is non-fatal.
  try {
    const limits = await queryConcurrency();
    if (limits.builders.running >= limits.builders.limit) {
      console.error(
        `Builder limit reached: ${limits.builders.running}/${limits.builders.limit} builder ` +
        `container(s) already running.`,
      );
      console.error('Wait for one to exit, or raise the cap for this daemon session:');
      console.error('  lazy daemon config set max_concurrent_builders <N>');
      console.error('(ephemeral — resets on daemon restart; set [limits] max_concurrent_builders in lazy.toml to persist)');
      process.exit(1);
    }
  } catch (err) {
    // Non-fatal: never block an interactive builder on a limits-query failure.
    if (config.session.debug) {
      console.error(`[DEBUG] builder concurrency check skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  const systemPrompt = await buildSystemPrompt(root, runner);

  // Determine if we're resuming and which session ID to use.
  // Resume source: an explicit --resume <id> and nothing else.
  let resumeId: string | null = null;

  if (resumeArg === true) {
    // Bare --resume: there is no way to infer which session was meant.
    console.error('--resume needs a session ID.');
    console.error('Usage: lazy builder --resume <session-id>');
    console.error('Find session IDs with: lazy builder list');
    process.exit(1);
  } else if (typeof resumeArg === 'string') {
    // Explicit session ID — pass directly to Claude (no storage scanning)
    resumeId = resumeArg;
    console.log(`Resuming session ${resumeId.substring(0, 8)}`);
  }

  const isResuming = resumeId !== null;

  // Per-builder Claude projects-dir isolation lives under the data dir.
  const dataDirAbs = join(root, config.data.path);

  // Gate on ADOPTION before anything expensive or interactive runs. A session with
  // no container-written copy in any overlay has never run under builder isolation
  // — resuming it would silently make an overlay authoritative for it. Make that
  // deliberate: error with the remedy, and let `--import` opt in. Sandbox runners
  // only (host-process has no overlay to adopt into), and only for the id the USER
  // asked for — the relaunch loop resolves its own ids and must never hit this.
  if (resumeId && runner.usesSandbox() && !importSession) {
    const provenance = await classifyResumeSession({ dataDirAbs, lazyRoot: root, resumeId });
    if (provenance === 'needs-import') {
      console.error(`Session ${resumeId} exists, but has never run under lazy's builder isolation.`);
      console.error('Resuming it here would adopt it into this project\'s builder session history.');
      console.error('');
      console.error(`Adopt it deliberately:  lazy builder --resume ${resumeId} --import`);
      console.error('Or pick a session that already ran under lazy: lazy builder list');
      process.exit(1);
    }
  }

  // Session disclosure — skip on resume (user already saw it in the original session)
  if (!isResuming) {
    const agentName = config.agent.agent_id === 'claude-code' ? 'Claude Code' : config.agent.agent_id;
    const firstRun = await isFirstBuilderRun(root);

    console.log(`Launching ${agentName} in a new session with lazy's system prompt.`);

    // Warn about prompt injection risk when running on the host.
    if (runner.type === 'dangerously-host-process-without-any-isolation') {
      console.log('');
      if (config.runner.permission_mode === 'bypass') {
        console.log('WARNING: Builder is running on the host with NO sandbox (permission_mode = "bypass").');
        console.log('Agent output may contain prompt injection from untrusted sources.');
        console.log('Use permission_mode = "sandbox" (default) or [runner] type = "docker" for safe-by-default execution.');
      } else {
        console.log('Builder is running on the host under the OS sandbox (permission_mode = "sandbox").');
        console.log('Bash is confined to the worktree and the network allowlist; you will be');
        console.log('prompted before any command escapes the sandbox.');
      }
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

  // Builder scratch dir: the one writable place the builder has outside the
  // repo, at a path the human can open directly. Created before launch so the
  // path we print (and hand Claude Code via --add-dir) always exists. Both
  // runners resolve it with the same helper. See src/builder/scratch.ts.
  const scratchDir = await ensureBuilderScratchDir(root);
  console.log('');
  console.log(`Scratch dir (writable, outside the repo, readable by you at this path):`);
  console.log(`  ${scratchDir}`);

  // Ensure runner infrastructure is ready (builds Docker image if needed)
  await runner.ensureReady();

  // Resolve builder effort: --effort flag > config.builder.effort (default "high").
  const builderEffort = effortOverride ?? config.builder.effort;

  // Per-builder Claude projects-dir isolation is resolved PER LAUNCH (see below),
  // not once up front: the relaunch loop re-launches with a resolved `--resume
  // <id>` after an upgrade, and the mounted dir must be the one that actually
  // holds THAT session — the same lookup a manual `lazy builder --resume <id>`
  // performs. Resolving once and reusing the dir was the auto-resume bug (Claude
  // printed "No conversation found with session ID"). Isolation is docker/podman
  // only (host-process can't isolate the real host home) and self-healing: the
  // helper degrades to the shared dir rather than blocking the launch.

  // Launch the builder child once for a given resume id. The relaunch loop calls
  // this repeatedly: after an upgrade stops the child it re-launches with the
  // resolved --resume id. Each call resolves its OWN projects dir + args/config
  // so the resume id (and the dir that holds it) is correct per iteration.
  //
  // Permission posture for the builder launch.
  //   - Host runner: default "sandbox" mode enables Claude Code's OS sandbox via
  //     --settings. Interactive builders prompt on a sandbox escape; --autonomous
  //     opts into sandbox + bypass (never prompts). "bypass" config = full
  //     --dangerously-skip-permissions, no sandbox (previous behavior).
  //   - Docker/Podman: the container is the boundary, so only --autonomous adds
  //     --dangerously-skip-permissions (inside the container).
  const isHostRunner = runner.type === 'dangerously-host-process-without-any-isolation';
  const builderPermissionArgs = isHostRunner
    ? buildBuilderPermissionArgs(
        {
          mode: config.runner.permission_mode,
          allowedDomains: config.runner.sandbox_allowed_domains,
          allowWeakerNested: config.runner.sandbox_allow_weaker_nested,
          denyRead: config.runner.sandbox_deny_read,
          denyWrite: config.runner.sandbox_deny_write,
        },
        autonomous,
      )
    : (autonomous ? ['--dangerously-skip-permissions'] : []);

  const launchOnce = async (rid: string | null): Promise<BuilderLaunchResult> => {
    // Locate the projects dir that holds this launch's resume target (or the
    // shared dir when the session lives there). undefined outside sandbox mode.
    // Pair it with a trustWritable signal so the runner can mount a known-writable
    // resume dir even if the write-probe transiently fails (see docker-runner):
    // trust ONLY a dir that holds a container-written copy of the resume target,
    // never a host-seeded copy.
    // `adopt` applies ONLY to the id the user passed --import for; ids the relaunch
    // loop resolves on its own already have a container-written copy.
    const hostDir = runner.usesSandbox()
      ? await resolveBuilderProjectsDirForLaunch({
          dataDirAbs,
          lazyRoot: root,
          resumeId: rid,
          adopt: importSession && rid !== null && rid === resumeId,
        })
      : undefined;
    const projects: BuilderLaunchProjects | undefined = hostDir
      ? { hostDir, trustWritable: await isTrustedResumeProjectsDir({ hostDir, lazyRoot: root, resumeId: rid }) }
      : undefined;
    // Permission/sandbox flags first (see builderPermissionArgs above), then
    // --resume <id>, then the resolved model and effort.
    //
    // Resolve the builder's model via the per-role target. The explicit --model
    // flag is a hard override: it wins over a configured model on EVERY backend,
    // including ollama/proxy, while the backend+endpoint (the "server") stay as
    // configured — so `lazy builder --model X` runs model X against whatever
    // server the role points at. Without the flag, a local backend keeps forcing
    // its authoritative model. An empty result means "omit --model" so Claude
    // Code uses its own default — we resolve to a single value here so we never
    // append two --model args to the Claude Code child (which would be ambiguous).
    const builderTarget = resolveRoleTarget('builder', config, { overrideModel: modelOverride });
    // An explicit --model that resolves to the anthropic backend (no local server
    // configured for this role) must be a model the Anthropic API can actually
    // serve. Reject an unrecognized name up front instead of handing it to Claude
    // Code and failing opaquely at runtime. `claude-*` is the escape hatch for
    // models newer than our known list; to run anything else (e.g. a local model),
    // configure a server in lazy.toml [models.roles.builder].
    if (modelOverride && builderTarget.backend === 'anthropic' && !isKnownAnthropicModel(modelOverride)) {
      console.error(
        `Unknown --model "${modelOverride}". lazy recognizes Anthropic models ` +
        `(claude-*, or ${KNOWN_ANTHROPIC_SHORT_NAMES.join('/')}). To run a different model, ` +
        `configure a local server in lazy.toml [models.roles.builder] ` +
        `(backend = "ollama" or "proxy", with an endpoint).`,
      );
      process.exit(1);
    }
    const resolvedModel = builderTarget.model || undefined;

    const claudeExtraArgs = [
      ...builderPermissionArgs,
      // Make the scratch dir a workspace dir so Claude Code's file tools (and,
      // on the host runner, the OS sandbox) can write there — the repo/worktree
      // is otherwise the only writable workspace. The path is identical inside
      // a container because the mount uses the host path.
      '--add-dir', scratchDir,
      ...(rid ? ['--resume', rid] : []),
      ...(resolvedModel ? ['--model', resolvedModel] : []),
      '--effort', builderEffort,
    ];

    if (runner.usesSandbox()) {
      // Container mode: use daemon MCP proxy so tool calls route through the daemon.
      // The daemon generates the MCP config (it knows its own webPort and token).
      //
      // Order matters: the builder config is generated FIRST because its `id` is
      // what keys the MCP identity label below. `id` is this builder's stable
      // identifier — it matches the `lazy-builder-<id>` container name and is how
      // a resume intent written by `lazy upgrade` is keyed. (We still need a
      // builder config for conversation capture — the supervisor reads it — but
      // we don't start a separate HTTP server.)
      const dataDir = config.data.path;
      const { configPath, config: builderConfig, id } = generateBuilderConfig(root, dataDir);
      writeFileSync(configPath, JSON.stringify(builderConfig, null, 2));

      // This builder session's MCP identity label: the daemon binds the minted
      // token to it, and we hand it back on exit to revoke that token (see
      // revokeBuilderMcpToken). Keep it in a const — a second computation would
      // be a different, unrevokable label.
      //
      // Keyed on `id`, NOT on the clock. `builder-${Date.now()}` collided
      // whenever two builders launched in the same millisecond: mintMcpToken
      // reuses by identity key, so both got the same token and both worked —
      // until the first one exited and revoked the shared label out from under
      // the one still running, costing it every lazy_* tool for the rest of its
      // session. `id` is a random uuid slice drawn per launch, so it does not
      // degenerate under concurrency the way a clock reading does, and it is the
      // same value the mounted ~/.claude.json is keyed on.
      const daemonMcpName = `builder-${id}`;
      const { configPath: daemonConfigPath } = await queryDaemonMcpConfig({
        name: daemonMcpName,
        // This process is the builder session's owner: it lives exactly as long
        // as the session does, and revokes the token on the way out. Telling the
        // daemon our pid is what lets it evict dead builders' tokens ahead of
        // ours when the registry's builder cap trips — before, the OLDEST token
        // went first, which preferentially disarmed the longest-running live
        // builder (every lazy_* tool gone, silently, mid-session).
        ownerPid: process.pid,
      });

      // Stamp the launch instant BEFORE the container starts: it is the cut that
      // separates this run's session files from everything already on disk
      // (including the history seeded into the projects dir above).
      const launchedAtMs = Date.now();

      // Watch for a restarted daemon for as long as this builder runs. A daemon
      // that comes back without our token record (registry moved by an upgrade,
      // cleared by a repair, label evicted) would otherwise 401 every lazy tool
      // for the rest of the session, with "relaunch the builder" as the only
      // remedy. The watcher asks for a credential again under THIS session's own
      // label — same identity, same revoke-on-exit — and the daemon rewrites the
      // mounted config in place. See src/builder/mcp-reissue.ts.
      const mcpReissue = startBuilderMcpReissueWatcher({
        name: daemonMcpName,
        projectRoot: root,
      });

      try {
        const result = await runner.launchBuilderInteractive(
          root, systemPrompt, configPath, claudeExtraArgs, undefined, daemonConfigPath, projects,
        );
        // In docker mode the runner always reports `sessionId: null` — only the
        // in-container supervisor sees the id, and it can only stamp it when it
        // gets to run its exit path. Recover it host-side from the session JSONL
        // the container wrote into the mounted projects dir, so the id survives
        // ANY death (upgrade stop, docker kill, crash, OOM) and the relaunch loop
        // has something concrete to resume. See src/builder/session-detect.ts.
        const sessionId = result.sessionId ?? await detectBuilderLaunchSessionId({
          lazyRoot: root,
          projectsHostDir: hostDir,
          launchedAtMs,
          resumeId: rid,
        });
        return { exitCode: result.exitCode, sessionId, builderId: id };
      } finally {
        // The builder supervisor has exited (normally, by upgrade-stop, or by
        // throwing) — its token must die with the session. Stop asking for
        // credentials BEFORE revoking, so a re-issue can never race the revoke
        // and leave a live token behind a dead session. Best effort: a crashed
        // daemon must never break builder exit.
        await mcpReissue.stop();
        await revokeBuilderMcpToken(daemonMcpName);
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
    // The daemon restarted during the upgrade and its proxy port is OS-assigned,
    // so the address `createRunner` stamped on this runner at startup is dead.
    // Re-resolve it against the daemon now serving, or fail loud.
    refreshProxyTarget: () => refreshRunnerProxyTargets(runner, root),
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
  console.log(`Usage: lazy builder [list | --resume <id>]

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
  --resume <id>        Resume a specific session by Claude session ID
  --import             Adopt a session that has never run under lazy's builder
                       isolation (use with --resume <id>; without it such a
                       resume errors instead of adopting silently)

When a builder session exits, the session ID is printed so you can resume it
with --resume <id>. Use 'lazy builder list' to look up an earlier session ID.

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
  --autonomous         Run without permission prompts. Under the host sandbox (default) the
                       OS sandbox still confines the builder; under permission_mode="bypass"
                       or Docker this adds --dangerously-skip-permissions.
  --yes                Auto-confirm prompts (required with --autonomous in non-TTY mode)
  --effort <level>     Claude Code reasoning effort (low, medium, high, xhigh, max)
                       Defaults to lazy.toml [builder].effort (default "high")
  --model <id>         Override the model the builder itself runs as (passed
                       straight through to Claude Code's --model; no allow-list,
                       so brand-new models work). Takes precedence over the
                       Ollama-injected model. This is the BUILDER's model, not
                       the per-task --model used when starting tasks.

Examples:
  lazy builder                    # Start new session
  lazy builder --resume <uuid>    # Resume a specific session
  lazy builder list               # List captured conversations
  lazy builder --autonomous       # Run without permission prompts
  lazy builder --model mythos     # Run the builder on a specific model`);
}
