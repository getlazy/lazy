# Multi-Agent Support: Reassessment

This document reassesses the feasibility of multi-agent support (Cursor CLI, Codex CLI alongside Claude Code) given revised requirements. It builds on the original `docs/spike-multi-agent.md` design document and the work completed on the `release-v07` branch.

---

## A) Estimate of Work Already Done

### Completed Tasks on release-v07

Four tasks were completed and merged into the `lazy/release-v07` branch:

| Task | Code | What it did | Files changed |
|---|---|---|---|
| Step 1 | `rename-session-id` | `claude_session_id` -> `agent_session_id` across ~15 files | 15 files |
| Step 2 | `rename-agent-response` | `ClaudeResponse` -> `AgentResponse` across ~9 files | 9 files |
| Step 3 | `add-model-monikers` | Universal `apprentice`/`journeyman`/`master` monikers | 19 files |
| Steps 4-5 | `extract-agent-interface` | `Agent` and `AgentPackaging` interfaces, `ClaudeCodeAgent` impl, registry | 9 files (5 new + 4 updated) |

A fifth task (`add-watchdog-timer`, step 7) was in progress but closed when v07 was abandoned. It had a working implementation with 13 tests across 3 files, but had accumulated complex merge history (32 commits including multiple upstream merges).

### Cherry-pick / Rebase Assessment

**Main has barely diverged.** Only 2 commits landed on main since v07 branched:

1. `97ee62fb` — Fix silent reconciliation error swallowing (adds try/catch wrappers in `reconcile.ts`)
2. `fe4f3dcc` — Merge commit for above

The overlap between main's changes and v07's changes is minimal:

| File | Changed on main | Changed on v07 | Conflict risk |
|---|---|---|---|
| `src/utils/reconcile.ts` | Added try/catch wrappers around sweep calls | Renamed `claude_session_id` -> `agent_session_id` | **Low** — different hunks, different concerns |
| `src/index.ts` | Minor change | Not touched by agent tasks | **None** |
| `test/e2e/reconcile.test.ts` | New test file added | Not touched by agent tasks | **None** |

**Recommendation: Cherry-pick the 4 task commits directly onto main.** The merge should be nearly clean. The only potential conflict is in `reconcile.ts` where both branches touched the file — but the changes are in different hunks (rename vs try/catch). This is far simpler than rebasing the entire release-v07 branch, which carries CHANGELOG.md changes, version bumps, and other release artifacts we don't want.

The specific commits to cherry-pick:
1. `4ae44a07` — rename-session-id
2. `93356f1c` — rename-agent-response
3. `4bf1e3c0` — add-model-monikers
4. `c6e902f5` — extract-agent-interface

**For the watchdog timer**: Start fresh. The task accumulated 32 commits with complex merge history. The implementation is well-documented in the task turns and can be re-implemented cleanly on top of current main. Estimated effort: small (the design is proven, just needs clean re-implementation).

---

## B) Complexity Assessment for Revised Requirements

### B.1 Cursor = Host-Only Runner

**What simplifies vs the original plan:**
- No Dockerfile generation needed for Cursor (`CursorPackaging.generateDockerfile()` can throw "not supported")
- No Docker volume mount mapping for Cursor's config directory
- No need to solve the container trust/workspace-trust problem
- No need to run Cursor CLI inside Docker at all — this was the #1 blocker that caused v07 to be shelved

**What the container guard looks like:**
```typescript
// In runner selection logic
if (agent.id === 'cursor' && config.runner === 'docker') {
  throw new Error(
    'Cursor agent only supports host-process runner. ' +
    'Set runner = "host-process" in lazy.toml or use a different agent.'
  );
}
```

This is a simple validation at task start time, before any work begins.

**Remaining complexity:**
- Cursor CLI hanging bug still exists — needs the watchdog timer (step 7)
- MCP tool approval in headless mode still requires pre-configured `mcp-approvals.json` file under `.cursor/` — no `--approve-mcps` flag exists as of March 2026
- No `--append-system-prompt` flag — system prompt must be injected via `.cursor/rules/*.mdc` files with `alwaysApply: true`, or prepended to the user prompt (as the original spike proposed)
- `.cursorrules` does NOT load in agent/CLI mode — must use `.cursor/rules/*.mdc` format

**Assessment: Small effort for agent mode. The host-only constraint eliminates the hardest problems.**

### B.2 Codex = Both Runners (Host + Container)

**What's different about packaging Codex for Docker:**
- Codex is installable via npm (`@openai/codex`) or Homebrew — npm path works well in Docker, same as Claude Code
- Codex has its own sandbox model (Landlock/seccomp on Linux, Seatbelt on macOS). In Docker, recommend `--sandbox danger-full-access` and rely on container isolation
- Config directory is `~/.codex/` (needs volume mount in Docker)
- Auth via `CODEX_API_KEY` env var — straightforward to pass to containers

**Output parsing differences:**
- `codex exec` in plain-text mode: final message to stdout, progress to stderr — actually simpler to parse than Claude's JSON
- Session ID recovery from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files — same heuristic as original spike
- The `--json` NDJSON mode is available but not needed for v1

**What's changed since the original spike (March 2026):**
- GPT-5.4 is now the recommended model (was gpt-5.3-codex)
- MCP support is fully documented and works in both CLI and IDE
- `developer_instructions` in config.toml exists but may have reliability issues (some users report it not being picked up)
- Feature request for `--system-prompt` / `--append-system-prompt` flags is open (issue #11588) but not yet implemented
- Codex can run as an MCP server itself — potential future integration path

**Assessment: Medium effort. Similar to Claude Code's Docker story. The NDJSON parsing and session ID recovery add complexity but the original spike's design handles this well.**

### B.3 Builder Support for All Agents

**This is the biggest change from the original plan**, which explicitly said "builder stays Claude Code-only for v1." The builder is deeply coupled to Claude Code through:

#### 1. MCP Tool Integration

| Agent | MCP Support in Headless | MCP Support in Interactive | Assessment |
|---|---|---|---|
| Claude Code | Full — reads `~/.claude.json` mcpServers config | Full | Works today |
| Cursor CLI | Buggy — requires `mcp-approvals.json`, trust issues in CI | Works in IDE | **Risky for builder** — MCP is how lazy_* tools are exposed |
| Codex CLI | Full — reads `~/.codex/config.toml` MCP config | Full | **Feasible** |

The builder's core value proposition is the lazy_* MCP tools (search, show, create, comment, etc.). Without reliable MCP, an agent can't function as a builder.

**Cursor builder MCP approach**: Write the lazy MCP server config to `.cursor/mcp.json` and create `mcp-approvals.json` to pre-approve all lazy_* tools. This is fragile — Cursor's headless MCP is still buggy and the approval mechanism is undocumented/unsupported. For host-process builder mode (interactive), Cursor reads `.cursor/mcp.json` and the user can approve tools in the terminal.

**Codex builder MCP approach**: Write the lazy MCP server config to `~/.codex/config.toml` or `.codex/config.toml`. Codex's MCP support is documented and reliable. This should work.

#### 2. System Prompt Injection

| Agent | Mechanism | Builder approach |
|---|---|---|
| Claude Code | `--append-system-prompt` flag | Direct flag — works perfectly |
| Cursor CLI | `.cursor/rules/*.mdc` with `alwaysApply: true` | Write a temp `.mdc` rule file before launching. Delete after. **Awkward but workable.** |
| Codex CLI | `developer_instructions` in config.toml or `AGENTS.md` | Write a temp `AGENTS.md` or inject via config. **Reliability concerns** — users report `developer_instructions` not being picked up. |

#### 3. Interactive Mode

The builder runs the agent interactively (not in `-p` mode). The user types prompts and gets responses in real-time.

| Agent | Interactive mode | Notes |
|---|---|---|
| Claude Code | `claude` (no args) | The default behavior |
| Cursor CLI | `agent` or `agent chat` | Supports interactive terminal sessions |
| Codex CLI | `codex` (no subcommand) | Launches interactive TUI |

All three agents support interactive mode. The builder can launch any of them.

#### 4. Session Resumption

The builder captures conversations from session files after the agent exits. This requires knowing where each agent stores its sessions:

| Agent | Session file location | Discoverable? |
|---|---|---|
| Claude Code | `~/.claude/projects/<hash>/*.jsonl` | Yes — well-documented |
| Cursor CLI | Internal/undocumented | **No** — no documented session file format |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Yes — documented |

**Cursor conversation capture is a gap.** The builder currently reads JSONL files from `~/.claude/projects/` — this won't work for Cursor. Options:
1. Skip conversation capture for Cursor builder (lose review/search of builder conversations)
2. Use `--output-format stream-json` to capture NDJSON events and reconstruct conversations
3. Wait for Cursor to document session files

#### 5. What Needs to Change Architecturally

The builder code in `src/cli/commands/builder.ts` and `src/runner/` needs:

1. **Agent-aware runner launch**: `launchBuilderInteractive()` must accept an Agent instance and use it for:
   - System prompt injection (flag vs file vs config)
   - MCP server configuration (different config locations per agent)
   - Binary name (claude vs agent vs codex)

2. **Agent-aware conversation capture**: The post-exit conversation capture must use `agent.discoverSessionFiles()` instead of hard-coded Claude paths

3. **Agent-aware MCP setup**: The merged config file approach (Docker) needs to know the agent's config format and location

**Assessment: Large effort. The builder is the hardest part of multi-agent support. Codex is feasible (good MCP, documented sessions). Cursor is risky (buggy headless MCP, undocumented sessions). Recommend shipping Codex builder first, Cursor builder later (or never for v1).**

### B.4 Cross-Model Review

The use case: "build with agent X, review with agent Y."

**What changes architecturally:**
- Task config already supports `agent_id` — just set different agents per task
- The builder (interactive session) uses one agent; tasks can use another
- `lazy.toml` has global `agent.agent_id`; individual tasks store their agent_id in task metadata
- The `--model` flag on `lazy create` selects the model within an agent, not the agent itself
- Need a `--agent` flag on `lazy create` (and potentially `lazy start`, `lazy resume`) to override the global agent

**Config example:**
```toml
[agent]
agent_id = "codex"  # Default agent for tasks

[builder]
agent_id = "claude-code"  # Builder uses Claude Code (for MCP reliability)
```

Or per-task override:
```bash
lazy create --agent codex "Implement feature X"
lazy create --agent claude-code "Review the codex implementation"
```

**What this requires:**
- `agent_id` field on Task type (already designed in original spike)
- Agent resolution at task start (read from task metadata, fall back to config)
- Builder agent resolution separate from task agent resolution

**Assessment: Small effort once the agent abstraction is in place. The architecture already supports this — it's mostly config wiring and a new CLI flag.**

---

## C) Work Remaining

### Steps from the Original 10-Step Plan

| Step | Description | Status | Effort to complete | Notes |
|---|---|---|---|---|
| 1 | Rename `claude_session_id` -> `agent_session_id` | **Done** (cherry-pick) | Trivial | Clean cherry-pick from v07 |
| 2 | Rename `ClaudeResponse` -> `AgentResponse` | **Done** (cherry-pick) | Trivial | Clean cherry-pick from v07 |
| 3 | Universal model monikers | **Done** (cherry-pick) | Trivial | Clean cherry-pick from v07 |
| 4-5 | Agent/AgentPackaging interfaces + ClaudeCodeAgent | **Done** (cherry-pick) | Trivial | Clean cherry-pick from v07 |
| 6 | Wire agent_id through config | Not started | **Small** | Add `agent.agent_id` to config types, wire through task creation/start |
| 7 | Watchdog timer | Re-implement | **Small** | Design proven, clean re-implementation on current main |
| 8 | CursorAgent implementation | Not started | **Medium** | Host-only simplifies Docker concerns but MCP/system-prompt workarounds add complexity |
| 9 | CodexAgent implementation | Not started | **Medium** | Both runners, NDJSON parsing, session ID recovery |
| 10 | `lazy models` command | Not started | **Small** | Simple CLI command using `agent.availableModels()` |

### NEW: Builder Multi-Agent Support

| Sub-task | Effort | Dependencies | Notes |
|---|---|---|---|
| Builder agent config (`builder.agent_id`) | **Small** | Step 6 | Separate config key for builder vs task agent |
| Builder system prompt injection per agent | **Medium** | Steps 8-9 | Claude: flag, Cursor: .mdc file, Codex: AGENTS.md or config |
| Builder MCP setup per agent | **Large** | Steps 8-9 | Different config locations, trust mechanisms, approval files |
| Builder conversation capture per agent | **Medium** | Steps 8-9 | Claude: JSONL, Codex: JSONL (different path), Cursor: unknown |
| Cross-model `--agent` flag on CLI commands | **Small** | Step 6 | `lazy create --agent codex`, `lazy start --agent cursor` |

### Dependency Graph

```
Steps 1-5 (cherry-pick) ─┐
                          ├─> Step 6 (config wiring) ─┐
                          │                            ├─> Step 8 (CursorAgent)
                          │                            ├─> Step 9 (CodexAgent)
                          │                            ├─> Step 10 (lazy models)
                          │                            └─> Builder multi-agent
Step 7 (watchdog) ────────┘ (independent, needed before Cursor)
```

---

## D) Manual Test Procedure

### D.1 Agent Mode Tests (Task Execution)

For each agent (claude-code, cursor, codex):

**Basic task lifecycle:**
1. `lazy create --agent <agent> "Create a hello world script"` — verify task created with correct agent_id
2. `lazy start <task-id>` — verify agent launches, produces output, completes
3. Check turn content in `lazy show <task-id>` — verify response was captured
4. `lazy unblock <task-id>` with feedback — verify agent resumes with session ID
5. `lazy accept <task-id>` — verify merge completes

**Model selection:**
6. `lazy create --agent <agent> --model apprentice "..."` — verify correct model resolves
7. `lazy create --agent <agent> --model journeyman "..."` — verify default model
8. `lazy create --agent <agent> --model master "..."` — verify most capable model
9. `lazy create --agent <agent> --model invalid_name "..."` — verify clear error with valid options listed

**Error handling:**
10. Remove auth env var, attempt `lazy start` — verify clear auth error message
11. Kill agent mid-task — verify supervisor handles crash, turn marked as error
12. (Cursor only) Let agent hang — verify watchdog kills it after timeout

### D.2 Builder Mode Tests

For each agent (claude-code, cursor, codex):

**Basic builder flow:**
1. `lazy builder` — verify agent launches interactively
2. Type a prompt — verify response
3. Use a lazy_* MCP tool (e.g., `lazy_search`) — verify tool executes and returns results
4. Exit builder — verify conversation captured
5. `lazy builder list` — verify captured conversation appears

**System prompt:**
6. `lazy builder` — verify system prompt is injected (ask the agent "what are your system instructions?")
7. Verify agent-specific injection mechanism works (flag for Claude, .mdc file for Cursor, config for Codex)

### D.3 Container vs Host-Process Tests

**Host-process (all agents):**
1. Set `runner = "host-process"` in lazy.toml
2. Run full task lifecycle (create, start, unblock, accept) for each agent
3. Run builder for each agent

**Container (claude-code, codex only):**
4. Set `runner = "docker"` in lazy.toml
5. Run full task lifecycle for claude-code and codex
6. Run builder for claude-code and codex
7. Verify Cursor with `runner = "docker"` gives clear error message

### D.4 Session Resumption Tests

For each agent:
1. Start a task, let it complete first turn
2. `lazy unblock <task-id>` — verify agent resumes with prior context
3. Verify agent references work from previous turn (not starting fresh)
4. (Codex) Verify session ID was recovered from session files

### D.5 Model Selection / Moniker Tests

1. Set `models.default = "journeyman"` — verify all agents use their default model
2. Set `models.default = "sonnet"` with `agent.agent_id = "claude-code"` — verify backward compat
3. Set `models.default = "sonnet"` with `agent.agent_id = "codex"` — verify clear error
4. `lazy models` — verify output lists correct models for active agent

### D.6 Error Handling

| Scenario | Expected behavior |
|---|---|
| Missing ANTHROPIC_API_KEY for claude-code | Clear error: "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" |
| Missing CURSOR_API_KEY for cursor | Clear error: "Set CURSOR_API_KEY" |
| Missing CODEX_API_KEY for codex | Clear error: "Set CODEX_API_KEY" |
| Invalid model name | Error listing valid models for the active agent |
| Cursor + docker runner | Error: "Cursor agent only supports host-process runner" |
| Agent binary not on PATH | Clear error with install instructions |
| Agent hangs (Cursor) | Watchdog kills after configured timeout, turn marked as error |
| Agent crashes mid-turn | Turn marked as error, task stays in working state |

### D.7 Cross-Agent Scenarios

1. **Build with Codex, review with Claude Code:**
   - `lazy create --agent codex "Implement feature"` — start and complete
   - `lazy create --agent claude-code "Review the codex implementation"` — start and complete
   - Verify both tasks reference the same codebase

2. **Builder is Claude Code, agents are mixed:**
   - Set `builder.agent_id = "claude-code"`, `agent.agent_id = "codex"` in lazy.toml
   - `lazy builder` — verify Claude Code launches as builder with MCP tools
   - Create and start a task from the builder — verify it uses Codex as the agent

---

## E) Final Recommendation

### Should we proceed?

**Yes, but with a phased approach.** The revised requirements actually make the core agent work easier (Cursor host-only eliminates the Docker nightmare) while adding significant scope in builder support. The right strategy is to ship in phases.

### Recommended Sequencing

**Phase 1: Foundation (cherry-pick + config wiring)**
1. Cherry-pick the 4 completed v07 commits onto main
2. Implement step 6 (wire agent_id through config)
3. Re-implement step 7 (watchdog timer, clean)
4. Implement step 10 (`lazy models` command)

This phase delivers zero new agents but puts all the infrastructure in place. Every task still runs with Claude Code — no user-visible change, no risk.

**Phase 2: Codex Agent**
5. Implement CodexAgent + CodexPackaging (step 9)
6. Test Codex in both host-process and Docker runners

Codex first because:
- Its CLI is closer to Claude Code than Cursor's
- MCP support is reliable and documented
- Session files are documented (session ID recovery works)
- No hanging bug (no watchdog urgency)
- Works in both runners (no special-casing)

**Phase 3: Cursor Agent**
7. Implement CursorAgent + CursorPackaging (step 8)
8. Implement host-only runner guard
9. Test Cursor in host-process runner only

Cursor second because:
- Host-only constraint makes it simpler but also less useful
- MCP in headless mode is still buggy
- No documented session files
- Hanging bug requires watchdog (which we have from phase 1)

**Phase 4: Builder Multi-Agent**
10. Add `builder.agent_id` config
11. Implement builder system prompt injection per agent
12. Implement builder MCP setup per agent (Codex first, Cursor if feasible)
13. Implement builder conversation capture per agent
14. Add `--agent` flag to CLI commands

Builder last because:
- It's the highest complexity work
- Codex builder is feasible; Cursor builder is risky
- Users can still use `lazy builder` with Claude Code while using other agents for tasks

### Rebase v07 or Start Fresh?

**Cherry-pick the 4 clean commits. Do NOT rebase the entire v07 branch.**

Reasons:
- Main has barely diverged (2 commits) — cherry-picks will be nearly clean
- The v07 branch carries release artifacts (CHANGELOG, version bumps) we don't want
- The watchdog timer task (32 commits, complex merge history) is better re-implemented fresh
- Cherry-picking is surgical and low-risk

### Minimum Viable Scope

If time is limited, the minimum viable multi-agent scope is:

1. Cherry-pick steps 1-5 (foundation) — **trivial**
2. Wire agent_id config (step 6) — **small**
3. CodexAgent implementation (step 9) — **medium**
4. `lazy models` command (step 10) — **small**

This gives users `agent.agent_id = "codex"` in lazy.toml for task execution. No builder changes, no Cursor, no watchdog. Four tasks total.

### Biggest Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Codex `developer_instructions` unreliable | System prompt not picked up, agent ignores lazy's instructions | Use `AGENTS.md` file as primary mechanism; test thoroughly; fall back to prepending to prompt |
| Cursor MCP in headless stays buggy | Cursor can't use lazy_* tools as builder | Ship Cursor as agent-only (no builder); revisit when Cursor fixes headless MCP |
| Session ID recovery heuristic fails | Can't resume Codex sessions | Monitor in practice; switch to `--json` NDJSON mode if needed |
| Cherry-pick conflicts | Unexpected merge issues | Conflicts limited to `reconcile.ts` — changes are in different hunks |
| Agent CLI breaking changes | Cursor or Codex change their CLI flags | Pin CLI versions in Dockerfile; add version-sniffing in `checkAvailability()` |
| Builder multi-agent scope creep | Phase 4 takes longer than expected | Ship phases 1-3 first; builder can stay Claude Code-only indefinitely |

---

## Appendix: Updated Research (March 2026)

### Cursor CLI — Current State

| Capability | Status (March 2026) | Change from original spike |
|---|---|---|
| Headless mode (`agent -p`) | Works | No change |
| JSON output | `--output-format json` (single) or `stream-json` (NDJSON) | `stream-json` is new |
| MCP in headless | Requires `mcp-approvals.json` pre-config; buggy in CI | Still buggy |
| System prompt injection | No `--append-system-prompt`; use `.cursor/rules/*.mdc` with `alwaysApply: true` | `.cursorrules` confirmed NOT loaded in agent mode |
| Hanging bug | Still present | No change |
| `--approve-mcps` flag | Does not exist | Was speculated in original spike; not real |
| Session files | Undocumented internal format | No change |
| AGENTS.md support | Yes (reads from project root) | New — could be used for system prompt injection |

### Codex CLI — Current State

| Capability | Status (March 2026) | Change from original spike |
|---|---|---|
| Headless mode (`codex exec`) | Stable | No change |
| Output modes | Plain text (default), `--json` (NDJSON) | No change |
| MCP support | Full — config in `~/.codex/config.toml` | Well-documented now |
| System prompt | `developer_instructions` in config.toml; `AGENTS.md` | Reliability concerns with `developer_instructions` |
| `--system-prompt` flag | Feature request open (#11588), not implemented | New info — not available yet |
| Session resume | `codex exec resume --last` or by ID | No change |
| Session files | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | No change |
| Recommended model | gpt-5.4 (was gpt-5.3-codex) | Model upgrade |
| Can run as MCP server | Yes (`codex --mcp-server`) | New capability |
| Agents SDK integration | Documented workflow with MCP | New — potential future path |
