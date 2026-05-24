# Spike: Estimate Effort to Rewrite Lazy from Scratch

**Date:** 2026-03-19
**Type:** Spike (read-only research)
**Goal:** Estimate the effort to rewrite Lazy from scratch, keeping the existing test suite as
the specification and producing a cleaner codebase with proper abstractions from day one.

---

## 1. Capability Inventory

### Codebase Size

| Category | Files | Lines (approx) |
|----------|-------|-----------------|
| Source (`.ts`) | 153 | ~47,600 |
| Tests (`.ts`) | 133 | ~33,200 |
| Prompts (`.md`) | 33 | ~1,200 |
| Dockerfiles | 15 | ~580 |
| **Total** | **334** | **~82,600** |

### CLI Commands (44 total, in `src/cli/commands/`)

#### Task Creation (5)
| Command | Lines | Description |
|---------|-------|-------------|
| `create` | 189 | Create a task in backlog with goal/prompt/model/type/code/parent |
| `fix` | 167 | Create a fix task with injected fix-constraints prompt |
| `document` | 218 | Create a doc-only task (no code changes allowed) |
| `refactor` | 155 | Create a refactor task (no behavior changes) |
| `rework` | 302 | Create a follow-up to previously accepted work |

#### Task Lifecycle — Pre-Start (3)
| Command | Lines | Description |
|---------|-------|-------------|
| `edit` | 284 | Edit task metadata before agent works on it |
| `clone` | 226 | Duplicate a task with fresh backlog state |
| `link` | 261 | Import an external resource (GitHub PR) as a lazy task |

#### Task Lifecycle — Running (4)
| Command | Lines | Description |
|---------|-------|-------------|
| `start` | 763 | Create worktree/branch, build/launch agent container, optionally follow |
| `branch` | 195 | Create child task branching from parent HEAD, start immediately |
| `resume` | 373 | Resume an interrupted task |
| `pair` | 583 | Interactive Claude Code session in task worktree |

#### Task Lifecycle — Review & Decision (10)
| Command | Lines | Description |
|---------|-------|-------------|
| `unblock` | 517 | Give feedback to blocked task, resume agent |
| `review` | 94 | Read-only TUI review (two-panel full-screen) |
| `loop` | 510 | Sequential review of all blocked tasks |
| `accept` | 848 | Accept work, merge to parent branch, CI wait, cleanup |
| `reject` | 240 | Reject work, end session, cleanup |
| `close` | 237 | Close task without merging |
| `reopen` | 242 | Reopen terminal task, recreate worktree |
| `revert` | 196 | Revert accepted task via git revert |
| `redo` | 304 | Close stale task, create fresh replacement |
| `propose` | 181 | Create pending follow-up proposal |

#### Inspection (7)
| Command | Lines | Description |
|---------|-------|-------------|
| `list` | 460 | List tasks (tree/flat, status filters, aliases: `ls`, `tasks`) |
| `show` | 656 | Full task detail (turns, commits, comments, proposals) |
| `status` | 176 | Git/worktree state for a task |
| `diff` | 177 | Changes relative to upstream (stat or full, per-turn) |
| `search` | 305 | Full-text/structured search across all entities |
| `comment` | 94 | Add freeform annotation to a task |
| `shell` | 75 | Open shell in task worktree |

#### Remote/Sync (3)
| Command | Lines | Description |
|---------|-------|-------------|
| `sync` | 712 | Bidirectional sync with GitHub/GitLab forge |
| `import-conversation` | 273 | Import Claude Code JSONL logs |
| `builder` | 375 | Launch interactive Claude Code with builder prompt |

#### Infrastructure (7)
| Command | Lines | Description |
|---------|-------|-------------|
| `daemon` | 229 | Manage daemon process (start/stop/restart/status) |
| `server` | 50 | Start HTTP web dashboard |
| `doctor` | 937 | Diagnose installation health |
| `upgrade` | 482 | Rebuild agent binary/image, auto-resume |
| `init` | (in cli/init.ts) | Initialize lazy in a git repo |
| `completion` | 230 | Shell completion scripts (bash/zsh) |
| `system` | 44 | Inspect prompts and toolchains |
| `wait` | 216 | Block until task transitions from working |

### MCP Tools (25 tools in `src/mcp/tools.ts` — 2,487 lines)

| Tool | Description |
|------|-------------|
| `lazy_search` | Full-text/regex/fuzzy/structured search |
| `lazy_show` | Task detail with pagination |
| `lazy_create` | Create task (two-step confirmation) |
| `lazy_comment` | Add comment to task |
| `lazy_propose` | Propose follow-up task |
| `lazy_commit` | Stage and commit in worktree |
| `lazy_status` | Current task and worktree state |
| `lazy_conversations` | List builder conversations |
| `lazy_conversation_search` | Search conversations |
| `lazy_conversation_read` | Read full conversation |
| `lazy_start` | Start task (worktree + agent) |
| `lazy_unblock` | Give feedback, resume agent |
| `lazy_accept` | Accept and merge (two-step confirmation) |
| `lazy_reject` | Reject work (two-step confirmation) |
| `lazy_close` | Close/abandon task (two-step confirmation) |
| `lazy_resume` | Resume without new feedback |
| `lazy_list` | List tasks |
| `lazy_blocked` | List blocked tasks |
| `lazy_active` | List active tasks |
| `lazy_diff` | Show task changes |
| `lazy_wait` | Poll until status change |
| `lazy_edit` | Edit task metadata |
| `lazy_clone` | Clone task |
| `lazy_reopen` | Reopen terminal task (two-step confirmation) |
| `lazy_redo` | Close and replace task (two-step confirmation) |

**Key pattern:** 6 tools use a two-step confirmation protocol (call without code -> get guidance + code -> call with code) to prevent agents from taking destructive actions without deliberation.

### Core Subsystems

| Module | Files | Lines | Description |
|--------|-------|-------|-------------|
| Daemon (`src/daemon/`) | 8 | ~1,507 | Unix socket RPC server, single-writer to storage, reconcile loop |
| Storage (`src/storage/`) | 6 | ~4,406 | ~60 methods; File, Postgres, Remote backends |
| Runner (`src/runner/`) | 5 | ~1,273 | Docker/Podman/HostProcess execution backends |
| Docker (`src/docker/`) | 2+15 | ~846 | Toolchain registry, 15 Dockerfiles, auto-detection |
| Git (`src/git/`) | 1 | 662 | Git operation helpers (branch, diff, worktree, etc.) |
| Builder (`src/builder/`) | 2 | ~219 | HTTP bridge: agent container -> host MCP tools |
| Supervisor (`src/supervisor/`) | 7 | ~2,012 | 5-phase turn pipeline, retry, watchdog, permissions, pushback |
| Protocol (`src/protocol/`) | 3 | ~433 | File-based IPC (host <-> supervisor), typed commands/responses |
| Config (`src/config/`) | 4 | ~622 | TOML config, env var overrides, defaults |
| Remote (`src/remote/`) | 5 | ~3,502 | GitHub/GitLab/Local drivers (~40 methods each) |
| Search (`src/search/`) | 5 | ~984 | Lucene-style query parser + evaluator |
| Agent (`src/agent/`) | 8 | ~760 | ClaudeCode/Cursor/QA agent implementations |
| Capture (`src/capture/`) | 1 | 1,044 | Docker image build, container launch, auth env |
| Import (`src/import/`) | 2 | ~490 | Claude Code JSONL log parsing, conversation storage |
| Server (`src/server/`) | 4 | ~2,960 | Read-only HTML dashboard |
| QA (`src/qa/`) | 1 | 292 | Deterministic scriptable fake agent for testing |
| Shell (`src/shell/`) | 1 | 259 | Shell detection and completion check |
| Prompts (`src/prompts/`) | 20 | ~1,204 | System prompts, builder prompt, constraints, confirmations |
| Utils (`src/utils/`) | 14 | ~2,450 | Reconciler (836), git wrapper, diff, auto-resume, locks, logger |
| Types (`src/types/`) | 1 | 190 | Core domain types and interfaces |
| State Machine | 1 | 129 | Task status transitions (12 statuses, validity table) |
| TUI (`src/cli/tui/`) | 4 | ~2,729 | Two-panel review, terminal, renderer, file viewer |

### IPC Architecture (3 layers)

1. **Protocol** (file-based): Supervisor <-> Host. Command/response JSON files with atomic writes.
   Used for container-to-host communication.
2. **Daemon** (Unix socket HTTP/JSON-RPC): CLI <-> Daemon. Eliminates storage lock contention.
3. **RemoteStorage** (HTTP proxy over daemon): Storage operations tunneled through daemon RPC.

---

## 2. Test Coverage Map

### Test Suite Summary

| Category | Files | Tests | Description |
|----------|-------|-------|-------------|
| E2E (`test/e2e/`) | 88 | 1,140 | CLI subprocess tests with mocked agent |
| Unit (`test/unit/`) | 35 | 554 | Isolated function/module tests |
| QA (`test/qa/`) | 4 | N/A | Manual integration scripts (not in `bun test`) |
| **Total (automated)** | **123** | **1,694** | |

### Test Infrastructure

- **`test/helpers/setup.ts`** — `setupTestLazy()` creates isolated temp dir with git repo + `lazy init`
- **`test/helpers/assertions.ts`** — `expectSuccess`, `expectFailure`, `expectOutput`, `expectError`, `extractTaskId`
- **`test/helpers/fixtures.ts`** — `createTask()`, `MOCK_CLAUDE_SUCCESS`
- **`test/mocks/claude.ts`** — Full mock of `src/capture/claude.ts`, simulates supervisor protocol
- **`test/mocks/preload-mocks.ts`** — Bun preload to swap modules at import time
- **`test/mocks/remote.ts`** — Mock `RepositoryDriver` for forge operations
- **Timeout:** 30s global (via `bunfig.toml`)

### E2E Coverage by Area (88 files, 1,140 tests)

Top coverage areas by test count:

| Test File | Tests | Area |
|-----------|-------|------|
| `remote-driver.test.ts` | 104 | GitHub/GitLab driver factory and methods |
| `search.test.ts` | 46 | Search across all entity types |
| `daemon.test.ts` | 41 | Daemon server, lifecycle, CLI |
| `protocol.test.ts` | 40 | Protocol I/O round-trips |
| `postgres-storage.test.ts` | 36 | Full Postgres CRUD |
| `notes-diff.test.ts` | 32 | Comment filtering and diff annotations |
| `mcp.test.ts` | 32 | MCP server and all tool handlers |
| `task-code.test.ts` | 28 | Task code validation and uniqueness |
| `list.test.ts` | 24 | Task listing in tree/flat modes |
| `pair.test.ts` | 23 | Pairing lock lifecycle |
| `doctor.test.ts` | 21 | Health diagnostics |
| `clone.test.ts` | 21 | Task cloning |
| `init.test.ts` | 21 | Repository initialization |
| `branch.test.ts` | 20 | Child task lifecycle |
| `remote-storage.test.ts` | 20 | RemoteStorage proxy round-trips |
| `builder.test.ts` | 19 | Builder interactive mode |
| `rework.test.ts` | 18 | Task rework flows |
| `create.test.ts` | 17 | Task creation |
| `document.test.ts` | 17 | Document task creation |
| `prompts.test.ts` | 17 | Prompt listing and display |
| `theme.test.ts` | 16 | Theme system |
| `flag-validation.test.ts` | 16 | CLI flag validation |
| `reconcile.test.ts` | 16 | Reconciler grace periods and correctness |
| `stdin.test.ts` | 15 | Stdin handling across commands |
| `edit.test.ts` | 15 | Task editing |
| `revert.test.ts` | 14 | Task revert |
| `fix.test.ts` | 13 | Fix task creation |
| `completion.test.ts` | 13 | Shell completion |
| `init-toolchain.test.ts` | 13 | Toolchain detection |
| `permissions.test.ts` | 13 | Protected file patterns |
| `confirm-protocol.test.ts` | 12 | MCP two-step confirmation |
| `close.test.ts` | 12 | Task closing |
| `link.test.ts` | 12 | External resource import |

### Unit Test Coverage (35 files, 554 tests)

Top coverage areas:

| Test File | Tests | Area |
|-----------|-------|------|
| `gitlab-driver.test.ts` | 69 | GitLab driver methods |
| `confirmation.test.ts` | 59 | Confirmation code generation/validation |
| `search-parser.test.ts` | 50 | Query parser AST |
| `toolchain-detect.test.ts` | 46 | Toolchain auto-detection |
| `cursor-agent.test.ts` | 39 | Cursor agent model resolution |
| `search-evaluator.test.ts` | 36 | Query evaluation |
| `task-state-machine.test.ts` | 29 | State transition table |
| `features.test.ts` | 20 | Feature flags |
| `derive-code.test.ts` | 13 | Code slugification |
| `permissions.test.ts` | 11 | Violation detection |
| `watchdog.test.ts` | 11 | Watchdog timeout behavior |

### Coverage Gaps (modules with no dedicated test coverage)

**High risk for rewrite (load-bearing, untested):**
- `src/cli/tui/review.ts` (1,845 lines) — Full-screen review TUI, zero test coverage
- `src/cli/tui/renderer.ts` (575 lines) — TUI renderer, zero coverage
- `src/cli/tui/terminal.ts` (145 lines) — Terminal abstraction, zero coverage
- `src/supervisor/builder.ts` (356 lines) — Supervisor-side builder logic, indirect only
- `src/supervisor/pushback.ts` (80 lines) — Permission pushback flow, indirect only
- `src/capture/claude.ts` (1,044 lines) — Docker build/launch monolith, mocked in all tests

**Medium risk (functional but untested internals):**
- `src/runner/docker-runner.ts` (411 lines) — Docker runner, e2e only
- `src/runner/host-process-runner.ts` (564 lines) — Host process runner, e2e only
- `src/import/claude-code-logs.ts` (431 lines) — JSONL log parser
- `src/utils/lock.ts` (129 lines) — Per-task file locks
- `src/utils/storage-lock.ts` (166 lines) — Global storage write lock
- `src/utils/reconcile.ts` (836 lines) — Reconciler (complex, covered only indirectly)

**Low risk (small or simple):**
- `src/agent/claude-code-packaging.ts` (81 lines)
- `src/agent/qa-agent.ts` (90 lines)
- `src/shell/detect.ts` (259 lines)
- `src/utils/markdown.ts` (61 lines)
- `src/server/templates.ts` (1,509 lines) — Large but purely presentational

---

## 3. Planned Abstractions Summary

These are from backlog tasks identified in the task prompt. Each represents a design improvement
that a rewrite could incorporate from day one:

### 3.1 Task Manager / Storage Manager (`spike-task-manager`, `refactor-storage-manager`)

**Problem:** Business logic (validation, state transitions, side effects) is scattered across
CLI commands, MCP tools, and utility functions. The Storage interface is pure CRUD — it doesn't
enforce invariants.

**Solution:** A `TaskManager` layer between CLI/MCP and Storage that owns:
- State transition validation (currently in `task-state-machine.ts` but called ad-hoc)
- Side effects (worktree creation/cleanup, branch management)
- Event emission for observers (daemon, sync, etc.)

**Rewrite impact:** This is the single most impactful abstraction. It would eliminate the
CLI/MCP duplication problem and provide a natural API layer.

### 3.2 Unified Command Layer (`refactor-cli-mcp`)

**Problem:** CLI commands and MCP tools implement the same operations independently, with
divergent behavior, different validation, and duplicated code. `accept.ts` (848 lines) and
the MCP `lazy_accept` handler (~200 lines in `tools.ts`) do the same thing differently.

**Solution:** Shared command definitions that both CLI and MCP dispatch to. Each command is
a function with typed input/output, and CLI/MCP are thin adapters.

**Rewrite impact:** Would reduce total command code by ~40%. Natural complement to TaskManager.

### 3.3 Programmable API (`spike-lazy-api`)

**Problem:** Lazy is CLI-first. Programmatic access requires subprocess spawning or
direct storage manipulation.

**Solution:** A proper TypeScript API layer (above TaskManager) that CLI, MCP, daemon RPC,
and external callers all use.

**Rewrite impact:** Shapes the entire architecture. In a rewrite, this would be the top-level
public interface.

### 3.4 Merge Train (`spike-merge-train`)

**Problem:** Subtask merges can conflict with each other. Currently, conflicts are resolved
manually one at a time.

**Solution:** Daemon-managed merge queue that orders subtask merges, detects conflicts early,
and serializes the merge process.

**Rewrite impact:** Requires daemon event system and proper task tree operations. Moderate
complexity, but builds on TaskManager.

### 3.5 Check Gates (`add-check-gates`)

**Problem:** Post-turn and pre-accept verification is ad-hoc (a single shell command in config).

**Solution:** Configurable check pipeline with named gates, pass/fail semantics, and
integration with the supervisor turn lifecycle.

**Rewrite impact:** Extends supervisor phases. Moderate complexity.

### 3.6 Agent Tool Permissions (`restrict-agent-mcp`)

**Problem:** Agents have access to all MCP tools. Some operations (accept, reject, close)
should require explicit human approval even when agents request them.

**Solution:** Permission model on MCP tools: always-allowed, requires-confirmation (current
two-step), never-allowed. Configurable per task type.

**Rewrite impact:** Small, builds on existing confirmation protocol.

### 3.7 Idempotent State Machine (`audit-state-transitions`)

**Problem:** State transitions are validated but not retriable or idempotent. A crash during
a transition can leave inconsistent state.

**Solution:** Each transition becomes an atomic operation with pre-conditions, action, and
post-conditions. Failed transitions can be retried safely.

**Rewrite impact:** Core to TaskManager design. Should be built in from day one.

### 3.8 Storage Index (`filestorage-index-v2`)

**Problem:** FileStorage scans all task directories for queries. Slow at scale.

**Solution:** Maintain an index file that maps status, code, and other fields to task IDs.
Updated on every write.

**Rewrite impact:** FileStorage-specific optimization. Independent of other abstractions.

### 3.9 Unified Abandon (`unify-abandon`)

**Problem:** `close` and `reject` have overlapping semantics. Both end a task without
merging, with slightly different cleanup behavior.

**Solution:** Single `abandon` operation with a reason field. `reject` becomes `abandon`
with agent feedback, `close` becomes `abandon` without.

**Rewrite impact:** Simplifies state machine and CLI surface. Small but improves clarity.

---

## 4. Proposed Architecture Sketch

### Layer Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Entry Points                          │
│  CLI (src/cli/)  │  MCP (src/mcp/)  │  Daemon RPC  │  API   │
│      Thin adapters: parse args/JSON, format output           │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      Command Layer                           │
│  Shared command definitions with typed input/output          │
│  Each command is a pure function: Input → Result             │
│  Handles: validation, confirmation protocol, error mapping   │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      Task Manager                            │
│  Business logic layer — the "brain" of lazy                  │
│  Owns: state transitions, side effects, event emission       │
│  Methods: create, start, unblock, accept, reject, close...   │
│  Enforces: invariants, permissions, idempotency              │
└──────┬──────────┬──────────┬──────────┬──────────┬───────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────┐ ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────────┐
│ Storage │ │  Git    │ │ Runner │ │ Remote │ │ Supervisor │
│Interface│ │  Ops    │ │Interface│ │ Driver │ │  Protocol  │
└─────────┘ └─────────┘ └────────┘ └────────┘ └────────────┘
```

### Key Design Decisions

**1. Command Layer replaces CLI/MCP duplication**

```typescript
// Shared command definition
interface AcceptCommand {
  taskId: string;
  reason?: string;
  wait?: boolean;
  confirmationCode?: string;
}

interface AcceptResult {
  merged: boolean;
  mergeCommitSha?: string;
  pendingCI?: boolean;
  conflict?: MergeConflict[];
}

async function executeAccept(ctx: CommandContext, cmd: AcceptCommand): Promise<AcceptResult>;

// CLI adapter (thin)
async function cliAccept(args: string[]): Promise<void> {
  const cmd = parseAcceptArgs(args);
  const result = await executeAccept(ctx, cmd);
  formatAcceptOutput(result);
}

// MCP adapter (thin)
async function mcpAccept(params: Record<string, unknown>): Promise<ToolResult> {
  const cmd = parseAcceptParams(params);
  const result = await executeAccept(ctx, cmd);
  return formatAcceptToolResult(result);
}
```

**2. TaskManager owns all state transitions**

```typescript
class TaskManager {
  constructor(
    private storage: Storage,
    private git: GitOperations,
    private runner: Runner,
    private remote: RepositoryDriver,
    private events: EventEmitter,
  ) {}

  async accept(taskId: string, opts: AcceptOptions): Promise<AcceptResult> {
    const task = await this.storage.getTask(taskId);

    // All validation in one place
    assertValidTransition(task.status, 'complete');
    await this.assertParentNotWorking(task);
    await this.assertWorktreeClean(task);

    // Atomic operation with rollback
    const tx = this.storage.beginTransaction();
    try {
      const mergeResult = await this.git.merge(task.branch, parentBranch);
      await tx.updateTaskStatus(taskId, 'complete');
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    // Side effects after successful commit
    this.events.emit('task:accepted', { taskId, mergeResult });
    await this.reparentChildren(task);
    await this.cleanupWorktree(task);

    return mergeResult;
  }
}
```

**3. Daemon as event-driven core**

The daemon should evolve from a polling reconciler to an event-driven system:
- TaskManager emits events on state changes
- Daemon subscribes to events and triggers: sync, reconcile, auto-resume, merge train
- `wait` becomes event subscription instead of polling
- Reconciler becomes a fallback consistency check, not the primary mechanism

**4. Storage interface stays, but gets simpler**

The current ~60-method Storage interface has accumulated methods for every entity type.
A rewrite should:
- Keep the interface abstraction (FileStorage, PostgresStorage, RemoteStorage)
- Add a transaction model for atomic multi-entity operations
- Add an index layer (FileStorage-specific) for fast queries
- Consider splitting into sub-interfaces: `TaskStore`, `SessionStore`, `TurnStore`, etc.

**5. Runner interface stays as-is**

The Runner abstraction is clean. Docker/Podman/HostProcess are well-separated.
Keep the interface, clean up implementations.

**6. Supervisor simplifies with better protocol**

The supervisor's 5-phase pipeline is correct but hard to follow in code. A rewrite should:
- Make each phase an explicit, named step with typed input/output
- Extract merge logic into a shared module (used by both supervisor and accept)
- Make the protocol bidirectional (currently it's request-response with polling)

---

## 5. Phased Effort Estimate

### Phase 0: Foundation (4-5 tasks, ~1 week)
Bootstrap the new codebase structure.

| Task | Complexity | Description |
|------|-----------|-------------|
| 0.1 | Simple | Project scaffold: package.json, tsconfig, directory structure |
| 0.2 | Medium | Core types: Task, Session, Turn, Commit, Comment, state machine |
| 0.3 | Medium | Storage interface + FileStorage (tasks, sessions CRUD) |
| 0.4 | Simple | Git operations module (port existing, clean up) |
| 0.5 | Simple | Config loader (TOML parsing, defaults, env overrides) |

### Phase 1: Task Manager (5-6 tasks, ~2 weeks)
The new business logic layer — the heart of the rewrite.

| Task | Complexity | Description |
|------|-----------|-------------|
| 1.1 | Complex | TaskManager: create, edit, clone, state transitions |
| 1.2 | Complex | TaskManager: start (worktree, branch, runner launch) |
| 1.3 | Complex | TaskManager: accept (merge, CI wait, reparent, cleanup) |
| 1.4 | Medium | TaskManager: reject, close, reopen, redo |
| 1.5 | Medium | TaskManager: unblock (feedback, upstream merge, resume) |
| 1.6 | Medium | Full FileStorage (turns, commits, comments, conversations, search) |

### Phase 2: Command Layer + CLI (5-6 tasks, ~1.5 weeks)
Shared commands with CLI as first adapter.

| Task | Complexity | Description |
|------|-----------|-------------|
| 2.1 | Medium | Command layer framework + 5 creation commands |
| 2.2 | Medium | Lifecycle commands (start, resume, unblock, accept, reject, close) |
| 2.3 | Medium | Inspection commands (list, show, status, diff, search) |
| 2.4 | Simple | Utility commands (comment, shell, wait, propose) |
| 2.5 | Medium | Infrastructure commands (init, doctor, completion, system) |
| 2.6 | Simple | CLI entry point, arg parsing, error handling, help |

### Phase 3: Supervisor + Protocol (4-5 tasks, ~1.5 weeks)
Container-side execution pipeline.

| Task | Complexity | Description |
|------|-----------|-------------|
| 3.1 | Medium | Protocol types and file-based IPC |
| 3.2 | Complex | Supervisor turn pipeline (5 phases) |
| 3.3 | Medium | Agent interface + ClaudeCode/Cursor/QA implementations |
| 3.4 | Medium | Builder HTTP bridge (container -> host MCP) |
| 3.5 | Medium | Permissions, pushback, watchdog |

### Phase 4: Runner + Docker (3-4 tasks, ~1 week)
Execution backends.

| Task | Complexity | Description |
|------|-----------|-------------|
| 4.1 | Medium | Runner interface + HostProcess implementation |
| 4.2 | Medium | Docker runner + toolchain registry + image build |
| 4.3 | Simple | Podman runner (extends Docker) |
| 4.4 | Simple | Capture module (auth env, model resolution) |

### Phase 5: MCP + Daemon (4-5 tasks, ~1.5 weeks)
The other entry points beyond CLI.

| Task | Complexity | Description |
|------|-----------|-------------|
| 5.1 | Medium | MCP tool handlers (using command layer) |
| 5.2 | Medium | Confirmation protocol for destructive MCP tools |
| 5.3 | Complex | Daemon: Unix socket server, RPC handlers, reconciler |
| 5.4 | Medium | RemoteStorage proxy through daemon |
| 5.5 | Simple | Daemon lifecycle management |

### Phase 6: Remote + Sync (4-5 tasks, ~1.5 weeks)
Forge integration.

| Task | Complexity | Description |
|------|-----------|-------------|
| 6.1 | Complex | RepositoryDriver interface + GitHub implementation |
| 6.2 | Complex | GitLab driver implementation |
| 6.3 | Simple | Local driver (no-op implementation) |
| 6.4 | Medium | Sync command (bidirectional comment/state sync) |
| 6.5 | Medium | Import: Claude Code log parser, conversation storage |

### Phase 7: Polish + Remaining (5-7 tasks, ~1.5 weeks)
Everything else.

| Task | Complexity | Description |
|------|-----------|-------------|
| 7.1 | Complex | TUI review (two-panel, navigation, diff rendering) |
| 7.2 | Medium | Web dashboard server |
| 7.3 | Medium | PostgresStorage implementation |
| 7.4 | Medium | Search engine (parser + evaluator) |
| 7.5 | Medium | Prompts system (20 prompt files, template substitution) |
| 7.6 | Simple | Upgrade command, shell detection, QA agent |
| 7.7 | Medium | Loop command, pair command, builder command |

### Summary

| Phase | Tasks | Weeks | Can parallelize with |
|-------|-------|-------|---------------------|
| 0: Foundation | 4-5 | 1.0 | — |
| 1: Task Manager | 5-6 | 2.0 | — |
| 2: Command Layer + CLI | 5-6 | 1.5 | Phase 3, 4 |
| 3: Supervisor + Protocol | 4-5 | 1.5 | Phase 2, 4 |
| 4: Runner + Docker | 3-4 | 1.0 | Phase 2, 3 |
| 5: MCP + Daemon | 4-5 | 1.5 | Phase 6 |
| 6: Remote + Sync | 4-5 | 1.5 | Phase 5 |
| 7: Polish + Remaining | 5-7 | 1.5 | — |
| **Total** | **36-42** | **10-12 sequential** | **5-6 with 3 parallel agents** |

---

## 6. Risk Assessment

### Highest Risk: Reconciler Behavior

The reconciler (`src/utils/reconcile.ts`, 836 lines) is the most complex state management
code. It runs every 5 seconds and handles:
- Detecting interrupted/crashed containers
- Auto-resuming tasks (with circuit breaker)
- Zombie detection
- Merge status reconciliation
- CI failure injection

It has only **indirect** test coverage through e2e tests. A rewrite would need to very
carefully reproduce its timing behavior, grace periods, and edge cases. The existing tests
cover the happy paths but not the race conditions that the reconciler is designed to handle.

### High Risk: Accept Flow

`accept.ts` (848 lines) is the most complex single command. It handles:
- Merge into parent branch (local or remote)
- CI wait with timeout
- Conflict detection and resolution prompts
- Re-parenting child tasks
- Worktree/branch cleanup
- Remote PR creation and merge

A regression in accept would be catastrophic — it's the operation that permanently changes
the codebase. The test suite covers the main paths well (56 tests across multiple test files)
but the interaction between all these steps is hard to test in isolation.

### High Risk: Supervisor Phase Pipeline

The supervisor runs inside Docker containers where debugging is difficult. Its 5-phase
pipeline has subtle ordering requirements:
1. Sync with remote (fetch latest)
2. Pre-turn sync with upstream (merge parent)
3. Work (agent execution with retry and watchdog)
4. Permission pushback (violation detection, self-correction chance)
5. Post-turn check and sync

Phase timing, one-shot mode (memory reclamation), and crash recovery are poorly tested.

### Medium Risk: Docker/Container Networking

The builder HTTP bridge requires container-to-host networking. Docker for Mac, Linux, and
CI environments all have different networking stacks. The current code handles this with
platform detection in `capture/claude.ts`. A rewrite needs to preserve these workarounds
without understanding why they exist (no documentation).

### Medium Risk: TUI Components

The TUI (`review.ts`, 1,845 lines) has zero test coverage. It handles raw terminal I/O,
ANSI escape codes, keyboard navigation, and screen rendering. A rewrite would need to either:
- Port it exactly (fragile, no specification)
- Rewrite it with a TUI framework (scope creep)
- Skip it initially and add it later (breaks `lazy review` and `lazy loop`)

### Lower Risk: Storage Interface

The Storage interface is well-specified by its 56 Postgres tests and 20 RemoteStorage tests.
FileStorage is the most complex implementation but its behavior is well-defined by the
interface contract. A rewrite of Storage is one of the safer phases.

### Lower Risk: Search Engine

The search parser and evaluator have 86 unit tests. The query language is well-specified.
This is one of the most portable modules.

### Incremental vs. Big-Bang

**Big-bang rewrite risks:**
- 10-12 weeks of parallel development with no shippable output
- Feature drift — the current codebase continues evolving
- "Almost done" syndrome — the last 20% takes 80% of the time
- Hidden dependencies between modules only discovered at integration

**Incremental rewrite viability:**
The codebase has clean interfaces at the boundaries (Storage, Runner, Agent, Protocol,
RepositoryDriver). The problems are in the middle layer — scattered business logic and
CLI/MCP duplication. This middle layer can be replaced incrementally:

1. Introduce TaskManager wrapping existing Storage + ad-hoc logic
2. Migrate commands one at a time to use TaskManager
3. Introduce Command Layer, migrate CLI commands to use it
4. Add MCP as second adapter to Command Layer
5. Each step is independently shippable and testable

---

## 7. Recommendation

### Verdict: Incremental refactor, not big-bang rewrite

**The architecture is ~70% right.** The five core interfaces (Storage, Runner, Agent,
Protocol, RepositoryDriver) are clean and well-tested. The problems are in the missing
middle layer (TaskManager, Command Layer) and accumulated duplication between CLI and MCP.

A full rewrite would:
- Take 36-42 tasks over 10-12 weeks (5-6 weeks with parallelism)
- Risk regressions in the reconciler, accept flow, and supervisor pipeline
- Require a feature freeze during development
- Need to reproduce ~1,700 test behaviors

An incremental refactor would:
- Take 15-20 tasks over 4-6 weeks
- Ship each step independently (no feature freeze)
- Use existing tests to validate each migration step
- Be reversible if any step introduces regressions

### Recommended Incremental Sequence

**Step 1: `refactor-cli-mcp` — Unified Command Layer (4-5 tasks)**
Extract shared command definitions from CLI commands. Start with `accept`, `reject`, `close`
(highest duplication). CLI becomes a thin adapter. MCP tools switch to call commands instead
of reimplementing.

**Step 2: `refactor-storage-manager` — Task Manager (3-4 tasks)**
Introduce `TaskManager` between Command Layer and Storage. Migrate state transition logic,
validation, and side effects out of individual commands. This is where idempotent state
transitions (`audit-state-transitions`) get built in.

**Step 3: `audit-state-transitions` — Idempotent State Machine (1-2 tasks)**
Already natural once TaskManager exists. Add transaction support, pre/post-conditions,
rollback. Existing `task-state-machine.ts` evolves into this.

**Step 4: `unify-abandon` — Simplify Terminal States (1 task)**
With TaskManager owning transitions, merge close/reject into a single `abandon` operation.
Small, low-risk, improves API clarity.

**Step 5: `spike-lazy-api` — Public API (2-3 tasks)**
Once TaskManager + Command Layer exist, expose them as a proper TypeScript API.
CLI, MCP, daemon, and external callers all go through this API.

### Conditions Where Full Rewrite Makes Sense

A full rewrite would be justified if:
1. **Storage interface needs fundamental changes** (e.g., moving to event sourcing) — but
   the current CRUD model works well.
2. **Test suite is inadequate** — but 1,694 tests is substantial specification.
3. **Multiple fundamental abstractions are wrong** — but the boundaries are right; only the
   middle layer is missing.
4. **The agent can actually do it** — this spike is partly about whether an agent can rebuild
   a complex system from tests. The answer is: probably, but the risk-reward ratio favors
   incremental improvement.

### Autonomy Exercise Verdict

Can agents rebuild Lazy from its tests? **Likely yes, but with caveats:**
- The test suite specifies CLI behavior well (1,140 e2e tests)
- It does NOT specify: TUI rendering, Docker networking, reconciler timing, container I/O
- An agent would need human guidance for the ~30% of behavior that lives outside tests
- Estimated 36-42 tasks is within agent capability, but quality would degrade in later phases
  as integration complexity grows

**Bottom line:** The existing codebase is worth improving incrementally, not replacing.
The backlog tasks already identified (`refactor-cli-mcp`, `refactor-storage-manager`,
`audit-state-transitions`) would address the architectural gaps without the risks of
a ground-up rewrite.
