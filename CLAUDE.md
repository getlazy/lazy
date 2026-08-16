# Lazy Development Guidelines

These guidelines apply to all agents working on tasks in this repository.

## Scope: development OF lazy is NOT development WITH lazy

Everything in this file is about lazy's own codebase. It does NOT apply to repositories that are merely *developed with* lazy. Specifics here — `Dockerfile.lazy` shipping bubblewrap/socat/PostgreSQL, the e2e harness rules, the Storage invariants — are about developing lazy itself; projects built *with* lazy (node web servers, Ruby+Rust services, …) have their own toolchains and rules. Also remember lazy's images are built and used locally: an image reflecting whoever built it is by design, not a defect.

## Running Lazy

Always run lazy with `bun run ./src/index.ts` — never `npx bun run`. The `npx` wrapper hangs indefinitely when stdin is piped (see anthropics/claude-code#27401).

```bash
bun run ./src/index.ts list                                # Good
echo "feedback" | bun run ./src/index.ts unblock <task_id> # Good
npx bun run ./src/index.ts list                            # Bad — hangs with piped stdin
```

## CRITICAL: Never Lose Human Feedback

**This is the single most important invariant in Lazy.** Human feedback — edits in `$EDITOR`, review comments, close reasons, notes — must be durably saved before any operation that can fail (auth checks, Docker launches, network calls) gets a chance to lose it.

1. **Save first, act second.** Persist editor/prompt input to durable storage (database or file) immediately after the editor closes; only then run anything that might fail.
2. **Pre-flight before editor.** Every check that can fail (authentication, Docker availability, locks) runs BEFORE `$EDITOR` opens. The human must never type feedback only to have a pre-flight failure discard it.
3. **Recovery files.** If content cannot reach the database yet, write it to `.lazy/recovery/` — these survive crashes.
4. **Never silently discard.** If feedback cannot be delivered (e.g. container launch fails), it must still be preserved, and the human told how to retrieve or re-submit it.

## Architectural Invariants

Load-bearing design decisions, each learned the hard way. Do NOT change, "optimize away," or weaken them without explicit human approval.

### Upstream merge is sync's job, not unblock's

Unblock only delivers feedback, with zero network dependencies. Upstream merges happen via `lazy sync <task>`, daemon signals, or the builder. To merge upstream before giving feedback, run `lazy sync <task>` first.

### Storage is abstracted — never bypass it

All persistent state (tasks, sessions, turns, commits, comments, conversations) goes through the Storage interface (`src/storage/interface.ts`). Never read/write `.lazy/` or other stores directly from CLI commands or other modules — FileStorage is just one backend. New entity type → add Storage interface methods first, then implement in FileStorage.

**Carve-out: disposable telemetry is not storage state.** Bounded, project-local, throwaway streams live OUTSIDE Storage deliberately. The one instance today is the proxy audit log (`src/proxy/audit-log.ts`, `.lazy/logs/proxy-audit.jsonl`); when it lived in the store it grew to 677 MiB and broke a store push. Do not "fix" it back into Storage. Anything new claiming this carve-out must be bounded by construction (rotation or hard cap) and disposable — if losing it costs the user anything, it belongs in Storage.

### The daemon owns business logic — CLI, MCP, and supervisor are clients

The daemon is the heart and brain: all business logic, storage access, and state management live there, behind its RPC. The CLI is a human-facing client (parse input, format output, interactive prompts), MCP is an agent-facing client (tool schemas, pushback/confirmation logic), and the supervisor is an agent-lifecycle client. Violations to reject on sight: opening storage from CLI/MCP/web code, re-implementing a business rule in a client, or spawning the lazy CLI from the daemon or an MCP handler. In tests, mock at the external boundary (the agent process, forge APIs, Docker) rather than internal seams — the fake-binary seam exists for exactly this; prefer it for new coverage where the distinction matters.

### Tests encode invariants, not just current behavior

Every test that encodes a design decision gets a comment explaining WHY:

```typescript
// INVARIANT: Upstream merge is sync's job, not unblock's.
// Unblock only delivers feedback — sync handles merging upstream.
test('unblock does NOT trigger upstream merge', ...);
```

Never add tests that assert the absence of correct behavior. Never modify or delete existing invariant tests without human approval — if a test seems wrong, ask; don't "fix" it to match your new code.

### Non-interactive CLI invocations use --yes flags

Programmatic invocations (MCP handlers, supervisors, scripts) skip confirmation prompts with `--yes` — never with `LAZY_PROMPT_DEFAULTS`, which is test-only. Every command with a confirmation prompt should accept `--yes`.

### Documented short flags must be registered as parseFlags aliases

`parseFlags` registers `--<name>` only; a single-dash spelling exists only if declared, e.g. `{ name: 'message', aliases: ['m'], takesValue: true }`. Documenting a short flag in usage text without the alias ships a broken flag (exactly how `lazy unblock -f` shipped broken) — always add both together. `test/unit/cli-flag-alias-coverage.test.ts` scans every `<name>Usage()` against its `command<Name>()` flag table and fails on drift.

Never register `--help`/`-h` as a command's own flag: the dispatcher in `src/index.ts` intercepts both first, so such a flag is dead code and a `-h, --help` usage line is noise.

### Multiplexer subcommands must be listed in the parent's usage map

`lazy system <sub>` and `lazy daemon <sub>` route `-h`/`--help` through `<parent>SubcommandUsage` in the dispatcher. A subcommand with its own `<name>Usage()` that is missing from that map silently prints the PARENT's help — no error anywhere. Add the map entry with the subcommand. `test/unit/cli-subcommand-usage-coverage.test.ts` cross-checks both directions and fails on drift.

### Prompts are for the user's project, not for lazy itself

Agent system prompts (`src/prompts/`) are injected into agents working on the USER's codebase. No lazy-internal design decisions, invariants, or implementation details in them — those live here in CLAUDE.md.

### Never use Bun.spawn/Bun.spawnSync directly

Use `spawn()`/`spawnSync()` from `src/utils/spawn.ts` — they turn raw ENOENT (`posix_spawn`) failures into clear messages naming the missing binary or path. The only exception is `src/utils/spawn.ts` itself.

### Never use sync filesystem calls

Use `fs/promises`. Sync calls (`readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`, `statSync`, …) block the entire event loop and have caused real production issues (reconciler starvation, blocked HTTP handlers) — and sync calls in "cold" code migrate into hot paths unnoticed. Acceptable **only** in: CLI startup/init before the event loop matters, process exit handlers, test setup/teardown. Any other sync call needs a comment explaining why async isn't viable.

### Fail hard on remote failures — no silent fallbacks

Remote operations (push, fetch, MR/PR creation) retry up to 3 attempts with progressive backoff (2s, 4s) — use `withRemoteRetry()` from `src/utils/retry.ts` in drivers. If all retries fail, the operation FAILS: no silent fallback to local-only behavior, and `success: true` with a warning is NEVER acceptable. The caller decides how to handle failure, not the utility function.

Before a remote merge (accept), the parent branch's local commits MUST be pushed first — otherwise the remote parent gets the merge commit without them and diverges.

### PRs only for protected branches

PRs/MRs are created only when merging into a protected branch (one where non-admins cannot force-push or merge without review). Subtask→parent merges are local git operations, never remote MRs.

### The MCP surface is deliberately narrower than the CLI

Humans and agents make different mistakes, so CLI and MCP are not mirror images. Agent-ownership gating, two-step `confirmation_code` friction, "MCP never auto-starts work", and human-only commands (`lazy approve`, `lazy protect`) are design decisions, not gaps — do not "fix" them into symmetry. The full list with rationale is [docs/surface-asymmetries.md](docs/surface-asymmetries.md): read it before filing a CLI/MCP difference as a bug, and add to it when introducing a deliberate asymmetry. Differences NOT listed there are probably real gaps — [docs/reviews/cli-mcp-parity-audit-2026-08.md](docs/reviews/cli-mcp-parity-audit-2026-08.md) classifies the known ones.

## Working Like a Team Member

Rule of thumb: **"Would I as a reviewer do this?"** The human reviewer approves your work; you are responsible for making it merge-ready.

- **Merge conflicts are yours to resolve:** merge the parent branch into your branch, resolve, verify correctness, run tests, commit with a clear message. Never leave conflicts for the human.
- **NEVER commit to `main`.** Verify you are on your task branch (`git branch --show-current`). In a worktree, use the worktree path for ALL git operations — `cd`-ing to the parent repo and committing there lands changes on `main`.
- Commit at logical checkpoints; multiple small commits beat one large one; explain design decisions in commit messages or code.
- Do NOT commit secrets/credentials, build artifacts, `node_modules`, or IDE files unless explicitly part of the solution.
- If requirements are unclear, ask for clarification.

## Code Quality

Follow existing code style; add comments only where logic isn't self-evident; test your changes.

### Error handling: never swallow, always surface

Every `catch` block either handles the error meaningfully or propagates it with context:

1. **No empty `catch {}` blocks** — ever, including `catch { /* ignore */ }`. A genuinely-safe suppression needs a comment saying exactly why and what you verified.
2. **Add context when re-throwing.** ``throw new Error(`failed to parse ${configPath}: ${err.message}`)`` — not a bare `throw err`.
3. **Don't catch-log-continue when the operation failed.** If the function can't do its job, throw; the caller decides what to do.
4. **Distinguish "not found" from "found but broken."** A missing config file falls through to defaults (`err.code === 'ENOENT'`); a config file that exists but won't parse is an error the user must see immediately — re-throw with context.
5. **Errors are for humans.** Say what happened, what was being attempted, and what to do about it — with the actual values (paths, keys, expected vs actual).

### Principle of least surprise

Lazy's behavior must be predictable, especially user-facing behavior.

- **Commands do what their name says** — `lazy accept` accepts; no silent rebases or extra side effects. If a command must do something extra, tell the user first.
- **No hidden side effects** — writing `~/.claude.json`, starting background processes, touching unmentioned branches are all bugs unless explicit and visible.
- **Errors are actionable** — "Docker not running. Start Docker Desktop or configure `runner = "host-process"` in lazy.toml", never "Error: command failed".
- **Flags do one thing** — no magic values or mode-switching overloads.
- **Defaults are safe** — destructive or risky behavior requires explicit flags; never make the dangerous path the easy path.

### Fix root causes, not symptoms

Never paper over a performance bug with pagination, caching, or lazy-loading. If something is fast after a daemon restart and degrades over time, the bug is in whatever is accumulating state — fix that, not the display layer. First diagnostic question: slow from the start, or degrading?

### Never present a guessed cause as the explanation

When something fails, read the actual code path before asserting why. A plausible-sounding fabricated cause ("must be a protected-branch rule") is worse than "I don't know yet, let me check" — in summaries, reviews, and error analysis alike. If you can't verify a cause, say so and investigate.

### Clever ain't wise

- **Straightforward over magical.** Don't auto-detect, auto-infer, or auto-correct when explicit input is available; if something is ambiguous, ask rather than guess.
- **Consistent over convenient.** Same patterns across commands — if `accept` takes `--yes`, so do `reject` and `close`. No per-command special syntax.
- **Transparent over terse.** Narrate what's happening ("Merging upstream into task branch..."); the user should never be surprised by what `git log` shows after a lazy command.

## Security

Never commit sensitive information. Validate user input at system boundaries. Parameterized queries only — never string concatenation for SQL. Mind the common vulnerabilities (XSS, SQL injection, etc.).

## Logging

Lazy's central logger is `src/utils/logger.ts` (writes to console and log files, adds timestamps, respects verbose/debug flags). Use `logger.info/warn/error/debug` for all output after logger init — progress, errors, debug info, state changes.

`console.*` is allowed **only** for: pre-logger startup code (`src/index.ts` early startup, `src/config/loader.ts`, `src/cli/init.ts`); explicit debug-mode output (prefix `[DEBUG]`); help/usage text; and final formatted output (summary tables, task listings, status reports).

**CRITICAL: never duplicate a message at different layers of the application.**

## Prompts

All prompts (system prompts, task templates, goal context) live in `src/prompts/` as `.md` files — never inline prompts as string literals. Import with `import myPrompt from '../prompts/my-prompt.md' with { type: 'text' };` so prompts stay discoverable, diffable, and editable without touching code. Variable substitution uses `{{placeholder}}` syntax and `.replace()` at the call site.

## CHANGELOG style

The CHANGELOG is for a 30-second human scan of what's new, changed, or fixed — not a record of *how* it was built (that depth lives in each task's history and journal).

- **One line per entry.** If you can't say it in a line, the depth belongs in the task.
- **State the user-visible effect, not the implementation.** No internal type/function names; command names, config keys, and flags are fine — they're the user surface.
- **Reference the task code in parens as the depth pointer**, e.g. `(daemon-operator-tooling)`.
- **Intro paragraph: 3 sentences max.**

Example entry:

- **`lazy daemon list` / `kill-stray`** — see and reap stray daemons host-wide (`daemon-operator-tooling`)

Keep the `Added` / `Changed` / `Fixed` structure. This standard applies going forward — don't rewrite older sections to match.

## End-to-End Testing

The e2e suite in `test/e2e/` runs CLI commands as subprocesses with mocked agent responses. **Any new command or behavior change needs e2e coverage:** new command → new `test/e2e/<command>.test.ts`; behavior change → extend the existing file; bug fix → a test that reproduces the bug first.

### Running tests

```bash
bun test test/e2e/create.test.ts       # single file — the supported mode
bun test --timeout 30000 test/e2e/     # multi-file: --timeout REQUIRED
bun test                               # whole suite (slow suites skipped)
LAZY_SLOW_TESTS=1 bun test             # include the opt-in slow suites
```

**Before accepting a task, run the FULL unit suite (`bun test test/unit/`) in its worktree** — not just the task's new tests plus typecheck. A signature change elsewhere can leave a pre-existing test stale while everything task-local passes. Classify any failure as pre-existing vs introduced by verifying it yourself, never by relaying the agent's claim.

**Multi-file runs require `--timeout 30000` on the command line.** The npm scripts (`bun run test`, `test:e2e`, `test:all`) pass it for you — `test/unit/test-timeout-coverage.test.ts` keeps them honest — but a bare `bun test <dir>` does not. The flag is the ONLY working mechanism: bunfig's `[test] timeout` key is silently ignored by bun (never add it back), and `setDefaultTimeout()` in the preload reaches exactly ONE file per run — every other file falls back to bun's built-in 5000ms, which is under normal e2e wall-clock. That's why every suite passes alone while bare aggregate sweeps invent hundreds of phantom `timed out after 5000ms` failures. **A bare multi-file `bun test` result is not evidence of anything.** A per-test `test(name, fn, ms)` override still wins.

**Per-file execution is the supported mode.** Each `withDaemon: true` suite starts a real daemon on a TCP port from a bounded window (26024+). Full-directory runs spin up many daemons; any skipped teardown leaks daemons that exhaust the port window and fail later suites with spurious bind errors. Treat a green per-file run as authoritative and a red full-suite run as suspect until reproduced per-file.

**Slow suites are opt-in.** `test/e2e/daemon.test.ts` and `test/e2e/remote-storage.test.ts` (>300s each) skip unless `LAZY_SLOW_TESTS=1` (test-only, same family as `LAZY_FORCE_TTY`/`LAZY_PROMPT_DEFAULTS`) via `describe.skipIf(slowSuiteSkipped(...))` from `test/helpers/slow-suite.ts`. Skipped files print one line each, so a default run is never silently green-by-omission. Run them before touching the daemon or RemoteStorage, and in any pre-accept/full-verification pass.

**Linux sandbox prerequisite.** Suites that launch an agent under the OS sandbox need `bwrap` and `socat` on PATH (packages `bubblewrap`, `socat`); without them `checkAvailability()` aborts before any assertion with sandbox errors unrelated to the code under test. Agents working on lazy in a container get them for free: `Dockerfile.lazy` ships both plus PostgreSQL 15 (installed, not running; `LAZY_POSTGRES_URL=$(lazy-pg-start)` starts it) — do NOT `apt-get install` them; if missing, your image predates that change and needs a rebuild. See `docs/agent-container.md`. Only suites passing `hostPermissionMode: 'sandbox'` touch the sandbox (fake-binary suites default to `permission_mode = "bypass"`), and such suites self-gate with `sandboxSuiteSkipped()` from `test/helpers/sandbox-deps.ts` — a skip prints one line, and **a skip is not a pass**. Config-surface/argv-only suites (`host-sandbox-posture`, `test/unit/host-sandbox-posture.test.ts`) never spawn an agent and need no gate.

**Three reapers keep leaked daemons in check** (in coverage order):

1. `ctx.cleanup()` in `afterEach` — SIGTERM by pidfile, SIGKILL escalation, then a command-line sweep. The happy path.
2. Process-death handlers in `test/helpers/daemon-registry.ts` — cover Ctrl-C and crashes where no `afterEach` runs; they print one line when they reap anything.
3. `LAZY_TEST_PARENT_PID` (`src/daemon/test-parent-watch.ts`) — the daemon polls the `bun test` pid and exits when it is gone. The only reaper that survives SIGKILL of the test process, and the only one that catches a daemon auto-started by a straggler subprocess after cleanup already ran.

If you add a new way to spawn a daemon from a test, route its env through `setupTestLazy`'s helpers so it inherits `LAZY_TEST_PARENT_PID` — otherwise it is leakable again.

**Isolate daemon tests along three axes**, or they pass in a container and fail on a Mac:

- **Daemon state → `LAZY_DAEMON_BASE_DIR`, never `HOME`.** It is the documented seam in `src/daemon/paths.ts` (moves socket/PID/token/log/lock together, nothing else); helpers in `test/helpers/daemon-base-dir.ts`. Redirecting `HOME` also moves credential discovery, `~/.gitconfig`, tool caches, and the default storage path — differently on a dev machine than in CI.
- **In-process daemons → pin `LAZY_CONFIG`** with `pinConfig()` from `test/helpers/pin-config.ts`. `loadConfig` walks up from cwd, which under `bun test` is lazy's OWN worktree, so an unpinned test daemon silently adopts lazy's `lazy.toml` — including the developer's live `[storage] external_path`. (`process.chdir()` is the weaker old workaround; an unrelated earlier chdir can mask the bug.)
- **Port squatters must bind the exact host the daemon binds** (`DEFAULT_SERVER_BIND`), never `Bun.serve`'s wildcard. On macOS/BSD `SO_REUSEADDR` lets a specific bind through a wildcard listener, so "the bind must fail" assertions silently invert on a Mac.

Prefer a probed free port over the shared 26024+ window whenever a test needs a real `daemon start` to SUCCEED — stray daemons can leave the window empty.

**Unit tests hit the same container-vs-Mac wall in three more places:**

- **A stand-in "other program" process is a SYMLINK to `/bin/sleep`, never a copy** — `argv[0]` names the process for `ps`/procfs either way, but copying a system binary trips macOS code-signing at exec. Use `startForeignProcess()` from `test/helpers/foreign-process.ts`; it also waits until the OS reports the holder live and non-zombie.
- **`realpath` a temp root before comparing against paths git printed.** git resolves every symlink; on macOS `tmpdir()` is under `/var` → `/private/var`, so hand-composed paths never match git's spelling. Linux hides this because `/tmp` is real.
- **A second loopback address is Linux-only** (macOS's `lo0` has just `127.0.0.1`). Gate such suites with `secondLoopbackSuiteSkipped()` from `test/helpers/second-loopback.ts` — it probes by binding and prints one line on skip, same never-silently-green rule as the other skip gates.

### How tests work

Each test creates an isolated lazy project in a temp dir (`/tmp/lazy-e2e-*`), runs `lazy init`, drives CLI subprocesses, asserts on stdout/stderr/exit codes, and cleans up. Agent responses are never real — `test/mocks/claude.ts` is injected via Bun `--preload` when `LAZY_TEST=1`.

```typescript
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy <command>', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestLazy(); });
  afterEach(async () => { await ctx.cleanup(); });

  test('does something successfully', async () => {
    const result = await ctx.lazy(['command', '--flag', 'value']);
    expectSuccess(result);
    expectOutput(result, 'expected output substring');
  });
});
```

`TestContext`: `ctx.lazy(args)` (real CLI, no mocks — for commands that don't invoke Claude), `ctx.lazyMocked(args, mockResponse)` (for commands that do), `ctx.git(...args)`, `ctx.cleanup()` (always, in `afterEach`). Assertions (`test/helpers/assertions.ts`): `expectSuccess`, `expectFailure`, `expectOutput`, `expectError`, `expectOutputExcludes`, `extractTaskId`. Fixtures (`test/helpers/fixtures.ts`): `MOCK_CLAUDE_SUCCESS`, `createTask(ctx, goal, prompt?)`.

### Two agent seams: the module mock and the fake binary

**1. The module mock (default).** `test/mocks/claude.ts` replaces all of `src/capture/claude.ts` via `--preload`, including `launchSupervisorAsync`. Fast; right for "a turn happened and produced this response" — status transitions, accept/unblock flows, CLI output. Structural limit: everything downstream of `launchSupervisorAsync` (watchdog kills, SIGTERM→SIGKILL escalation, stream-json parsing, response capture) is replaced and unreachable.

**2. The fake binary (`setupTestLazy({ fakeClaude: true })`, implies `withDaemon: true`).** Installs a scriptable fake `claude` on PATH (`test/helpers/fake-claude.ts`) and switches to the host-process runner; nothing in `src/` is mocked — the daemon really launches `lazy supervise`, which really spawns the fake agent. Use whenever the behavior under test IS the supervisor: watchdog kills, the agent argv contract (`--resume`, `--output-format stream-json`), stream-event handling.

```typescript
ctx = await setupTestLazy({ fakeClaude: true });
await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 's1' }));
await ctx.lazy(['start', taskId, '--yes']);
const invocations = await ctx.claudeInvocations();  // real argv the agent received
```

Scenario builders: `successScenario`, `hangAfterResultScenario` (wind-down), `goSilentScenario` (no-progress), `heartbeatOnlyScenario`, `crashScenario`; steps are `emit`/`stdout`/`stderr`/`sleep`/`commit`/`exit`, plus `ignoreSigterm` and `{ sequence: [...] }` for consecutive turns. The fake re-reads its scenario file on every invocation, so tests can rescript a long-lived daemon between turns.

Notes: the two seams cannot be combined in one context (`fakeClaude: true` suppresses the preload mock everywhere). Stream-json event shapes must stay in sync with `src/agent/activity-stream.ts` and are built only in `fake-claude.ts`. Watchdog guards are read from the task **worktree's** `lazy.toml`, so commit guard changes before creating the task (see `setGuards` in `test/e2e/agent-binary-seam.test.ts`). A watchdog kill lands the task in `interrupted` (auto-resumable), not `blocked`; the reason is on the session as `interrupt_reason`.

### Test-only env vars

Never read these from production code paths.

- **`LAZY_FORCE_TTY=1`** — makes `isTTY()` return true so interactive code paths run in tests.
- **`LAZY_PROMPT_DEFAULTS`** — auto-answers prompts without stdin: `"accept"` (all yes), `"decline"` (all no), `"1"` (default value).
- **`LAZY_FORCE_PROXY_GATE=1`** — arms the proxy fail-loud gate under `LAZY_TEST=1` (normally bypassed — daemonless runs have no proxy address). Only `test/e2e/proxy-fail-loud.test.ts` and the proxy block of `test/unit/auth-env.test.ts` need it.
- **`LAZY_FORCE_CAPTURE_SWEEP=1`** — arms the daemon's conversation capture sweep (tick sped to 1s) under `LAZY_TEST=1`, where it is off by default because it races suites that seed session JSONLs. Only `test/e2e/daemon-capture-sweep.test.ts` needs it.
- **`LAZY_FORCE_PREFLIGHT=1`** — runs the filesystem preflight under `LAZY_TEST=1` (normally skipped). Only `test/e2e/preflight.test.ts` needs it.
- **`LAZY_TEST_PARENT_PID`** — pid a spawned daemon must not outlive; set by `test/helpers/setup.ts` on every subprocess it spawns. Unset in production, where `startTestParentWatch` installs nothing.

### Env leakage between suites — the rules

All test files in one `bun test` run share one `process.env`, and bun's file order is unrelated to your command line, so a leaked flag bites arbitrarily. Four rules, each backed by a helper:

- **A daemonless suite that calls `src/` in-process (e.g. imports `reconcileTasks`) must call `enableInProcessTestMode()`** from `test/helpers/in-process-test-mode.ts` at module scope. The `bun test` process itself does not have `LAZY_TEST=1` (only spawned subprocesses do), so in-process production code otherwise runs in NON-test mode and dies on the proxy fail-loud gate (`ProxyUnavailableError`). The helper sets the flag in `beforeAll` and restores it in `afterAll` — which also means `LAZY_TEST` is NOT set during module-body evaluation; module-scope code must not depend on it. Do NOT call it from a `withDaemon: true` suite — there `LAZY_TEST` must stay unset so the CLI really talks to the test daemon.
- **A suite that starts a daemon IN-PROCESS (`startDaemonServer()`) must call `isolateInProcessDaemonEnv()`** from `test/helpers/in-process-daemon.ts` at module scope. `startDaemonServer()` sets `LAZY_IS_DAEMON=1` and `stop()` never unsets it; a leaked `LAZY_IS_DAEMON=1` makes every later CLI child refuse to RPC the daemon ("Daemon is not running" — while `daemon status`, which only reads the pidfile, says it's up). The helper snapshots/restores `LAZY_IS_DAEMON` and `LAZY_TEST` around the file.
- **A test that spawns its own subprocess from `{ ...process.env }` and must reach the test daemon** spreads `MCP_SERVER_ENV_PINS` (`test/helpers/mcp-env.ts`) LAST — over `...process.env` and per-test overrides. Otherwise a leaked `LAZY_TEST=1` sends that child down the local-storage bypass while `ctx.lazy()` children talk to the daemon, and the two write to different stores.
- **Unpin `LAZY_DAEMON_BASE_DIR` AFTER `ctx.cleanup()`, never before.** Cleanup resolves the pidfile path from that variable at the moment it runs; clearing it first means the daemon is never reaped and squats the port window. Use `pinDaemonBaseDir()` from `test/helpers/daemon-base-dir.ts` and call its returned undo after cleanup.

`setupTestLazy` defends the other direction too: it pins `LAZY_TEST: ''` and `LAZY_IS_DAEMON: ''` on every process a `withDaemon: true` context spawns, so a daemon-backed suite survives earlier suites that set flags and never restored them (`test/e2e/test-mode-isolation.test.ts` asserts exactly this).

### Storage and config in tests

- **Test projects use EXTERNAL storage — never hardcode `<root>/.lazy/tasks`.** `lazy init` writes an `external_path` into the project's lazy.toml, so task state lives outside the temp repo. `test/helpers/storage.ts` is the ONE place that knows the layout (`tasksDirFor`, `taskFilePath`, `readTaskStatus`, `setTaskStatus`, `readSessionJson`, …) — use it.
- **Change a test's lazy.toml by EDITING the key, never by overwriting the file.** Rewrite the key in the init-produced file (`toml.replace('driver = "local"', 'driver = "github"')`) and assert the replace changed something (`expect(after).not.toBe(before)`). Overwriting with a stub throws away `external_path` (the command then sees an empty store and assertions pass for the wrong reason); appending a section init already writes is a TOML redefinition error; a `.replace()` that matches nothing is a silent no-op.

### Daemonless limits

- **A daemonless suite cannot `accept`.** The daemon reconciler is what moves a task out of `working`; daemonless it stays `working` forever and accept refuses. Accept tests need `withDaemon: true`, an explicit `lazy wait`, and their own worktree commit (the in-daemon agent uses the daemon's own mock response; per-test `LAZY_MOCK_SHOULD_COMMIT` never reaches it). Canonical pattern: `test/e2e/accept-reason.test.ts`.
- **Any command that runs a sync (`lazy sync`, `lazy reparent`) relaunches the task's agent**, so invoke it through `ctx.lazyMocked` even in a daemonless suite — plain `ctx.lazy` reaches a real runner and dies on `spawn failed: binary 'docker' not found`.
