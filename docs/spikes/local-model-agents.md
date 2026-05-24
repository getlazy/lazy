# Local Model Agents: Claude Code + Ollama + Lazy Docker

**Status:** Spike research (2026-04-05)
**Goal:** Run lazy autonomous agents with local models via Ollama, enabling fully offline operation.

## Architecture

```
┌─────────────────────────────┐
│  Host (macOS, M5 Max 128GB) │
│                             │
│  Ollama (MLX backend)       │
│  localhost:11434            │
│  /v1/messages endpoint      │
│  (Anthropic Messages API)   │
└──────────┬──────────────────┘
           │ host.docker.internal:11434
┌──────────┴──────────────────┐
│  Docker container (agent)   │
│                             │
│  Claude Code CLI            │
│  ANTHROPIC_BASE_URL=        │
│   http://host.docker.internal:11434 │
│  ANTHROPIC_AUTH_TOKEN=ollama│
│  ANTHROPIC_API_KEY=""       │
│  --model qwen3-coder       │
└─────────────────────────────┘
```

---

## 1. Ollama + Claude Code Compatibility

### Key finding: tool use is the primary risk

**Tool-use reliability with local models is the fundamental limitation that may make this impractical for autonomous agent work.**

Lazy agents don't just chat — they make complex multi-tool calls per turn: Edit a file, run Bash to test, Grep for related code, Read another file, then Edit again. This requires the model to reliably produce structured tool-call JSON across multiple sequential invocations within a single response. Even 30B+ models through Ollama have significantly lower tool-call reliability than Claude. Community reports confirm that while simple single-tool calls work, the kind of multi-step agentic workflows lazy depends on break frequently — dropped tool calls, malformed JSON, failure to chain tools, and silent fallback to text responses instead of tool invocations.

This doesn't mean local models are useless — they can handle simpler tasks (single-file edits, code explanation, basic refactors). But the expectation should be that autonomous multi-turn agent sessions with complex tool use will have a meaningfully higher failure rate than with Claude.

### How it works

Ollama v0.14+ (released January 2026) implements the **Anthropic Messages API** at `/v1/messages`. Claude Code can connect to it instead of Anthropic's servers by setting three environment variables:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_AUTH_TOKEN=ollama    # dummy value — Ollama doesn't check auth
export ANTHROPIC_API_KEY=""           # prevent accidental real API key usage
```

Then launch Claude Code with a model flag:

```bash
claude --model qwen3-coder
```

### `ollama launch claude`

Ollama v0.15+ (January 23, 2026) added the `launch` command, which automates the setup:

```bash
ollama launch claude                          # interactive model picker
ollama launch claude --model qwen3-coder      # specific model
ollama launch claude --model qwen3-coder --yes -- -p "prompt"  # headless, non-interactive
```

Under the hood, `ollama launch claude` sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and passes `--model` to Claude Code. No manual env var configuration needed.

### What Ollama's Anthropic API supports

| Feature | Supported | Notes |
|---------|-----------|-------|
| Messages & multi-turn | ✅ | Full compatibility |
| Streaming | ✅ | SSE streaming |
| System prompts | ✅ | |
| **Tool/function calling** | ⚠️ | Works in principle, but has reliability issues (see below) |
| Vision (base64) | ✅ | URL-based images not supported |
| Thinking/extended thinking | ⚠️ | Basic support, no token budget enforcement |
| `tool_choice` parameter | ❌ | Cannot force specific tool use |
| Token counting | ❌ | `/v1/messages/count_tokens` returns 404 |
| Prompt caching | ❌ | |
| API key validation | ❌ | Accepted but not checked |

### Tool use — the fundamental limitation

Claude Code's agentic loop depends on tool calling (file edits, bash, grep, etc.). Through Ollama:

- **Large models (30B+)** handle simple single-tool calls reasonably well, but multi-tool chains (Edit → Bash → Grep → Edit) — which lazy agents do routinely — break frequently
- **Small models (7B-8B)** frequently fail — they output JSON but don't properly invoke tools
- **Known streaming bugs** in some Ollama versions drop tool call responses, breaking the agentic loop. Ollama v0.15.2+ recommended.
- **Telemetry requests** to unsupported endpoints (e.g., `/v1/messages/count_tokens?beta=true`) can cause cascading 500 errors and Ollama server hangs
- **`tool_choice` is not supported** — Ollama ignores this parameter, so Claude Code cannot force the model to use a specific tool

**Critical stability workaround:**

```bash
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

These env vars prevent Claude Code from making requests to endpoints Ollama doesn't support.

### Claude Code model selection

Claude Code does **not** auto-detect models from Ollama. You must specify:

- `--model <model-name>` CLI flag
- `ANTHROPIC_MODEL=<model-name>` env var
- `ANTHROPIC_CUSTOM_MODEL_OPTION=<model-name>` for the `/model` picker
- `ANTHROPIC_DEFAULT_SONNET_MODEL=<model-name>` to override what "sonnet" resolves to

### Community experience

**What works:**
- Basic coding: boilerplate, helpers, simple components, CRUD, CSS
- Code reading and explanation
- Multi-turn conversations
- File editing (with 30B+ models)

**What doesn't work well:**
- Complex debugging and architectural tasks (far behind Opus/Sonnet)
- Small models fail at tool calling
- Claude Code CLI can hang on startup when MCP servers are slow to load ([claude-code#25412](https://github.com/anthropics/claude-code/issues/25412))

**Practical pattern:** Use local models for quick fixes and follow-ups. Switch to Anthropic API for complex tasks.

### Sources

- [Ollama Anthropic Compatibility Docs](https://docs.ollama.com/api/anthropic-compatibility)
- [Ollama Blog: Claude Code](https://ollama.com/blog/claude)
- [Ollama Integration Docs: Claude Code](https://docs.ollama.com/integrations/claude-code)
- [Ollama Blog: Launch](https://ollama.com/blog/launch)
- [Claude Code Model Configuration](https://code.claude.com/docs/en/model-config)
- [ollama/ollama#13949](https://github.com/ollama/ollama/issues/13949) — API compatibility with Claude Code
- [ollama/ollama#13931](https://github.com/ollama/ollama/issues/13931) — No tool calls with small models

---

## 2. Ollama + MLX on Apple Silicon

### MLX backend

Ollama **v0.19** (preview, March 31, 2026) introduced the MLX backend for Apple Silicon. Performance compared to llama.cpp on the same hardware:

| Metric | MLX | llama.cpp | Improvement |
|--------|-----|-----------|-------------|
| Prefill (tok/s) | 1,810 | 1,154 | **+57%** |
| Decode (tok/s) | 112 | 58 | **+93%** |

MLX is automatic on Apple Silicon with Ollama 0.19 — no manual configuration needed.

**Current limitation:** Only **Qwen3.5-35B-A3B** (in NVFP4 format) is supported in the MLX preview. More models expected in the full 0.19 release (Q2 2026).

### NVFP4 quantization

NVFP4 is NVIDIA's 4-bit floating point format with a key advantage for MoE models: **router gates are preserved at 8-bit precision**, improving expert selection quality. This matters because routing decisions determine which 3B of the 35B total parameters are activated.

- Memory: ~22 GB for Qwen3.5-35B-A3B weights
- Quality: comparable to Q4_K_M for dense layers, better for MoE routing
- Speed: 112 tok/s decode on M5 Max (vs ~58 tok/s for Q4_K_M via llama.cpp)

### Model recommendations for 128GB M5 Max

| Model | Type | Quant | Weights | With 64K ctx | Decode speed | Best for |
|-------|------|-------|---------|-------------|-------------|----------|
| **qwen3.5:35b-a3b-coding-nvfp4** | MoE (3B active) | NVFP4 | ~22 GB | ~25 GB | **112 tok/s** (MLX) | Fast iteration, agents |
| qwen3.5:122b-a10b | MoE (10B active) | Q4_K_M | ~70 GB | ~95 GB | ~10-15 tok/s | Quality-critical tasks |
| qwen3.5:27b | Dense | Q4_K_M | ~17 GB | ~33 GB | ~15-25 tok/s | Coding correctness |

**Recommendation:** Start with **qwen3.5:35b-a3b-coding-nvfp4**. It's the only model with MLX support right now, delivering 112 tok/s — fast enough for interactive agent work. The 3B active parameters are adequate for tool-calling and standard coding tasks. Pull `qwen3.5:122b-a10b` as a fallback for harder problems (runs on llama.cpp at ~half speed but 3.3x more active parameters).

### Context window

All Qwen3.5 models support up to **262,144 tokens** (256K). Ollama defaults to 256K context on machines with 48+ GB RAM. Claude Code needs at least 64K.

Memory impact of context:
- Qwen3.5-35B-A3B: 4K → 262K context adds only ~3 GB (hybrid attention is efficient)
- Qwen3.5-122B-A10B: 4K → 262K context adds ~25 GB

With 128 GB, the 35B-A3B model at 64K context uses only ~25 GB — massive headroom.

### NVFP4 (MLX) vs Q4_K_M (llama.cpp)

| Aspect | NVFP4 (MLX) | Q4_K_M (llama.cpp) |
|--------|-------------|---------------------|
| Bit width | 4-bit | 4-bit |
| MoE router precision | 8-bit | 4-bit |
| Decode speed (M5 Max) | 112 tok/s | ~58 tok/s |
| Prefill speed (M5 Max) | 1,810 tok/s | 1,154 tok/s |
| Memory | ~22 GB | ~22 GB |
| Model support | Only Qwen3.5-35B-A3B | All models |

The speed difference is from the MLX backend, not the quantization format. NVFP4's quality advantage is primarily for MoE routing.

### Sources

- [Ollama Blog: MLX](https://ollama.com/blog/mlx)
- [MacRumors: Ollama MLX](https://www.macrumors.com/2026/03/31/ollama-now-runs-faster-apple-silicon-macs/)
- [InsiderLLM: Qwen3.5 Local Guide](https://insiderllm.com/guides/qwen35-local-guide-which-model-fits-your-gpu/)

---

## 3. Lazy Docker Container Integration

### Current state

The relevant code paths:

- **`src/agent/claude-code.ts`** — `getAuthEnv()` returns either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. No support for `ANTHROPIC_BASE_URL` or other Ollama env vars.
- **`src/capture/claude.ts`** — `buildDockerArgs()` passes only the single auth env var (`-e ${auth.key}=${auth.value}`) and `GIT_SSH_COMMAND`.
- **`src/capture/claude.ts`** — `launchSupervisorAsync()` adds `--add-host=host.docker.internal:host-gateway` **only when** `daemonConfigPath` is provided (i.e., daemon mode). Note: `docker-runner.ts:385` (`launchBuilderInteractive`) adds it unconditionally — the gap is specific to the capture/supervisor path.
- **`src/config/types.ts`** — No fields for custom env vars, Ollama config, or base URL override.

### Gaps

1. **No `ANTHROPIC_BASE_URL` passthrough.** Containers can't reach Ollama on the host because this env var is never set.

2. **No custom env var support.** `lazy.toml` has no way to pass arbitrary environment variables to containers. The only env vars passed are the auth key and `GIT_SSH_COMMAND`.

3. **`host.docker.internal` is conditional in supervisor path.** In `capture/claude.ts:1018`, `--add-host=host.docker.internal:host-gateway` is only added when `daemonConfigPath` is present. The builder path (`docker-runner.ts:385`) already adds it unconditionally. The supervisor/capture path needs the same treatment.

4. **Auth model doesn't fit.** `getAuthEnv()` returns a single key-value pair and throws if neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is set. With Ollama, we need to pass multiple env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`).

5. **`docker_agent_no_network` should be removed entirely.** This option is useless — Claude Code always needs network access (either to Anthropic's API or to Ollama on the host). There is no valid use case for running an agent container with no network. Remove the config field and the `--network none` logic from both `buildDockerArgs` and `launchSupervisorAsync`.

### Changes needed

#### A. Config: `lazy.toml`

Add a dedicated `[ollama]` section:

```toml
[ollama]
enabled = true
model = "qwen3-coder"
endpoint = "http://host.docker.internal:11434"
```

A dedicated section lets lazy validate the configuration, automatically add `--add-host`, inject the correct env vars, and handle auth without user intervention.

#### B. Auth: `getAuthEnvVars()` returns an array

Rename `getAuthEnv()` → `getAuthEnvVars()` and change the return type:

```typescript
getAuthEnvVars(): Array<{ key: string; value: string }>
```

For Claude API: returns `[{ key: 'ANTHROPIC_API_KEY', value: '<key>' }]` (or the OAuth token equivalent).

For Ollama: returns:
```typescript
[
  { key: 'ANTHROPIC_BASE_URL', value: 'http://host.docker.internal:11434' },
  { key: 'ANTHROPIC_AUTH_TOKEN', value: 'ollama' },
  { key: 'ANTHROPIC_API_KEY', value: 'ollama' },
  { key: 'DISABLE_TELEMETRY', value: '1' },
  { key: 'DISABLE_ERROR_REPORTING', value: '1' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
]
```

This is the clean approach — all environment configuration for the agent lives in one place. `buildDockerArgs` and `launchSupervisorAsync` iterate the array to emit `-e` flags. No special-casing needed in the Docker layer.

#### C. Docker args: `capture/claude.ts`

`buildDockerArgs()` and `launchSupervisorAsync()` need:

1. **Always add `--add-host=host.docker.internal:host-gateway`** unconditionally (matches what `docker-runner.ts` already does for the builder path)
2. **Iterate `getAuthEnvVars()`** to emit `-e` flags (instead of the current single `-e ${auth.key}=${auth.value}`)
3. **Pass `--model`** to Claude Code in the exec args

#### D. Remove model name abstraction entirely

Delete `resolveModelId()` and the lazy model name aliases (`apprentice`, `journeyman`, `master`, `sonnet`, `opus`, `haiku`). Users pass raw model IDs directly: `claude-opus-4-6`, `claude-sonnet-4-5-20250929`, `qwen3.5:35b-a3b-coding-nvfp4`, etc.

Raw model names are better because they accurately record which model was actually used. The abstraction layer adds indirection without value — users already know what model they want.

`buildExecArgs()` already passes `--model <id>` directly to Claude Code, so this is just removing the mapping layer.

#### E. Remove `docker_agent_no_network`

Delete the `docker_agent_no_network` config field from `types.ts` and the `--network none` logic from `buildDockerArgs` and `launchSupervisorAsync`. Claude Code always needs network access.

#### F. Validation

- Test host connectivity before launching Ollama-configured agents: `curl -s http://localhost:11434/api/tags`

### Estimated effort

The core modifications:

1. Add `ollama` config type in `types.ts` (~10 lines)
2. Rename `getAuthEnv` → `getAuthEnvVars`, return array (~20 lines)
3. Update `buildDockerArgs` and `launchSupervisorAsync` to iterate env var array, unconditional `--add-host` (~15 lines each)
4. Delete `resolveModelId()` and model name aliases, update callers (~net negative lines)
5. Delete `docker_agent_no_network` and `--network none` logic (~net negative lines)

Total: modest net change in production code + config loader changes + tests.

---

## 4. Offline Operation

### Ollama on host

**Fully offline once the model is pulled.** Ollama serves models from local disk with no network dependency. No license checks, no phone-home.

```bash
# Pull before going offline
ollama pull qwen3.5:35b-a3b-coding-nvfp4
# Verify it works
ollama run qwen3.5:35b-a3b-coding-nvfp4 "hello"
```

### Claude Code in container

Claude Code makes several network calls during normal operation:

| Call | Purpose | Required? | Offline behavior |
|------|---------|-----------|-----------------|
| Anthropic API (`/v1/messages`) | LLM inference | ✅ | Redirected to Ollama via `ANTHROPIC_BASE_URL` |
| Statsig | Telemetry metrics | ❌ | Disable with `DISABLE_TELEMETRY=1` |
| Sentry | Error reporting | ❌ | Disable with `DISABLE_ERROR_REPORTING=1` |
| NPM | Updates check | ❌ | Disable with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| Auth (`console.anthropic.com`) | OAuth validation | ❌ | Not needed with Ollama — use `ANTHROPIC_AUTH_TOKEN=ollama` |
| Feature flags (GrowthBook) | Feature gates | ❌ | Disabled by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |

**Container env vars for offline operation:**

```bash
ANTHROPIC_BASE_URL=http://host.docker.internal:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=ollama
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

**Known side effects of disabling telemetry:**
- `DISABLE_TELEMETRY=1` disables the Opus 4.6 1M context model on eligible plans ([claude-code#34178](https://github.com/anthropics/claude-code/issues/34178)) — irrelevant when using Ollama
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disables GrowthBook feature flags, which breaks Channels ([claude-code#38450](https://github.com/anthropics/claude-code/issues/38450)) — irrelevant for autonomous agents

### Lazy daemon: remote dependencies

Each lazy feature has its own remote dependency. "Offline" is not a binary state — Anthropic could be down while GitHub is fine, or Ollama might not be running while everything else works.

| Feature | Remote dependency | Should degrade to |
|---------|-------------------|-------------------|
| `auto_react_ci` | CI provider (GitHub Actions, GitLab CI) | Log failure, skip, retry next interval |
| `auto_react_comments` | Forge API (GitHub, GitLab) | Log failure, skip, retry next interval |
| Remote sync (push/pull) | Git remote | Log failure, continue local-only |
| `github_auto_push` / `gitlab_auto_push` | Git remote | Log failure, queue for next successful push |
| Agent inference | Anthropic API or Ollama | Fail the turn, report to human |
| Local task management | None | Always works |
| Local agent execution | None (except inference) | Always works |
| MCP server (local) | None | Always works |
| Post-turn checks | Depends on command | Always works if check is local |

### Design principle: graceful degradation, not global mode switch

Users should **not** need to reconfigure lazy when going offline. Each remote dependency is a separate concern that should fail gracefully at the point of use:

- Remote operations should retry with backoff (already implemented via `withRemoteRetry()`), then fail with a clear error
- The daemon should log the failure and continue operating — a GitHub push failure shouldn't stop local task management
- Agent inference failure (Anthropic down, Ollama not running) should fail the turn and report to the human, not crash the daemon

This is a design principle for the implementation work: lazy should handle each dependency failure independently rather than requiring a global "offline mode" toggle.

---

## 5. Practical Setup Guide

### Prerequisites

- macOS with Apple Silicon (M-series)
- Docker Desktop installed and running
- Ollama v0.19+ (for MLX support)
- ~25 GB free disk space for model + context

### Step 1: Install/update Ollama

```bash
# Install (if not already)
brew install ollama

# Or update to latest (need 0.19+ for MLX)
brew upgrade ollama

# Verify version
ollama --version
# Should show 0.19.x or later
```

### Step 2: Pull the model

```bash
# Primary model: fast MoE with MLX backend
ollama pull qwen3.5:35b-a3b-coding-nvfp4

# Optional: larger model for harder problems (runs on llama.cpp, slower)
ollama pull qwen3.5:122b-a10b
```

### Step 3: Verify Anthropic API compatibility

```bash
# Test the Anthropic Messages endpoint directly
curl -s http://localhost:11434/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: ollama" \
  -d '{
    "model": "qwen3.5:35b-a3b-coding-nvfp4",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello"}]
  }' | jq .

# Verify tool calling works
curl -s http://localhost:11434/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: ollama" \
  -d '{
    "model": "qwen3.5:35b-a3b-coding-nvfp4",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "tools": [{
      "name": "calculator",
      "description": "Calculate a math expression",
      "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}
    }]
  }' | jq .
```

### Step 4: Test Claude Code locally (outside Docker)

```bash
# Set env vars
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_API_KEY=ollama
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Test basic prompt
claude --model qwen3.5:35b-a3b-coding-nvfp4 -p "What language is this file written in?" --output-format json

# Test with tool use (file reading)
claude --model qwen3.5:35b-a3b-coding-nvfp4 -p "Read the README.md and summarize it" --dangerously-skip-permissions --output-format json
```

### Step 5: Test inside Docker

```bash
# Run a one-off container with Ollama access
docker run --rm -it \
  --add-host=host.docker.internal:host-gateway \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:11434 \
  -e ANTHROPIC_AUTH_TOKEN=ollama \
  -e ANTHROPIC_API_KEY=ollama \
  -e DISABLE_TELEMETRY=1 \
  -e DISABLE_ERROR_REPORTING=1 \
  -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  <lazy-docker-image> \
  claude --model qwen3.5:35b-a3b-coding-nvfp4 -p "Hello, what model are you?" --output-format json
```

### Step 6: Configure lazy.toml (once implemented)

```toml
# Future lazy.toml config (requires implementation — see Section 3)
[ollama]
enabled = true
model = "qwen3.5:35b-a3b-coding-nvfp4"
endpoint = "http://host.docker.internal:11434"
```

No other config changes needed — lazy should handle remote dependency failures gracefully (see Section 4).

### Verification checklist

Before going offline, verify each step:

- [ ] `ollama --version` shows 0.19+
- [ ] `ollama list` shows the pulled model
- [ ] `curl http://localhost:11434/v1/messages` with test payload returns a response
- [ ] Tool calling test returns a `tool_use` content block
- [ ] `claude --model <model> -p "hello"` works with the env vars set
- [ ] Docker container can reach `host.docker.internal:11434`
- [ ] Claude Code inside Docker can make a successful inference call

### Troubleshooting

**Ollama server not running:**
```bash
ollama serve  # start manually, or ensure it's running as a service
```

**Container can't reach host:**
```bash
# Verify host.docker.internal resolves inside container
docker run --rm --add-host=host.docker.internal:host-gateway alpine ping -c1 host.docker.internal
```

**Claude Code hangs on startup:**
Known issue with MCP server loading ([claude-code#25412](https://github.com/anthropics/claude-code/issues/25412)). Ensure `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set.

**Tool calls not working:**
- Ensure model is 30B+ (small models fail at tool calling)
- Check Ollama version is 0.15.2+ (earlier versions have streaming bugs that drop tool responses)
- Try `qwen3-coder` or `qwen3.5:35b-a3b-coding-nvfp4` specifically — these are tested with Claude Code

**Ollama server crashes / 500 errors:**
Claude Code's telemetry can hit unsupported endpoints. Ensure all three telemetry env vars are set:
```bash
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```
