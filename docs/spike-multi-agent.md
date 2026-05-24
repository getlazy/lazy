# Multi-Agent Support: Design Document

This document is the output of `spike-multi-agent`. It covers:
1. An audit of the current Claude Code coupling
2. Research on Cursor CLI and OpenAI Codex CLI
3. A proposed Agent abstraction
4. Detailed refactoring instructions

---

## Phase 1: Audit of Current Agent Layer

### What `src/capture/claude.ts` Does

This 1041-line file is the heart of the agent layer. It contains:

| Function | Lines | Purpose | Agent-specific? |
|---|---|---|---|
| `getModelId()` | 55-62 | Maps `ModelName` → Claude model IDs | **Yes** — hard-coded Claude model versions |
| `checkDocker()` | 64-75 | Validates Docker is running | No — infrastructure |
| `getDockerfileContent()` | 116-134 | Resolves Dockerfile (custom/toolchain/default) | **Partially** — `DEFAULT_DOCKERFILE` installs `claude-code@latest` |
| `calculateDockerfileHash()` | 136-139 | Hashes Dockerfile for cache invalidation | No — infrastructure |
| `resolveImageName()` | 146-159 | Determines Docker image name | No — infrastructure |
| `buildImage()` | 175-229 | Builds Docker image | No — infrastructure |
| `ensureImage()` | 235-254 | Ensures Docker image is up to date | No — infrastructure |
| `ensureAgentBinary()` | 358-451 | Builds/extracts `lazy-agent` binary | **Partially** — binary name hard-coded |
| `hasAuthEnv()` / `getAuthEnv()` | 481-497 | Reads `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | **Yes** — Claude/Anthropic-specific env vars |
| `buildDockerArgs()` | 499-515 | Builds Docker run args | **Yes** — mounts `.claude/` dir, passes Claude env |
| `runClaude()` | 517-579 | Synchronous one-shot Claude execution | **Yes** — builds `claude -p` command line |
| `resumeClaude()` | 581-645 | Resume a Claude session | **Yes** — uses `--resume` flag |
| `extractTokenUsage()` | 650-657 | Parses token usage from response | **Yes** — Claude-specific usage format |
| `launchClaudeAsync()` | 693-737 | Launch Claude in detached container | **Yes** |
| `resumeClaudeAsync()` | 743-789 | Resume Claude in detached container | **Yes** |
| Container management (795-943) | Various | `isContainerRunning`, `containerExists`, `getContainerInfo`, etc. | No — infrastructure |
| `containerNameForTask()` | 941-943 | Generate container name | No — infrastructure |
| `buildSupervisorWrapperScript()` | 961-979 | PID 1 wrapper for supervisor | **Partially** — references `lazy-agent` |
| `launchSupervisorAsync()` | 990-1040 | Launch supervisor in Docker | **Partially** — passes Claude auth env |

### Complete Inventory of Claude-Specific Assumptions

#### 1. Type Definitions

| Location | What | Classification |
|---|---|---|
| `src/types/index.ts:25` | `ModelName = 'sonnet' \| 'opus' \| 'haiku'` | Claude-specific model names |
| `src/types/index.ts:59` | `Session.claude_session_id: string \| null` | Claude-specific session tracking |
| `src/types/index.ts:154-163` | `ClaudeResponse` interface | Claude-specific response format |

#### 2. CLI Flags and Binary Names

| Location | What | Classification |
|---|---|---|
| `src/supervisor/work.ts:76` | `['claude', '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions']` | Claude Code CLI invocation |
| `src/supervisor/work.ts:79` | `'--append-system-prompt'` | Claude Code-specific flag |
| `src/supervisor/work.ts:83` | `'--resume', claudeSessionId` | Claude Code session resume |
| `src/capture/claude.ts:530-534` | Same `claude -p` pattern | Duplicated in sync path |
| `src/runner/host-process-runner.ts:258-261` | Same `claude -p` pattern | Duplicated again |
| `src/supervisor/builder.ts:88-92` | `['claude', '--append-system-prompt', ...]` | Builder interactive launch |

#### 3. Authentication

| Location | What | Classification |
|---|---|---|
| `src/capture/claude.ts:481-497` | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | Claude/Anthropic auth env vars |
| Docker arg builders (lines 500, 671, 1002) | Auth passed as `-e` to container | Agent auth passthrough |

#### 4. Model Mapping

| Location | What | Classification |
|---|---|---|
| `src/capture/claude.ts:55-62` | `getModelId()` — maps sonnet→`claude-sonnet-4-5-20250929`, etc. | Hard-coded Claude model versions |
| `src/config/loader.ts:38` | `default: 'sonnet'` | Default model is Claude-specific |
| `src/config/types.ts:59-61` | `models.default: ModelName` | Type constrains to Claude models |

#### 5. Sandbox and Path Assumptions

| Location | What | Classification |
|---|---|---|
| `src/capture/claude.ts:507` | `-v ${sandbox.sandboxPath}/.claude:/home/user/.claude` | Claude's config directory |
| `src/capture/claude.ts:16` | `import embeddedAgentBinaryPath from '../../lazy-agent'` | Binary name |
| `src/runner/docker-runner.ts:184-186` | `supervisorToolChecks()` — checks for `claude` and `lazy-agent` on PATH | Claude binary assumptions |
| `src/runner/host-process-runner.ts:162-173` | `checkAvailability()` — runs `claude --version` | Claude binary on PATH |
| `src/cli/commands/pair.ts:33-37` | Reads `.claude/projects/` JSONL session files | Claude session file layout |
| `src/import/claude-code-logs.ts` | Parses `~/.claude/projects/` JSONL files | Claude conversation format |

#### 6. Response Parsing and Error Handling

| Location | What | Classification |
|---|---|---|
| `src/supervisor/work.ts:51-63` | `isPromptTooLongError()`, `isSessionNotFoundError()` | Claude-specific error messages |
| `src/supervisor/work.ts:146-156` | Expects `{ result, session_id, usage }` JSON | Claude response schema |
| `src/capture/claude.ts:578` | `JSON.parse(output) as ClaudeResponse` | Same schema assumption |

#### 7. Session ID Propagation

The `claude_session_id` field flows through ~15 files:
- `src/types/index.ts` (Session type)
- `src/storage/file-storage.ts` (persistence)
- `src/supervisor/index.ts` (supervisor loop)
- `src/cli/commands/resume.ts`, `unblock.ts`, `status.ts`, `shared.ts`, `upgrade.ts`, `reopen.ts`
- `src/utils/auto-resume.ts`, `reconcile.ts`
- `src/protocol/types.ts`

#### 8. What's Already Agent-Generic

Good news — some infrastructure is already abstracted:

| Component | Status |
|---|---|
| `Runner` interface (`src/runner/types.ts`) | Abstracts container vs process lifecycle |
| Docker image management | Infrastructure, not agent-specific |
| Worktree management | Generic |
| Protocol directory (host↔supervisor communication) | Generic |
| Storage layer | Generic |
| Turn/commit/comment persistence | Generic |

### What Needs to Change (Summary)

| Category | What | Effort |
|---|---|---|
| **New: Agent interface** | Extract agent execution from claude.ts | Medium |
| **New: AgentPackaging interface** | Extract deployment/packaging concerns | Small |
| **Rename: Session field** | `claude_session_id` → `agent_session_id` | Small (mechanical, ~15 files) |
| **Rename: Response type** | `ClaudeResponse` → `AgentResponse` | Small (mechanical, ~6 files) |
| **Extract: Model mapping** | Per-agent model ID resolution with universal monikers | Medium |
| **Extract: Auth** | Per-agent auth env var detection | Small |
| **Parameterize: Dockerfile** | Agent binary installation in Dockerfile | Medium |
| **Parameterize: Docker mounts** | `.claude/` → agent-specific config dir | Small |
| **Extract: CLI flags** | `claude -p` → agent-specific command builder | Medium |
| **Extract: Error patterns** | `isPromptTooLongError` etc. → agent-specific | Small |
| **Extract: Session file parsing** | `import/claude-code-logs.ts` stays but becomes optional | Small |

---

## Phase 2: Cursor CLI Research

### Overview

Cursor provides a CLI binary (`agent` command, installed via `curl https://cursor.com/install -fsS | bash`) with headless capabilities.

### Interface Comparison

| Capability | Claude Code | Cursor CLI |
|---|---|---|
| **Headless mode** | `claude -p "prompt"` | `agent -p "prompt"` |
| **Force file writes** | `--dangerously-skip-permissions` | `--force` / `--yolo` |
| **Output format** | `--output-format json` | `--output-format json` |
| **Model selection** | `--model <model>` | `--model <model>` |
| **Session resume** | `--resume <session_id>` | `--resume [chatId]` |
| **System prompt** | `--append-system-prompt` | Not documented |
| **Auth env var** | `ANTHROPIC_API_KEY` | `CURSOR_API_KEY` |
| **MCP support** | Yes | Yes (CLI), No (background agents) |
| **Workspace trust** | N/A | `--trust` flag needed |
| **MCP auto-approve** | N/A | `--approve-mcps` |

### JSON Output Format

Cursor emits the same structure as Claude Code in `--output-format json` mode:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1234,
  "result": "<assistant text>",
  "session_id": "<uuid>"
}
```

This is extremely convenient — with minor mapping, the same `AgentResponse` type works.

### Authentication

Two methods:
1. **Browser OAuth**: `agent login` → stored locally
2. **API key**: `CURSOR_API_KEY` env var or `--api-key` flag

Cursor routes all requests through their infrastructure using your Cursor subscription. No bring-your-own-model-key option.

### Known Issues

1. **Hanging bug**: The CLI sometimes hangs after completing in `-p` mode, requiring Ctrl-C. This is the biggest risk for production automation — lazy's supervisor would need a timeout-and-kill mechanism.
2. **No `--append-system-prompt`**: System instructions must be prepended to the prompt text. Less clean but workable.
3. **MCP headless bugs**: MCP skills from known locations may not load in headless mode.
4. **Coarse permission control**: `--force` is all-or-nothing (unlike Claude's `--allowedTools`).

### Background Agent API (Alternative Path)

Cursor also has a REST API for cloud-based background agents (`POST /v0/agents`). These run on Cursor's infrastructure, support GitHub integration, but **do not support MCP** and require Privacy Mode disabled. This could be a future "cloud agent" mode but is architecturally different from local execution.

### Assessment for Lazy Integration

**Feasibility: Medium-High.** The CLI interface is remarkably similar to Claude Code's. The main risks are the hanging bug and the lack of system prompt support.

**Recommended approach**: The general watchdog timer (see section 4.7) handles the hanging bug. Prepend system prompt to the user prompt as a workaround for missing `--append-system-prompt`.

---

## Phase 3: OpenAI Codex CLI Research

### Overview

OpenAI Codex CLI is an open-source coding agent (Apache-2.0, `github.com/openai/codex`). Polyglot codebase: Rust core + TypeScript SDK. Installed via `npm install -g @openai/codex` or Homebrew.

### Interface Comparison

| Capability | Claude Code | Codex CLI |
|---|---|---|
| **Headless mode** | `claude -p "prompt"` | `codex exec "prompt"` |
| **Force file writes** | `--dangerously-skip-permissions` | `--full-auto` or `--yolo` |
| **Output format** | `--output-format json` | `--json` (NDJSON events) |
| **Model selection** | `--model <model>` | `--model <model>` or `-m` |
| **Session resume** | `--resume <session_id>` | `codex exec resume <session_id>` |
| **System prompt** | `--append-system-prompt` | `--config developer_instructions="..."` or `AGENTS.md` |
| **Auth env var** | `ANTHROPIC_API_KEY` | `CODEX_API_KEY` |
| **MCP support** | Yes | Yes (consume and serve) |
| **Sandbox modes** | Permissions flags | `--sandbox read-only\|workspace-write\|danger-full-access` |
| **Structured output** | N/A | `--output-schema <schema.json>` |
| **Skip session save** | N/A | `--ephemeral` |

### Output Format Differences

Codex's `--json` mode produces **NDJSON** (newline-delimited JSON events), not a single JSON object. Event types include:

- `thread.started`, `turn.started`, `turn.completed`, `turn.failed`
- `item.started`, `item.updated`, `item.completed` (types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, etc.)

**Without `--json`**, `codex exec` writes progress to stderr and only the final agent message to stdout. This makes the non-JSON mode more easily parseable for simple cases.

The final result does NOT include a unified `{ result, session_id, usage }` JSON blob — session ID is emitted as part of the NDJSON event stream or in the session JSONL log file.

### Session File Layout

Sessions are saved as JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<SESSION_ID>.jsonl`. The `thread.started` NDJSON event contains the session ID. When not using `--json`, the session ID must be recovered from the session directory (see section 4.6 for the recovery algorithm).

### Authentication

Two paths:
1. **ChatGPT subscription**: `codex login` → browser OAuth or `--device-auth`
2. **API key**: `CODEX_API_KEY` env var (only works in `codex exec` mode)

### Session Management

Sessions are automatically persisted as JSONL under `~/.codex/sessions/YYYY/MM/DD/`. Resume via `codex exec resume --last "follow-up"` or by session ID. There's also `codex fork` for branching conversations.

### Sandbox Model

OS-level sandboxing (Landlock/seccomp on Linux, Seatbelt on macOS):
- `read-only` — no writes
- `workspace-write` — writes within workspace only
- `danger-full-access` — no restrictions

In Docker, OS-level sandbox may not work; recommendation is to use `--sandbox danger-full-access` and rely on container isolation.

### SDK Alternative

The Codex SDK (`@openai/codex-sdk`) provides a TypeScript API for programmatic control with thread-based conversation management. This is richer than `codex exec` for complex orchestration. Could be a future integration path.

### Assessment for Lazy Integration

**Feasibility: Medium.** The CLI interface is different from Claude Code's (subcommand-based, NDJSON vs JSON), requiring more adapter work. But the fundamentals are sound — headless mode, session resume, API key auth, and MCP support are all present.

**Key challenges**:
1. Output parsing is more complex (NDJSON stream vs single JSON object)
2. Session ID extraction requires reading session files (see section 4.6)
3. No direct equivalent of `--append-system-prompt` (use `--config developer_instructions` instead)
4. The headless mode has [known limitations](https://github.com/openai/codex/issues/4219) for external orchestration

**Recommended approach**: Use plain-text stdout mode (no `--json`) for v1 — final message goes to stdout, progress to stderr. Recover session ID from session files. Use `--config developer_instructions` for system prompt injection. Use `CODEX_API_KEY` for auth. NDJSON parsing can be added in a future iteration for richer telemetry.

---

## Phase 4: Agent Abstraction Design

### 4.1 Interfaces: Agent and AgentPackaging

The abstraction is split into two interfaces to separate concerns:

- **`Agent`** — the lean execution contract: auth, model resolution, CLI arg building, response parsing, error matching, session file discovery. This is what a new agent implementor needs to know about.
- **`AgentPackaging`** — deployment/infrastructure concerns: Dockerfile generation, npm package name, binary name, tool checks, config directory, health checks. A new agent can be developed and tested without touching this until it's ready for Docker deployment.

```typescript
// src/agent/interface.ts

/**
 * Universal model monikers that work across all agents.
 * Each agent maps these to its own concrete model IDs.
 * Raw model ID strings are also accepted but validated by the agent.
 */
export type ModelMoniker = 'apprentice' | 'journeyman' | 'master';

export interface AgentResponse {
  /** The agent's text response */
  result: string;
  /** Agent-native session ID for resumption (never empty — see per-agent recovery) */
  sessionId: string;
  /** Token usage (normalized across agents; zeros when agent doesn't report) */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
}

/**
 * Core agent contract — execution, parsing, and model resolution.
 *
 * Each agent handles its own limitations internally (e.g., Cursor prepends
 * system prompt to user prompt in buildExecArgs because it lacks
 * --append-system-prompt). Callers do NOT branch on agent capabilities.
 */
export interface Agent {
  readonly id: string;

  /**
   * Get auth environment variables for this agent.
   * Throws if required credentials are not available.
   */
  getAuthEnv(): { key: string; value: string };

  /**
   * Check if auth credentials are available (non-throwing).
   */
  hasAuthEnv(): boolean;

  /**
   * Resolve a model name to the agent's concrete model ID.
   *
   * Accepts universal monikers ('apprentice', 'journeyman', 'master') and
   * agent-specific names. Throws if the name is not recognized — never
   * silently passes through unknown strings.
   */
  resolveModelId(modelName: string): string;

  /**
   * List available model names for this agent. Includes both universal
   * monikers and any agent-specific aliases. Used by CLI help text and
   * `lazy models` to show the user what's valid.
   *
   * Returns entries like:
   *   { name: 'master', modelId: 'claude-opus-4-6', isDefault: false }
   *   { name: 'journeyman', modelId: 'claude-sonnet-4-5-20250929', isDefault: true }
   */
  availableModels(): { name: string; modelId: string; isDefault: boolean }[];

  /**
   * Build the CLI command to run the agent in headless mode.
   * Returns the full argv array.
   *
   * Each agent handles its own quirks internally:
   * - Cursor: prepends system prompt to user prompt (no --append-system-prompt)
   * - Codex: uses `codex exec` subcommand with --config developer_instructions
   * - Claude: uses --append-system-prompt natively
   */
  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
  }): string[];

  /**
   * Parse the agent's stdout output into an AgentResponse.
   *
   * For agents that don't include session ID in stdout (Codex plain-text mode),
   * this method reads session files from disk to recover the session ID.
   * The workingDir parameter tells the agent where to look.
   */
  parseResponse(stdout: string, opts?: { workingDir?: string }): AgentResponse;

  /**
   * Check if an error message indicates the prompt is too long.
   */
  isPromptTooLongError(errorMessage: string): boolean;

  /**
   * Check if an error message indicates the session ID is invalid.
   */
  isSessionNotFoundError(errorMessage: string): boolean;

  /**
   * Discover session log files for conversation capture.
   * Returns file paths that can be parsed for conversation history.
   *
   * Used by `lazy pair` and builder for conversation capture.
   * Returns empty array for agents that don't persist readable session files.
   */
  discoverSessionFiles(opts: {
    sessionId?: string;
    configDir?: string;
  }): string[];
}

/**
 * Packaging and deployment concerns — separate from core execution.
 * A new agent implementor doesn't need to know about Docker to get started.
 */
export interface AgentPackaging {
  readonly agentId: string;

  /** Agent-specific config directory name (e.g., '.claude', '.codex'). */
  configDirName(): string;

  /** NPM package for Dockerfile installation, or empty if installed differently. */
  npmPackage(): string;

  /** CLI binary name (e.g., 'claude', 'agent', 'codex'). */
  binaryName(): string;

  /** Install command for the Dockerfile (some agents use curl, not npm). */
  dockerInstallCommand(): string;

  /** Generate a complete default Dockerfile for this agent. */
  generateDockerfile(): string;

  /** Tool checks the supervisor runs before starting work. */
  supervisorToolChecks(): { cmd: string; name: string; hint: string }[];

  /** Health checks for `lazy doctor`. */
  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[];
}
```

Note: there is no `AgentCapabilities` struct with static boolean flags. Each agent handles its own limitations internally in `buildExecArgs()` and `parseResponse()`. Callers never branch on `if (agent.capabilities.systemPrompt)` — they just pass the system prompt and the agent does the right thing. If a capability truly cannot be supported (e.g., hypothetical future agent that cannot resume sessions at all), the agent throws a clear error at the call site, not a silent no-op.

### 4.2 Universal Model Monikers

Lazy defines three portable model names that work across all agents:

| Moniker | Meaning | Claude Code | Cursor | Codex |
|---|---|---|---|---|
| `apprentice` | Fast, cheap, good for routine tasks | `claude-haiku-4-5-20251001` | Cursor's fastest model | `gpt-5.1-codex-mini` |
| `journeyman` | Balanced — the default for most work | `claude-sonnet-4-5-20250929` | Cursor's default model | `gpt-5.3-codex` |
| `master` | Most capable, for hard problems | `claude-opus-4-6` | Cursor's most capable | `gpt-5.1-codex-max` |

**Resolution rules in `resolveModelId()`**:

1. If the input is a universal moniker (`apprentice`, `journeyman`, `master`), map it to the agent's concrete model ID.
2. If the input is an agent-specific alias (e.g., `sonnet` for Claude Code), map it to the concrete model ID.
3. If the input is not recognized, **throw an error** with a message listing valid names. Never silently pass through unknown strings — this catches typos and prevents sending garbage model IDs to APIs that would fail with confusing errors.

```typescript
// Example: ClaudeCodeAgent.resolveModelId()
resolveModelId(name: string): string {
  const map: Record<string, string> = {
    // Universal monikers
    'apprentice': 'claude-haiku-4-5-20251001',
    'journeyman': 'claude-sonnet-4-5-20250929',
    'master': 'claude-opus-4-6',
    // Agent-specific aliases (backward compat)
    'haiku': 'claude-haiku-4-5-20251001',
    'sonnet': 'claude-sonnet-4-5-20250929',
    'opus': 'claude-opus-4-6',
  };
  const resolved = map[name];
  if (!resolved) {
    const valid = Object.keys(map).join(', ');
    throw new Error(`Unknown model "${name}" for claude-code. Valid models: ${valid}`);
  }
  return resolved;
}
```

**Migration path for `models.default`**:
- Existing `models.default = "sonnet"` continues to work — `sonnet` is a Claude Code-specific alias.
- New portable configs use `models.default = "journeyman"`.
- The config default changes from `'sonnet'` to `'journeyman'` — which resolves to the same model for Claude Code but works across all agents.

**Type changes**:
```typescript
// src/types/index.ts — old
export type ModelName = 'sonnet' | 'opus' | 'haiku';

// src/types/index.ts — new
export type ModelMoniker = 'apprentice' | 'journeyman' | 'master';
// ModelName accepts monikers, agent-specific aliases, or full model IDs
// Validation happens at runtime in agent.resolveModelId()
export type ModelName = ModelMoniker | string;
```

### 4.3 Agent Implementations

#### ClaudeCodeAgent

```typescript
// src/agent/claude-code.ts

export class ClaudeCodeAgent implements Agent {
  readonly id = 'claude-code';

  getAuthEnv() {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) return { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauth };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) return { key: 'ANTHROPIC_API_KEY', value: apiKey };
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
  }

  hasAuthEnv() {
    return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  }

  resolveModelId(name: string): string {
    const map: Record<string, string> = {
      'apprentice': 'claude-haiku-4-5-20251001',
      'journeyman': 'claude-sonnet-4-5-20250929',
      'master': 'claude-opus-4-6',
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-5-20250929',
      'opus': 'claude-opus-4-6',
    };
    const resolved = map[name];
    if (!resolved) {
      const valid = Object.keys(map).join(', ');
      throw new Error(`Unknown model "${name}" for claude-code. Valid models: ${valid}`);
    }
    return resolved;
  }

  availableModels() {
    return [
      { name: 'journeyman', modelId: 'claude-sonnet-4-5-20250929', isDefault: true },
      { name: 'master', modelId: 'claude-opus-4-6', isDefault: false },
      { name: 'apprentice', modelId: 'claude-haiku-4-5-20251001', isDefault: false },
      // Agent-specific aliases
      { name: 'sonnet', modelId: 'claude-sonnet-4-5-20250929', isDefault: false },
      { name: 'opus', modelId: 'claude-opus-4-6', isDefault: false },
      { name: 'haiku', modelId: 'claude-haiku-4-5-20251001', isDefault: false },
    ];
  }

  buildExecArgs(opts) {
    const args = ['claude', '-p', opts.prompt, '--output-format', 'json'];
    if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.modelId) args.push('--model', opts.modelId);
    return args;
  }

  parseResponse(stdout: string) {
    const parsed = JSON.parse(stdout);
    return {
      result: parsed.result,
      sessionId: parsed.session_id,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }

  isPromptTooLongError(msg: string) {
    return msg.includes('prompt is too long') || msg.includes('maximum context length');
  }

  isSessionNotFoundError(msg: string) {
    return msg.includes('session not found') || msg.includes('Could not find session');
  }

  discoverSessionFiles(opts: { sessionId?: string; configDir?: string }) {
    // Claude Code stores session files in ~/.claude/projects/<project-hash>/<session-id>.jsonl
    const configDir = opts.configDir ?? join(homedir(), '.claude');
    const projectsDir = join(configDir, 'projects');
    // Return all JSONL files, or filter by session ID
    // Implementation uses glob: `${projectsDir}/**/*.jsonl`
    // If sessionId is provided, filter to files containing that session
    return []; // Placeholder — actual implementation uses fs.readdirSync
  }
}
```

#### ClaudeCodePackaging

```typescript
// src/agent/claude-code-packaging.ts

export class ClaudeCodePackaging implements AgentPackaging {
  readonly agentId = 'claude-code';

  configDirName() { return '.claude'; }
  npmPackage() { return '@anthropic-ai/claude-code@latest'; }
  binaryName() { return 'claude'; }

  dockerInstallCommand() {
    return 'RUN bun install -g @anthropic-ai/claude-code@latest && chmod o+x /root && chmod -R o+rX /root/.bun';
  }

  generateDockerfile() {
    return `FROM oven/bun:slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
${this.dockerInstallCommand()}
RUN useradd -m -s /bin/bash user
USER user
WORKDIR /work`;
  }

  supervisorToolChecks() {
    return [
      { cmd: 'git', name: 'git', hint: 'Install with: apt-get install -y git' },
      { cmd: 'claude', name: 'claude', hint: 'Install with: npm install -g @anthropic-ai/claude-code' },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found. Volume mount issue.' },
    ];
  }

  diagnose() {
    // Check claude binary on PATH
    try {
      const result = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'ignore', timeout: 5000 });
      if (result.exitCode === 0) {
        return [{ state: 'ok' as const, what: 'Claude Code CLI installed' }];
      }
    } catch {}
    return [{ state: 'fail' as const, what: 'Claude Code CLI installed', reason: 'claude not found on PATH. Install: npm install -g @anthropic-ai/claude-code' }];
  }
}
```

#### CursorAgent

```typescript
// src/agent/cursor.ts

export class CursorAgent implements Agent {
  readonly id = 'cursor';

  getAuthEnv() {
    const key = process.env.CURSOR_API_KEY;
    if (key) return { key: 'CURSOR_API_KEY', value: key };
    throw new Error('Set CURSOR_API_KEY');
  }

  hasAuthEnv() {
    return !!process.env.CURSOR_API_KEY;
  }

  resolveModelId(name: string): string {
    const map: Record<string, string> = {
      'apprentice': 'cursor-small',  // Placeholder — actual Cursor model names TBD
      'journeyman': 'cursor-default',
      'master': 'cursor-max',
    };
    const resolved = map[name];
    if (!resolved) {
      const valid = Object.keys(map).join(', ');
      throw new Error(`Unknown model "${name}" for cursor. Valid models: ${valid}`);
    }
    return resolved;
  }

  availableModels() {
    return [
      { name: 'journeyman', modelId: 'cursor-default', isDefault: true },
      { name: 'master', modelId: 'cursor-max', isDefault: false },
      { name: 'apprentice', modelId: 'cursor-small', isDefault: false },
    ];
  }

  buildExecArgs(opts) {
    // Cursor uses `agent -p` — system prompt is prepended to user prompt
    // because Cursor has no --append-system-prompt flag
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = `<system-instructions>\n${opts.systemPrompt}\n</system-instructions>\n\n${prompt}`;
    }
    const args = ['agent', '-p', prompt, '--output-format', 'json'];
    if (opts.dangerouslySkipPermissions) args.push('--force');
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.modelId) args.push('--model', opts.modelId);
    args.push('--trust'); // Required for headless in untrusted workspaces
    return args;
  }

  parseResponse(stdout: string) {
    // Cursor emits the same JSON shape as Claude Code
    const parsed = JSON.parse(stdout);
    return {
      result: parsed.result,
      sessionId: parsed.session_id,
      usage: {
        inputTokens: 0, // Cursor doesn't expose token usage
        outputTokens: 0,
      },
    };
  }

  isPromptTooLongError(msg: string) {
    return msg.includes('prompt is too long') || msg.includes('context length');
  }

  isSessionNotFoundError(msg: string) {
    return msg.includes('session not found') || msg.includes('chat not found');
  }

  discoverSessionFiles() {
    // Cursor doesn't expose session files in a documented format
    return [];
  }
}
```

#### CodexAgent

```typescript
// src/agent/codex.ts

export class CodexAgent implements Agent {
  readonly id = 'codex';

  getAuthEnv() {
    const key = process.env.CODEX_API_KEY;
    if (key) return { key: 'CODEX_API_KEY', value: key };
    throw new Error('Set CODEX_API_KEY');
  }

  hasAuthEnv() {
    return !!process.env.CODEX_API_KEY;
  }

  resolveModelId(name: string): string {
    const map: Record<string, string> = {
      'apprentice': 'gpt-5.1-codex-mini',
      'journeyman': 'gpt-5.3-codex',
      'master': 'gpt-5.1-codex-max',
      // Codex-specific aliases
      'mini': 'gpt-5.1-codex-mini',
      'default': 'gpt-5.3-codex',
      'max': 'gpt-5.1-codex-max',
      'spark': 'gpt-5.3-codex-spark',
    };
    const resolved = map[name];
    if (!resolved) {
      const valid = Object.keys(map).join(', ');
      throw new Error(`Unknown model "${name}" for codex. Valid models: ${valid}`);
    }
    return resolved;
  }

  availableModels() {
    return [
      { name: 'journeyman', modelId: 'gpt-5.3-codex', isDefault: true },
      { name: 'master', modelId: 'gpt-5.1-codex-max', isDefault: false },
      { name: 'apprentice', modelId: 'gpt-5.1-codex-mini', isDefault: false },
      { name: 'spark', modelId: 'gpt-5.3-codex-spark', isDefault: false },
    ];
  }

  buildExecArgs(opts) {
    const args = ['codex', 'exec'];
    if (opts.dangerouslySkipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }
    if (opts.systemPrompt) {
      args.push('--config', `developer_instructions=${opts.systemPrompt}`);
    }
    if (opts.modelId) args.push('--model', opts.modelId);
    if (opts.sessionId) {
      args.push('resume', opts.sessionId);
    }
    // Plain-text mode: final message → stdout, progress → stderr
    args.push(opts.prompt);
    return args;
  }

  parseResponse(stdout: string, opts?: { workingDir?: string }): AgentResponse {
    // In plain-text mode, stdout is just the final text message.
    // Session ID must be recovered from Codex's session files.
    const sessionId = this.recoverSessionId(opts?.workingDir);
    return {
      result: stdout.trim(),
      sessionId,
      usage: {
        inputTokens: 0,  // Not available in plain-text mode
        outputTokens: 0,
      },
    };
  }

  /**
   * Recover the session ID from Codex's session directory.
   *
   * Codex saves sessions as JSONL files under:
   *   ~/.codex/sessions/YYYY/MM/DD/rollout-<SESSION_ID>.jsonl
   *
   * Algorithm:
   * 1. List files in today's session directory (~/.codex/sessions/YYYY/MM/DD/)
   * 2. Sort by mtime descending (most recent first)
   * 3. The most recently modified rollout-*.jsonl is our session
   * 4. Extract session ID from filename: rollout-<SESSION_ID>.jsonl → SESSION_ID
   *
   * This is a heuristic — if multiple Codex sessions run concurrently, it could
   * pick the wrong one. For v1 this is acceptable because lazy runs one agent
   * per task. A future improvement would use --json mode to parse the
   * thread.started event which contains the session ID directly.
   */
  private recoverSessionId(workingDir?: string): string {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const now = new Date();
    const dateDir = join(
      codexHome, 'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    );

    try {
      const files = readdirSync(dateDir)
        .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: statSync(join(dateDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        // Extract session ID: "rollout-abc123def.jsonl" → "abc123def"
        const match = files[0].name.match(/^rollout-(.+)\.jsonl$/);
        if (match) return match[1];
      }
    } catch {
      // Session directory might not exist yet
    }

    // Fallback: return empty string — session resume won't work but execution succeeded
    logger.warn('Could not recover Codex session ID from session files');
    return '';
  }

  isPromptTooLongError(msg: string) {
    return msg.includes('context_length_exceeded') || msg.includes('too many tokens');
  }

  isSessionNotFoundError(msg: string) {
    return msg.includes('session not found') || msg.includes('rollout not found');
  }

  discoverSessionFiles(opts: { sessionId?: string; configDir?: string }) {
    const codexHome = opts.configDir ?? join(homedir(), '.codex');
    const sessionsDir = join(codexHome, 'sessions');
    if (opts.sessionId) {
      // Find the specific session file by ID — search all date directories
      // glob: sessionsDir/**/rollout-<sessionId>.jsonl
      return []; // Placeholder — actual implementation uses recursive dir scan
    }
    // Return all recent session files
    return []; // Placeholder
  }
}
```

### 4.4 Agent Registry

```typescript
// src/agent/registry.ts

import { ClaudeCodeAgent } from './claude-code';
import { ClaudeCodePackaging } from './claude-code-packaging';
import { CursorAgent } from './cursor';
import { CursorPackaging } from './cursor-packaging';
import { CodexAgent } from './codex';
import { CodexPackaging } from './codex-packaging';
import type { Agent, AgentPackaging } from './interface';

const agents: Record<string, () => Agent> = {
  'claude-code': () => new ClaudeCodeAgent(),
  'cursor': () => new CursorAgent(),
  'codex': () => new CodexAgent(),
};

const packaging: Record<string, () => AgentPackaging> = {
  'claude-code': () => new ClaudeCodePackaging(),
  'cursor': () => new CursorPackaging(),
  'codex': () => new CodexPackaging(),
};

export function getAgent(agentId: string): Agent {
  const factory = agents[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${Object.keys(agents).join(', ')}`
    );
  }
  return factory();
}

export function getAgentPackaging(agentId: string): AgentPackaging {
  const factory = packaging[agentId];
  if (!factory) {
    throw new Error(
      `Unknown agent: ${agentId}. Available agents: ${Object.keys(packaging).join(', ')}`
    );
  }
  return factory();
}

export function listAgents(): string[] {
  return Object.keys(agents);
}
```

### 4.5 Configuration Model

#### Updated `lazy.toml`

```toml
[agent]
# Which agent to use. Options: "claude-code" (default), "cursor", "codex"
agent_id = "claude-code"

[models]
# Default model name. Universal monikers work across all agents:
#   apprentice — fast/cheap (haiku, codex-mini)
#   journeyman — balanced, the default (sonnet, codex)
#   master     — most capable (opus, codex-max)
#
# Agent-specific aliases also work (e.g., "sonnet" for claude-code).
default = "journeyman"

# Agent-specific config (optional, only parsed for the active agent)
[agent.claude-code]
# Uses ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from environment

[agent.cursor]
# Uses CURSOR_API_KEY from environment

[agent.codex]
# Uses CODEX_API_KEY from environment
```

#### Config Type Changes

```typescript
// src/config/types.ts

export type ModelMoniker = 'apprentice' | 'journeyman' | 'master';
export type ModelName = ModelMoniker | string;

export interface AgentConfig {
  agent_id: string;  // default: 'claude-code'
  'claude-code'?: Record<string, unknown>;
  'cursor'?: Record<string, unknown>;
  'codex'?: Record<string, unknown>;
}
```

#### Migration Path

| Old config | New config | Behavior |
|---|---|---|
| `models.default = "sonnet"` | (no change needed) | Works — `sonnet` is a Claude Code alias for `journeyman` |
| `models.default = "opus"` | (no change needed) | Works — `opus` is a Claude Code alias for `master` |
| (no agent config) | (no change needed) | Defaults to `agent.agent_id = "claude-code"` |
| `models.default = "sonnet"` + switch to `agent.agent_id = "codex"` | Change to `models.default = "journeyman"` | `sonnet` is not valid for Codex — `resolveModelId()` throws with helpful error |

**Backward compatibility**:
- `agent.agent_id` defaults to `'claude-code'` → zero-config for existing users
- Agent-specific model aliases (`sonnet`, `opus`, `haiku`) continue to work for Claude Code
- `claude_session_id` gets renamed to `agent_session_id` — FileStorage reads old field name as fallback during deserialization

#### Wiring `availableModels()` to CLI

The `availableModels()` method is consumed in two places:

1. **`lazy models` command** (new): Lists available models for the active agent.
   ```
   $ lazy models
   Agent: claude-code

   Model           ID                           Default
   journeyman      claude-sonnet-4-5-20250929   *
   master          claude-opus-4-6
   apprentice      claude-haiku-4-5-20251001
   sonnet          claude-sonnet-4-5-20250929
   opus            claude-opus-4-6
   haiku           claude-haiku-4-5-20251001
   ```

2. **`lazy create --model` validation**: When the user passes `--model`, validate it against `agent.resolveModelId()` before creating the task. If the model name is invalid, show the error with the list of valid names (from the thrown error).

3. **Help text for `--model` flag**: The flag description includes `(run 'lazy models' to see options)` rather than hard-coding model names.

### 4.6 Codex Session ID Recovery (Detailed)

Session resume is a core lazy feature. Codex's plain-text mode doesn't include the session ID in stdout, so the `CodexAgent.parseResponse()` method recovers it from disk.

**Codex's session storage layout**:
```
~/.codex/sessions/
  2026/
    03/
      03/
        rollout-a1b2c3d4e5f6.jsonl
        rollout-f7e8d9c0b1a2.jsonl
```

**Recovery algorithm** (in `CodexAgent.recoverSessionId()`):
1. Compute today's date directory: `~/.codex/sessions/YYYY/MM/DD/`
2. List all `rollout-*.jsonl` files
3. Sort by mtime descending (most recently modified first)
4. Extract session ID from the filename: `rollout-<SESSION_ID>.jsonl` → `SESSION_ID`
5. Return the session ID from the most recent file

**Why this works**: Lazy runs one agent process per task at a time. The most recently modified session file in today's directory is the one we just created.

**Edge cases**:
- **Multiple concurrent Codex runs**: Could pick the wrong session. Mitigated by lazy's one-agent-per-task design. If we later support concurrent agents, switch to `--json` mode and parse `thread.started`.
- **Session started before midnight, finished after**: The date directory is based on current time. If the session started yesterday, the file might be in yesterday's directory. Mitigation: also check yesterday's directory if today's has no matches.
- **`CODEX_HOME` override**: Respect the `CODEX_HOME` env var (Codex's standard override for `~/.codex`).
- **Session file doesn't exist**: Return empty string and log a warning. The task's work succeeded even if resume won't work.

**Future improvement**: Switch to `codex exec --json` and parse the NDJSON stream. The `thread.started` event contains the session ID directly, eliminating the filesystem heuristic entirely.

### 4.7 Supervisor Watchdog Timer

A general-purpose watchdog timer in the supervisor layer kills agent processes that appear hung. This is not agent-specific — it's a supervisor feature that protects against any agent misbehaving.

**Design**:
```typescript
// In the supervisor's agent execution loop

interface WatchdogConfig {
  /** Kill agent if no stdout/stderr output for this many ms. 0 = disabled. */
  outputTimeoutMs: number;
  /** Absolute maximum runtime in ms. 0 = disabled. */
  maxRuntimeMs: number;
}

// Default configs per agent (in the registry or config)
const WATCHDOG_DEFAULTS: Record<string, WatchdogConfig> = {
  'claude-code': { outputTimeoutMs: 0, maxRuntimeMs: 0 },        // No watchdog — Claude is reliable
  'cursor':      { outputTimeoutMs: 30_000, maxRuntimeMs: 0 },   // Kill after 30s silence (hanging bug)
  'codex':       { outputTimeoutMs: 0, maxRuntimeMs: 0 },        // No watchdog — Codex is reliable
};
```

**Behavior**:
1. Supervisor spawns agent process and monitors its stdout/stderr
2. If `outputTimeoutMs > 0`: reset a timer on every output line. If the timer fires, send SIGTERM. If no exit after 5s, send SIGKILL.
3. If `maxRuntimeMs > 0`: set an absolute deadline. Same SIGTERM → SIGKILL sequence.
4. Watchdog kills are logged as warnings and the turn is marked as failed with a specific error message.
5. User can override defaults in `lazy.toml`:
   ```toml
   [agent.cursor]
   watchdog_output_timeout_ms = 60000  # More lenient
   ```

### 4.8 Feature Parity Matrix

| Feature | Claude Code | Cursor CLI | Codex CLI |
|---|---|---|---|
| **Headless execution** | Stable | Has hanging bugs (watchdog mitigates) | Stable |
| **JSON output** | Single JSON object | Single JSON object | NDJSON stream or plain text |
| **Session resume** | `--resume <id>` | `--resume [chatId]` | `codex exec resume <id>` |
| **Session ID in output** | Yes (in JSON) | Yes (in JSON) | No (recovered from session files) |
| **System prompt** | `--append-system-prompt` | Prepended to user prompt | `--config developer_instructions` |
| **MCP in headless** | Works | Buggy | Works |
| **Auth model** | API key / OAuth | API key / OAuth | API key / OAuth |
| **Token usage reporting** | Detailed (input/output/cache) | Not exposed | Not exposed in plain-text mode |
| **Docker compatibility** | Reliable | Hanging risk | Reliable (with `--sandbox danger-full-access`) |
| **Permission control** | `--dangerously-skip-permissions` | `--force` (all-or-nothing) | `--full-auto` / `--yolo` |
| **Config directory** | `~/.claude/` | Unknown / internal | `~/.codex/` |
| **NPM install** | `@anthropic-ai/claude-code` | No (binary download) | `@openai/codex` |
| **Open source** | No | No | Yes (Apache-2.0) |
| **Session file discovery** | `.claude/projects/**/*.jsonl` | Not available | `~/.codex/sessions/**/*.jsonl` |
| **Builder support** | Yes (v1) | No (v1) | No (v1) |

---

## Refactoring Instructions

These are designed as a sequence of safe steps — each keeps the system working.

### Step 1: Rename `claude_session_id` → `agent_session_id`

**What**: Mechanical rename across all files. No behavior change.

**Files to change**:
- `src/types/index.ts:59` — Change field name on `Session` interface
- `src/storage/file-storage.ts` — All reads/writes of the field (search for `claude_session_id`)
- `src/supervisor/index.ts` — References in supervisor loop
- `src/cli/commands/resume.ts`, `unblock.ts`, `status.ts`, `shared.ts`, `upgrade.ts`, `reopen.ts`, `pair.ts`
- `src/utils/auto-resume.ts`, `reconcile.ts`
- `src/protocol/types.ts`

**Migration**: The FileStorage implementation needs to handle both field names during deserialization (read `claude_session_id` if `agent_session_id` is missing). Write always uses the new name. This ensures existing `.lazy/` data remains readable.

### Step 2: Rename `ClaudeResponse` → `AgentResponse`

**What**: Rename the type. Keep the same shape for now.

**Files to change**:
- `src/types/index.ts:154-163` — Rename interface
- `src/capture/claude.ts:5` — Update import
- `src/runner/types.ts:11` — Update import
- `src/runner/docker-runner.ts:9` — Update import
- `src/runner/host-process-runner.ts:16` — Update import
- All other files importing `ClaudeResponse`

### Step 3: Introduce universal model monikers

**What**: Replace `ModelName = 'sonnet' | 'opus' | 'haiku'` with `ModelMoniker | string`. Update default config from `'sonnet'` to `'journeyman'`.

**Files to change**:
- `src/types/index.ts` — New `ModelMoniker` type, updated `ModelName`
- `src/config/types.ts` — Updated `models.default` type
- `src/config/loader.ts` — Default changes from `'sonnet'` to `'journeyman'`
- `src/capture/claude.ts:getModelId()` — Add moniker mappings alongside existing aliases

**Migration**: `sonnet`/`opus`/`haiku` continue to work as Claude Code-specific aliases. New universal monikers resolve to the same models for Claude Code.

### Step 4: Create Agent and AgentPackaging interfaces

**What**: Create `src/agent/` directory with `interface.ts`, `claude-code.ts`, `claude-code-packaging.ts`, and `registry.ts`. Extract Claude-specific logic into `ClaudeCodeAgent` and `ClaudeCodePackaging`.

**What moves to `ClaudeCodeAgent`** (Agent interface):
- `getModelId()` → `resolveModelId()` (with universal moniker support)
- `hasAuthEnv()` / `getAuthEnv()` → Agent auth methods
- CLI flag building from `runClaude()` / `resumeClaude()` → `buildExecArgs()`
- Response parsing from `runClaude()` → `parseResponse()`
- `isPromptTooLongError()` / `isSessionNotFoundError()` → Agent error methods
- Session file discovery → `discoverSessionFiles()`

**What moves to `ClaudeCodePackaging`** (AgentPackaging interface):
- `DEFAULT_DOCKERFILE` → `generateDockerfile()`
- `configDirName()` → `.claude`
- `npmPackage()` → `@anthropic-ai/claude-code@latest`
- `binaryName()` → `claude`
- `supervisorToolChecks()` from DockerRunner
- `diagnose()` health checks

**What stays in `capture/claude.ts`** (renamed to `src/capture/runner-infra.ts`):
- All Docker infrastructure: `checkDocker()`, `ensureImage()`, `buildImage()`, etc.
- Container lifecycle: `isContainerRunning()`, `containerExists()`, `removeContainer()`, etc.
- Agent binary management: `ensureAgentBinary()`
- `SandboxConfig` type
- Supervisor wrapper script building

### Step 5: Wire Agent into Runner

**What**: `DockerRunner` and `HostProcessRunner` receive an `Agent` instance (via constructor) and an `AgentPackaging` instance. They no longer hard-code Claude Code invocations.

**Changes in DockerRunner**:
- Constructor: `constructor(agent: Agent, packaging: AgentPackaging, binary?: string)`
- `launchSupervisor()` — Use `agent.getAuthEnv()` for env vars, `packaging.configDirName()` for volume mounts
- `runClaudeSync()` → `runAgentSync()` — Use `agent.buildExecArgs()` and `agent.parseResponse()`
- `supervisorToolChecks()` — Delegate to `packaging.supervisorToolChecks()`
- `diagnose()` — Delegate to `packaging.diagnose()`
- `launchBuilderInteractive()` — Unchanged (builder stays Claude Code-only for v1; assert `agent.id === 'claude-code'`)

**Changes in HostProcessRunner**:
- Constructor: same pattern as DockerRunner
- `checkAvailability()` — Use `packaging.binaryName()` for version check
- `runClaudeSync()` → `runAgentSync()` — Use `agent.buildExecArgs()` and `agent.parseResponse()`

**Changes in Runner interface** (`src/runner/types.ts`):
- `runClaudeSync()` → `runAgentSync()` — rename method
- Import `AgentResponse` instead of `ClaudeResponse`
- Remove direct import of `SandboxConfig` from `capture/claude` (use the moved type)

### Step 6: Wire Agent into Supervisor

**What**: `src/supervisor/work.ts` uses the Agent interface instead of hard-coding `claude` CLI args.

**Changes**:
- `executeClaudeCode()` → `executeAgent()` — Use `agent.buildExecArgs()` for command building
- Response parsing uses `agent.parseResponse()`
- Error detection uses `agent.isPromptTooLongError()` / `agent.isSessionNotFoundError()`
- The supervisor receives the agent ID via protocol (existing `LAZY_AGENT_ID` env var or protocol file)
- Supervisor creates the Agent instance from the registry at startup

### Step 7: Add watchdog timer to supervisor

**What**: Implement the output-based watchdog timer in the supervisor's agent execution loop. Configurable per-agent with defaults.

**Files to change**:
- `src/supervisor/work.ts` — Add watchdog logic around process spawn
- `src/config/types.ts` — Add `watchdog_output_timeout_ms` to agent-specific config
- `src/agent/registry.ts` — Default watchdog configs per agent

### Step 8: Add Cursor and Codex agents

**What**: Implement `CursorAgent`, `CursorPackaging`, `CodexAgent`, `CodexPackaging`. Add to registry.

**Pre-requisites**: Steps 1-7 must be complete.

**Testing**: Each agent implementation should be tested with a mock (similar to `test/mocks/claude.ts`). Tests verify:
- `resolveModelId()` maps all universal monikers correctly
- `resolveModelId()` throws on unknown model names
- `buildExecArgs()` produces correct argv for each flag combination
- `parseResponse()` extracts correct fields from agent output
- Codex `recoverSessionId()` finds the right session file

### Step 9: Parameterize Dockerfiles

**What**: Move Dockerfile generation from a constant to `packaging.generateDockerfile()`. Toolchain Dockerfiles use `packaging.dockerInstallCommand()` instead of hard-coding `claude-code@latest`.

**Files to change**:
- `src/capture/runner-infra.ts` (formerly `claude.ts`) — Replace `DEFAULT_DOCKERFILE` with call to `packaging.generateDockerfile()`
- `src/docker/toolchains.ts` — Toolchain templates use `{{AGENT_INSTALL}}` placeholder, resolved via `packaging.dockerInstallCommand()`
- Image name includes agent ID: `lazy-runner-${agentId}`

### Step 10: Add `lazy models` command

**What**: New CLI command that lists available models for the active agent.

**Files to add**:
- `src/cli/commands/models.ts` — New command implementation

**Behavior**: Reads `agent.agent_id` from config, instantiates the agent via registry, calls `availableModels()`, formats as table.

---

## Decisions (Resolved)

1. **Builder scope**: Builder stays Claude Code-only for v1. The `launchBuilderInteractive()` method asserts `agent.id === 'claude-code'` and throws a clear error for other agents.

2. **Cursor hanging bug**: General watchdog timer in supervisor (section 4.7), not agent-specific. Configurable per-agent, with `outputTimeoutMs: 30000` default for Cursor.

3. **Codex output parsing**: Plain-text mode for v1 (stdout = final message, stderr = progress). Session ID recovered from `~/.codex/sessions/` files (section 4.6). NDJSON parsing deferred.

4. **Model naming**: Universal monikers `apprentice`/`journeyman`/`master` (section 4.2). Agent-specific aliases for backward compat. Unknown names are rejected with an error listing valid options.

5. **Session file capture**: Abstracted via `agent.discoverSessionFiles()`. Implemented for Claude Code, placeholder for Codex, empty for Cursor.

## Open Questions (Remaining)

1. **Supervisor binary and agent ID**: The `lazy-agent` binary is compiled at build time and runs inside containers. It needs to know which agent to invoke. Current proposal: pass `LAZY_AGENT_ID` as an environment variable to the container. The supervisor reads it at startup and creates the Agent from the registry. This means the `lazy-agent` binary ships all agent implementations — acceptable for v1 but could be split later.

2. **Cursor model names**: The Cursor CLI's actual model names are not well-documented. The `cursor-small`/`cursor-default`/`cursor-max` names in this document are placeholders. Need to verify with `agent --list-models` or Cursor docs before implementing.

3. **Codex session ID race condition**: The filesystem-based session ID recovery (section 4.6) has a theoretical race if multiple Codex processes run simultaneously. Lazy's one-agent-per-task design prevents this in practice. Document this limitation and plan to switch to `--json` mode when richer telemetry is needed.
