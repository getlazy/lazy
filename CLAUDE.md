# Lazy Development Guidelines

These guidelines apply to all agents working on tasks in this repository.

## Running Lazy

Always run lazy with `bun run ./src/index.ts` — never `npx bun run`. The `npx` wrapper causes processes to hang indefinitely when stdin is piped (see anthropics/claude-code#27401).

```bash
# Good
bun run ./src/index.ts list
echo "feedback" | bun run ./src/index.ts unblock <task_id>

# Bad — will hang with piped stdin
npx bun run ./src/index.ts list
```

## CRITICAL: Never Lose Human Feedback

**This is the single most important invariant in Lazy.**

Human feedback — edits in `$EDITOR`, review comments, close reasons, notes — is the most valuable input in the system. Every piece of human feedback MUST be durably saved before any other operation (auth checks, Docker launches, network calls, etc.) can fail and lose it.

Rules:
1. **Save first, act second.** When a human provides feedback via `$EDITOR` or any
   interactive prompt, persist it to durable storage (database or file) IMMEDIATELY
   after the editor closes. Only then proceed with auth checks, container launches,
   or any operation that might fail.
2. **Pre-flight checks before editor.** Any check that can fail (authentication,
   Docker availability, lock checks) MUST happen BEFORE opening `$EDITOR`. The human
   should never type feedback only to have it discarded by a pre-flight failure.
3. **Recovery files.** When editor content cannot be persisted to the database yet,
   write it to a recovery file in `.lazy/recovery/`. These files survive crashes
   and allow humans to retrieve their feedback.
4. **Never silently discard.** If feedback cannot be delivered (e.g., container launch
   fails), the feedback MUST still be preserved in the database or recovery file, and
   the human MUST be told how to retrieve or re-submit it.

## Architectural Invariants

These are load-bearing design decisions. Do NOT change, "optimize away," or weaken them without explicit human approval. Each exists for a reason learned the hard way.

### Upstream merge is sync's job, not unblock's

Upstream merge is a separate operation — triggered by `lazy sync <task>`, daemon signals, or the builder. Unblock only delivers feedback to the agent with zero network dependencies. To merge upstream changes into a task branch before giving feedback, run `lazy sync <task>` first.

### Storage is abstracted — never bypass it

All persistent state (tasks, sessions, turns, commits, comments, conversations) MUST go through the Storage interface (`src/storage/interface.ts`). Never read/write files in `.lazy/` or other stores directly from CLI commands or other modules. The FileStorage implementation is just one backend — we don't know where users will store state. If you need a new entity type, add methods to the Storage interface first, then implement in FileStorage.

**Carve-out: disposable telemetry is not storage state.** Bounded, project-local, throwaway streams are deliberately OUTSIDE Storage and are read and written directly. The proxy audit log (`src/proxy/audit-log.ts`, `.lazy/logs/proxy-audit.jsonl`) is the one instance today: it is one line per model API request, and when it lived in the store it grew to 677 MiB and broke a store push. Storage is for permanent state that must survive and travel with the project; high-churn telemetry is neither. Do not "fix" this back into the Storage interface. Anything new claiming this carve-out must be bounded by construction (rotation or a hard cap) and disposable — if losing it costs the user anything, it belongs in Storage.

### Tests encode invariants, not just current behavior

When you write a test, you're asserting "this behavior is correct and should not change." Every test that encodes a design decision MUST have a comment explaining WHY:

```typescript
// INVARIANT: Upstream merge is sync's job, not unblock's.
// Unblock only delivers feedback — sync handles merging upstream.
test('unblock does NOT trigger upstream merge', ...);
```

Do NOT add tests that assert the absence of correct behavior. Do NOT modify or delete existing invariant tests without human approval. If a test seems wrong, ask — don't "fix" it by making it match your new code.

### Non-interactive CLI invocations use --yes flags

When lazy commands are invoked programmatically (from MCP tool handlers, supervisors,
or scripts), use `--yes` flags to skip interactive confirmation prompts. Do NOT use
the `LAZY_PROMPT_DEFAULTS` environment variable for this — that is a test-only mechanism.
Each command that has a confirmation prompt should accept `--yes` to skip it.

### Documented short flags must be registered as parseFlags aliases

`parseFlags` registers `--<name>` only. A single-dash spelling exists **only** if the flag
declares it explicitly:

```typescript
{ name: 'message', aliases: ['m'], takesValue: true }
```

Documenting `-f` in a usage string without the alias means the CLI rejects it as an unknown
flag — that is exactly how `lazy unblock -f` shipped broken. Whenever you add a short flag to
help text, add the alias, and vice versa. `test/unit/cli-flag-alias-coverage.test.ts` scans
every `<name>Usage()` function against its `command<Name>()` flag table and fails on drift.

Commands never register `--help`/`-h` as their own `parseFlags` flag: the dispatcher in
`src/index.ts` intercepts both before the command runs, so such a flag is dead code and the
`-h, --help` line in usage text is noise (every other command omits it).

### Multiplexer subcommands must be listed in the parent's usage map

`lazy system <sub>` and `lazy daemon <sub>` route `-h`/`--help` through
`<parent>SubcommandUsage` in the dispatcher. A subcommand that ships its own `<name>Usage()`
but isn't added to that map silently prints the PARENT's help — no error anywhere. Whenever
you add a multiplexer subcommand with dedicated usage text, add the map entry.
`test/unit/cli-subcommand-usage-coverage.test.ts` cross-checks each multiplexer's switch
cases against its usage map in both directions and fails on drift.

### Prompts are for the user's project, not for lazy itself

Agent system prompts (`src/prompts/`) are injected into agents working on the USER's codebase. They must not contain lazy-internal design decisions, invariants, or implementation details. Lazy-specific development guidelines live here in CLAUDE.md.

### Never use Bun.spawn/Bun.spawnSync directly

Always use `spawn()` and `spawnSync()` from `src/utils/spawn.ts` instead of calling `Bun.spawn` or `Bun.spawnSync` directly. The wrappers diagnose ENOENT errors — when a binary isn't found or a stdio redirection path doesn't exist, they produce clear error messages instead of the raw OS error (`"ENOENT: no such file or directory, posix_spawn ..."`).

The only exception is `src/utils/spawn.ts` itself, which must call the underlying Bun APIs.

```typescript
// Good
import { spawn, spawnSync } from '../utils/spawn';
const result = spawnSync(['git', 'status'], { cwd, stdout: 'pipe', stderr: 'pipe' });

// Bad — raw ENOENT errors will confuse users
const result = Bun.spawnSync(['git', 'status'], { cwd, stdout: 'pipe', stderr: 'pipe' });
```

### Never use sync filesystem calls

**Always use async filesystem operations** (`fs/promises`) unless you have a specific reason why async won't work. Sync calls (`readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`, `statSync`, etc.) block the entire event loop — no HTTP requests, no timers, no other I/O can proceed until they complete. Even in code that "doesn't matter" today, sync calls become a problem when that code gets called from an async context later.

**Async is the default. Sync requires justification.**

```typescript
// Good — async, doesn't block the event loop
import { readFile, stat, readdir } from 'fs/promises';
const content = await readFile(filePath, 'utf-8');

// Bad — blocks the event loop, starves other work
import { readFileSync, statSync } from 'fs';
const content = readFileSync(filePath, 'utf-8');
```

Sync calls are acceptable **only** in:
- CLI startup/init code that runs once before the event loop matters
- Process exit handlers where async isn't reliable
- Test setup/teardown

Any sync call outside these cases needs a comment explaining why async isn't viable. This is not optional — sync calls in the daemon have caused real production issues (reconciler starvation, blocked HTTP handlers), and sync calls elsewhere have a habit of migrating into hot paths without anyone noticing.

### Fail hard on remote failures — no silent fallbacks

Remote operations (push, fetch, MR/PR creation) must retry up to 3 attempts with progressive backoff (2s, 4s). If all retries fail, the operation FAILS — no silent fallback to local-only behavior. Use `withRemoteRetry()` from `src/utils/retry.ts` to wrap remote operations in drivers.

`success: true` with a warning when the operation actually failed is NEVER acceptable. If a fast-forward fails, that's a failure. If a push fails, that's a failure. If a fetch fails, that's a failure. The caller decides how to handle the failure — not the utility function.

Before performing a remote merge (accept), the parent branch's local commits MUST be pushed to the remote first. If the parent has local-only commits and the remote merge succeeds without them, the remote parent will have the merge commit but not the local commits, causing divergence.

### PRs only for protected branches

PRs/MRs should only be created when merging into a branch with protection rules. Subtask→parent merges should be local git operations, not remote MRs. "Protected" means branches where non-admin users cannot force push or merge without review. This avoids creating unnecessary PRs for intermediate branches that are part of the task hierarchy.

## Core Principle: Act Like a Team Member

**Rule of thumb:** "Would I as a reviewer do this?"

If a reviewer wouldn't do something (like resolving merge conflicts on someone else's PR), you shouldn't either. The human reviewer approves your work; you're responsible for making it merge-ready.

## Merge Conflicts

If you encounter merge conflicts during your work:
1. Merge the parent branch into your branch
2. Resolve all conflicts
3. Verify correctness of the merged code
4. Run tests if applicable
5. Commit the resolution with a clear message

Never leave conflicts unresolved for the human to fix.

## Commit Guidelines

- **NEVER commit to `main`.** Always verify you are on your task branch before
  committing. Run `git branch --show-current` if unsure. If you are working in a
  worktree, be especially careful — `cd`-ing to the parent repo and committing there
  will land changes on `main`. Always use the worktree path for all git operations.
- Commit your work when it reaches a logical checkpoint
- Write clear, descriptive commit messages
- Multiple small commits are better than one large commit
- Do NOT commit:
  - Secrets, API keys, credentials
  - Build artifacts, node_modules, dist/
  - IDE-specific files (.vscode/, .idea/)
  - Unless explicitly part of the solution

## Code Quality

- Follow existing code style in the repository
- Add comments only where logic isn't self-evident
- Test your changes when possible

### Error handling: never swallow, always surface

Errors exist to communicate what went wrong. Swallowing them — even in "non-critical" paths
— creates debugging nightmares where the symptom is far from the cause. Every `catch` block
must either handle the error meaningfully or propagate it with context.

Rules:

1. **No empty `catch {}` blocks.** Every catch must do something: re-throw, log, wrap with
    context, or convert to a user-facing message. `catch {}` and `catch { /* ignore */ }` are
    never acceptable. If you genuinely need to suppress an error, add a comment explaining
    exactly why this specific error is safe to ignore and what you verified to confirm that.

2. **Add context when re-throwing.** A raw re-throw (`throw err`) loses the "where" and "why."
    Wrap with context: `throw new Error(`failed to parse ${configPath}: ${err.message}`)`. The
    person debugging this at 2am shouldn't have to reconstruct the call stack mentally.

3. **Don't catch-and-log-and-continue when the operation failed.** If a function's purpose is
    to read config and it can't read config, that's not a warning — it's an error. Logging and
    returning a default silently violates the caller's expectations. Throw, and let the caller
    decide what to do.

4. **Distinguish between "not found" and "found but broken."** A missing config file is a
    normal condition (fall through to defaults). A config file that exists but fails to parse
    is a bug in the user's config — they need to know immediately, not get a mysterious
    downstream failure.

5. **Errors are for humans, not for code.** Error messages should tell the user what happened,
    what the system was trying to do, and what they can do to fix it. Include the actual values
    that caused the failure (file paths, config keys, expected vs actual types).

```typescript
// Bad — silent swallow, user gets mysterious "not configured" error
try {
  const config = parseToml(readFileSync(configPath, 'utf-8'));
  return config.agent?.qa?.scenario_file;
} catch {
  // fall through
}

// Good — async, distinguishes missing file from broken file
try {
  const raw = await readFile(configPath, 'utf-8');
  const config = parseToml(raw);
  return config.agent?.qa?.scenario_file;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    // No config file — fall through to other resolution methods
  } else {
    throw new Error(`Failed to parse ${configPath}: ${err.message}`);
  }
}

### Principle of least surprise

Lazy's behavior must be predictable. Users build mental models of how tools work, and
every violation of that model erodes trust. This applies especially to user-facing behavior
— CLI commands, output, error messages, and side effects.

- **Commands do what their name says.** `lazy accept` accepts. It doesn't silently rebase,
  modify unrelated files, or trigger side effects the user didn't ask for. If a command needs
  to do something extra, tell the user first.
- **No hidden side effects.** If a command modifies state beyond what the user requested,
  that's a bug. Writing to `~/.claude.json`, starting background processes, or modifying
  branches the user didn't mention — all surprising. If unavoidable, make it explicit and
  visible.
- **Errors are actionable.** When something fails, tell the user what happened, why, and
  what they can do about it. "Error: command failed" is useless. "Error: Docker not running.
  Start Docker Desktop or configure `runner = "host-process"` in lazy.toml" is helpful.
- **Flags do one thing.** Don't overload flags with magic values or mode-switching behavior.
  `--parent main` means "use main as the parent" — it shouldn't also change how the branch
  is created, skip validation, or alter the commit strategy.
- **Defaults are safe.** The default behavior of any command should be the safest option.
  Destructive or risky behavior requires explicit flags. Never make the dangerous path the
  easy path.

### Clever ain't wise

Simple, obvious behavior beats clever behavior. If a user needs to read the source code to
understand what a command does, we've failed. This is doubly true for user-facing behavior
where the user can't dig into our code to understand what went wrong.

- **Straightforward over magical.** Don't auto-detect, auto-infer, or auto-correct when
  explicit input is available. If the user passes `--parent`, use it — don't second-guess
  them. If something is ambiguous, ask rather than guess.
- **Consistent over convenient.** Every command should follow the same patterns. If `lazy
  accept` takes `--yes` to skip confirmation, then `lazy reject` and `lazy close` should
  too. Don't invent special syntax or shortcuts for individual commands.
- **Transparent over terse.** Show the user what's happening. "Merging upstream into
  task branch..." is better than silence followed by a merge commit they didn't expect.
  Users should never be surprised by what they find in `git log` after running a lazy
  command.

## Communication

- If requirements are unclear, ask for clarification
- Document your reasoning in commit messages
- If you make a design decision, explain why in the code or commit message

## Security

- Never commit sensitive information
- Validate user input at system boundaries
- Use parameterized queries, never string concatenation for SQL
- Be aware of common vulnerabilities (XSS, SQL injection, etc.)

## Logging Pattern

Lazy uses a centralized logging system (`src/utils/logger.ts`) that writes to both console and log files.

### When to use logger.* methods

Use `logger.info()`, `logger.error()`, `logger.warn()`, and `logger.debug()` for all output **after** the logger is initialized:

- Progress messages (e.g., "Building Docker image...")
- Error messages during command execution
- Debug information
- Internal state changes

Logger methods automatically:
- Write to the console (based on log level)
- Write to the session log file (when configured)
- Add timestamps to log files
- Respect verbose/debug flags

### When to use console.* methods

Use `console.log()`, `console.error()`, `console.warn()` **only** in these specific cases:

1. **Before logger initialization**
   - Early startup code in `src/index.ts`
   - Config loading in `src/config/loader.ts`
   - Init command in `src/cli/init.ts`

2. **Debug mode output**
   - When `debug=true` flag is explicitly set
   - Use `console.log('[DEBUG] ...')` prefix
   - Example: showing Docker commands in debug mode

3. **Help and usage messages**
   - Command usage instructions
   - Help text output

4. **Final formatted output**
   - Summary tables
   - Task listings
   - Status reports

### Avoiding duplicate messages

**CRITICAL**: Do not duplicate messages at different layers of the application.

### Examples

```typescript
// Good - using logger for internal operations
async function buildDockerImage() {
  logger.info('Building Docker image...');
  try {
    // ... build logic
    logger.debug('Build completed successfully');
  } catch (err) {
    logger.error(`Build failed: ${err.message}`);
    throw err;
  }
}

// Good - using console for user-facing output
function showTaskList(tasks: Task[]) {
  console.log(`${'ID'.padEnd(10)} ${'STATUS'.padEnd(12)} TITLE`);
  for (const task of tasks) {
    console.log(`${task.id.padEnd(10)} ${task.status.padEnd(12)} ${task.title}`);
  }
}
```

## Prompts

All prompts (system prompts, task templates, goal context) live in `src/prompts/` as `.md` files.

Rules:
- **Never inline prompts as string literals in code.** Always create a `.md` file in `src/prompts/` and import it using Bun's text import: `import myPrompt from '../prompts/my-prompt.md' with { type: 'text' };`
- This ensures prompts are discoverable via `lazy prompts`, trackable in git diffs, and editable without touching code.
- If a prompt needs variable substitution, use `{{placeholder}}` syntax and `.replace()` at the call site.

## CHANGELOG style

The CHANGELOG is for a 30-second human scan of what's new, changed, or fixed — not a record of *how* it was built. That depth already lives in each task's history and journal. Keep entries scannable:

- **One line per entry.** No multi-sentence paragraphs. If you can't say it in a line, the depth belongs in the task, not here.
- **State the user-visible effect, not the implementation.** What changed for someone using lazy — not the internal mechanism, guards, or plumbing that made it work.
- **No internal type/function names.** No `TOCTOU` guards, `recordSyncTurns`, `CompletedResponse`, etc. Command names, config keys, and flags are fine — those are the user surface.
- **Reference the task code in parens as the depth pointer**, e.g. `(daemon-operator-tooling)`. That's where a reader goes for the full rationale.
- **Intro paragraph: 3 sentences max.** A quick framing of the release's theme, nothing more.

Example entry:

- **`lazy daemon list` / `kill-stray`** — see and reap stray daemons host-wide (`daemon-operator-tooling`)

Keep the `Added` / `Changed` / `Fixed` structure. This sets the standard going forward — don't rewrite older sections to match.

## End-to-End Testing

Lazy has an e2e test suite in `test/e2e/` that tests CLI commands as subprocesses with mocked agent responses. **Any new command or behavior change should have e2e test coverage.**

### Running Tests

```bash
# Run a specific test file (the supported mode — see below)
bun test test/e2e/create.test.ts

# Run all e2e tests (best-effort; environmentally fragile under load)
bun test test/e2e/

# Run the whole suite (slow suites skipped — see below)
bun test

# Run EVERYTHING, including the opt-in slow suites
LAZY_SLOW_TESTS=1 bun test

# Run one slow suite on its own
LAZY_SLOW_TESTS=1 bun test test/e2e/daemon.test.ts
```

**Slow suites are opt-in.** Two e2e files each take >300s on their own —
`test/e2e/daemon.test.ts` and `test/e2e/remote-storage.test.ts`. They are gated behind the test-only
`LAZY_SLOW_TESTS=1` env var (same family as `LAZY_FORCE_TTY` /
`LAZY_PROMPT_DEFAULTS` — never read it from production code) via
`describe.skipIf(slowSuiteSkipped(...))` from `test/helpers/slow-suite.ts`.
The gate is *gating only* — no test content was removed or weakened, and every
skipped file prints one line (`skipped: slow suite "…" — set LAZY_SLOW_TESTS=1
to run`) so a default run is never silently green-by-omission. Run them with
`LAZY_SLOW_TESTS=1` before touching the daemon or RemoteStorage, and in any
pre-accept/full-verification pass.

**Linux prerequisite:** suites that exercise the host-process runner (`builder`,
`host-sandbox-posture`) need `bwrap` and `socat` on PATH — install `bubblewrap` and
`socat`. Without them `checkAvailability()` aborts before any assertion and a dozen
tests fail on infrastructure rather than on code.

Tests get a 30s default timeout from `setDefaultTimeout()` in `test/preload-generate.ts`
(bunfig.toml's `[test] timeout` is not honored by the bun we run on — it silently left
every test on bun's 5s default). A `test(name, fn, ms)` override still wins.

**Per-file execution is the supported mode.** Each `withDaemon: true` suite starts
a real daemon that binds a TCP port from a bounded window (26024+). A single full
`bun test test/e2e/` run spins up many daemons; if any teardown is skipped (a crash,
a SIGKILL timeout, an interrupted run) the leaked daemons exhaust the port window and
later suites fail spuriously with bind/port errors — not real regressions. Verify a
suite by running its file on its own; treat a green per-file run as authoritative and
a red full-suite run as suspect until reproduced per-file. The `setupTestLazy` teardown
and the `test/helpers/daemon-registry.ts` process-death safety net reap daemons on the
happy path and on Ctrl-C, but they can't recover a hard-killed run.

**Isolate daemon tests along three axes, or they pass in a container and fail on a Mac.**
Every one of these has cost real debugging time:

- **Daemon state → `LAZY_DAEMON_BASE_DIR`, not `HOME`.** It is the documented seam in
  `src/daemon/paths.ts` and moves the socket/PID/token/log/lock together, and nothing
  else. Redirecting `HOME` also redirects credential discovery, `~/.gitconfig`, tool
  caches, and `createStorage`'s default path — differently on a developer machine (which
  has a real `~/.claude`, a real `~/.lazy`, and a running daemon) than in CI. Helpers:
  `test/helpers/daemon-base-dir.ts`.
- **In-process daemons → pin `LAZY_CONFIG`.** `loadConfig` walks up from `process.cwd()`,
  which under `bun test` is lazy's OWN worktree — so a test daemon silently adopts lazy's
  `lazy.toml`, including `[storage] external_path` pointing at the developer's live store.
  In a container that fails fast (`EACCES … mkdir '/Users/…'`); on the author's machine it
  succeeds and contends the real store's `.storage-lock`. Use `pinConfig()` from
  `test/helpers/pin-config.ts`; `process.chdir()` is the weaker older workaround, and an
  unrelated earlier `chdir` can MASK the bug entirely.
- **Port squatters must bind the exact host the daemon binds** (`DEFAULT_SERVER_BIND`),
  never `Bun.serve`'s default wildcard. On Linux a wildcard listener blocks a later
  specific bind; on macOS/BSD `SO_REUSEADDR` lets the specific bind through, so every
  "the bind must fail" assertion silently inverts on a Mac.

Also prefer a probed free port over the shared 26024+ window whenever a test needs a real
`daemon start` to SUCCEED — on a box with stray daemons the window walk can come up empty
and the test fails for reasons unrelated to its subject.

### How Tests Work

Each test:
1. Creates an isolated lazy in a temp directory (`/tmp/lazy-e2e-*`)
2. Initializes a git repo and runs `lazy init`
3. Runs CLI commands as subprocesses via `ctx.lazy()` or `ctx.lazyMocked()`
4. Asserts on stdout/stderr output and exit codes
5. Cleans up the temp directory afterward

Agent responses are **never real** — they are mocked via `test/mocks/claude.ts`, which is injected using Bun's `--preload` mechanism when `LAZY_TEST=1` is set.

### Test File Structure

Every test file follows this pattern:

```typescript
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

describe('lazy <command>', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('does something successfully', async () => {
    const result = await ctx.lazy(['command', '--flag', 'value']);
    expectSuccess(result);
    expectOutput(result, 'expected output substring');
  });
});
```

### TestContext API

`setupTestLazy()` returns a `TestContext` with these methods:

- **`ctx.lazy(args, options?)`** — Runs the real CLI without mocks. Use for commands that don't invoke Claude (e.g., `create`, `list`, `show`).
- **`ctx.lazyMocked(args, mockResponse, options?)`** — Runs the CLI with mocked agent responses. Use for commands that invoke Claude (e.g., `start`).
- **`ctx.git(...args)`** — Runs git commands directly in the test repo. Returns `{ stdout, stderr, exitCode }`.
- **`ctx.cleanup()`** — Removes the temp directory. Always call in `afterEach`.

### Assertion Helpers

Import from `test/helpers/assertions.ts`:

- **`expectSuccess(result)`** — Asserts exit code 0.
- **`expectFailure(result, expectedExitCode?)`** — Asserts exit code != 0.
- **`expectOutput(result, substring)`** — Asserts `substring` appears in stdout.
- **`expectError(result, substring)`** — Asserts `substring` appears in stderr.
- **`expectOutputExcludes(result, substring)`** — Asserts `substring` does NOT appear in stdout.
- **`extractTaskId(output)`** — Extracts an 8-character hex task ID from output text.

### Test Fixtures

Import from `test/helpers/fixtures.ts`:

- **`MOCK_CLAUDE_SUCCESS`** — A standard mock response for successful agent runs.
- **`createTask(ctx, goal, prompt?)`** — Creates a task and returns its short ID.

### Two agent seams: the module mock and the fake binary

There are two ways to fake the agent, at different depths. Pick deliberately.

**1. The module mock (default).** `test/mocks/claude.ts` replaces all of
`src/capture/claude.ts` via Bun `--preload`, including `launchSupervisorAsync`. Fast, and
right for anything that only needs "a turn happened and produced this response" — status
transitions, accept/unblock flows, CLI output. Its limit is structural: everything
downstream of `launchSupervisorAsync` — `execWithWatchdog`, the no-progress and wind-down
kills, SIGTERM→SIGKILL escalation, stream-json parsing, response capture — is replaced, so
no such test can ever reach it.

**2. The fake binary (`setupTestLazy({ fakeClaude: true })`).** Installs a scriptable fake
`claude` executable on PATH (`test/helpers/fake-claude.ts`) and switches the test project to
the host-process runner. Nothing in `src/` is mocked: the daemon launches a real
`lazy supervise` subprocess, which really spawns the fake agent. Use this whenever the
behavior under test IS the supervisor — watchdog kills, the agent argv contract
(`--resume`, `--output-format stream-json`), stream-event handling.

```typescript
ctx = await setupTestLazy({ fakeClaude: true });   // implies withDaemon: true
await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 's1' }));
await ctx.lazy(['start', taskId, '--yes']);
const invocations = await ctx.claudeInvocations();  // real argv the agent received
```

Scenario builders: `successScenario`, `hangAfterResultScenario` (wind-down),
`goSilentScenario` (no-progress), `heartbeatOnlyScenario` (liveness without progress),
`crashScenario` (non-zero exit). A scenario is a list of steps (`emit` / `stdout` /
`stderr` / `sleep` / `commit` / `exit`), plus `ignoreSigterm` to force SIGKILL escalation;
`{ sequence: [...] }` scripts consecutive turns. The fake reads its scenario from a file on
every invocation, so tests can rescript a long-lived daemon between turns.

Notes:
- `fakeClaude: true` suppresses the `--preload` mock for every process the context spawns —
  the two seams cannot be combined in one context.
- The stream-json event shapes must stay in sync with `src/agent/activity-stream.ts`; they
  are built in one place (`fake-claude.ts`) for that reason.
- Watchdog guards are read from the task **worktree's** `lazy.toml`, so a test that tightens
  them must commit the change before creating the task (see `setGuards` in
  `test/e2e/agent-binary-seam.test.ts`).
- A watchdog kill lands the task in `interrupted` (ungraceful, auto-resumable), not
  `blocked`; the reason is on the session as `interrupt_reason`.

### Testing Interactive Prompts

For tests that need to exercise interactive prompts (yes/no, choice selection), use these env vars:

- **`LAZY_FORCE_TTY=1`** — Makes `isTTY()` return true so interactive code paths run in tests.
- **`LAZY_PROMPT_DEFAULTS`** — Controls auto-answering without real stdin:
  - `"accept"` — all `promptYesNo` return true
  - `"decline"` — all `promptYesNo` return false
  - `"1"` — returns the default value for each prompt
- **`LAZY_FORCE_PROXY_GATE=1`** — Arms the proxy fail-loud gate even under
  `LAZY_TEST=1`, which normally bypasses it (a daemonless test run has no daemon
  to report a proxy address, so the gate is off by design). Only
  `test/e2e/proxy-fail-loud.test.ts` and the proxy block of
  `test/unit/auth-env.test.ts` need it — without the hatch the failure they
  assert on can never fire.
- **`LAZY_FORCE_CAPTURE_SWEEP=1`** — arms the daemon's conversation capture
  sweep (and speeds its tick to 1s) under `LAZY_TEST=1`, where it is off by
  default: left running it would race every suite that seeds session JSONLs and
  then asserts they are still unimported (`doctor --reimport-conversations`).
  Only `test/e2e/daemon-capture-sweep.test.ts` needs it.
- **`LAZY_FORCE_PREFLIGHT=1`** — Runs the filesystem preflight check even under
  `LAZY_TEST=1`, which normally skips it (test temp dirs are always accessible, so
  preflight there would be noise). Only `test/e2e/preflight.test.ts` needs this — it
  deliberately chmods those dirs inaccessible, and without the hatch the check it
  asserts on never runs.

These are **test-only** env vars. Never use them in production code paths.

### A daemonless suite that calls `src/` in-process must declare test mode

`setupTestLazy()` sets `LAZY_TEST=1` on every SUBPROCESS it spawns, and the
subprocess reconcile driver (`test/helpers/reconcile.ts`) sets it too — but the
`bun test` process itself does not have it. A suite that imports `reconcileTasks`
(or anything else under `src/`) and awaits it **directly** therefore runs
production code in NON-test mode, inside a project that has no daemon by design.

That was invisible until the audit/policy proxy became on-by-default: `createRunner`
now resolves the daemon's live proxy address up front and fails loud
(`ProxyUnavailableError`), so every in-process reconcile pass aborted before doing
any work — 20 failures across six suites, all looking like unrelated bugs.

Call `enableInProcessTestMode()` from `test/helpers/in-process-test-mode.ts` at
module scope in such a suite. Do NOT call it from a `withDaemon: true` suite —
there `LAZY_TEST=1` must stay unset so the CLI really talks to the test daemon.

### Test projects use EXTERNAL storage — never hardcode `<root>/.lazy/tasks`

`lazy init` writes an `external_path` into the project's lazy.toml, so task state
lives outside the temp repo. `test/helpers/storage.ts` is the ONE place that knows
the layout (`tasksDirFor`, `taskFilePath`, `readTaskStatus`, `setTaskStatus`,
`readSessionJson`, …). Suites that hand-rolled `join(root, '.lazy', 'tasks')`
died with ENOENT when the backend changed; use the helpers.

### Change a test's lazy.toml by EDITING the key, never by overwriting the file

A test that needs a different setting must rewrite that key in the lazy.toml
`lazy init` produced — `toml.replace('driver = "local"', 'driver = "github"')`,
with an assertion that the replace actually changed something. The two shortcuts
both fail quietly:

- **Overwriting the file** with a two-line stub (`'[remote]\ndriver = "github"\n'`)
  also throws away the `external_path` init wrote, so the command under test looks
  at an empty default store. The assertion then passes for the wrong reason —
  "no push happened" is trivially true when no task was found at all.
- **Appending a section** that the init template already writes (`[remote]`,
  `[runner]`, `[storage]`, …) is a TOML redefinition error; the command fails on
  config parsing before it reaches the behavior under test.

A literal `.replace()` that matches nothing is the same silent no-op, so assert
the config changed (`expect(after).not.toBe(before)`) rather than trusting it.

### A daemonless suite cannot `accept`, and `sync` still needs the agent mock

`start` launches the supervisor asynchronously and the **daemon reconciler** is
what moves a task out of `working`; daemonless the task stays `working` forever
and accept refuses ("Task X is still working"). Accept tests therefore need
`withDaemon: true`, an explicit `lazy wait`, and their own worktree commit — the
in-daemon agent uses the daemon's own mock response, so a per-test
`LAZY_MOCK_SHOULD_COMMIT` never reaches it. `test/e2e/accept-reason.test.ts` is
the canonical pattern.

Separately, any command whose implementation runs a **sync** (`lazy sync`,
`lazy reparent`) relaunches the task's own agent, so it must be invoked through
`ctx.lazyMocked` even in a daemonless suite. Under plain `ctx.lazy` it reaches a
real runner and dies on `spawn failed: binary 'docker' not found`.

### When to Add Tests

- **New CLI command** — Add a new test file `test/e2e/<command>.test.ts`
- **Behavior change to existing command** — Add tests to the existing test file
- **Bug fix** — Add a test that reproduces the bug and verifies the fix
