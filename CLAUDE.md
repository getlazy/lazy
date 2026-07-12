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
# Run all tests
bun test

# Run all e2e tests
bun test test/e2e/

# Run a specific test file
bun test test/e2e/create.test.ts
```

Tests have a timeout configured in `bunfig.toml`.

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

### Testing Interactive Prompts

For tests that need to exercise interactive prompts (yes/no, choice selection), use these env vars:

- **`LAZY_FORCE_TTY=1`** — Makes `isTTY()` return true so interactive code paths run in tests.
- **`LAZY_PROMPT_DEFAULTS`** — Controls auto-answering without real stdin:
  - `"accept"` — all `promptYesNo` return true
  - `"decline"` — all `promptYesNo` return false
  - `"1"` — returns the default value for each prompt

These are **test-only** env vars. Never use them in production code paths.

### When to Add Tests

- **New CLI command** — Add a new test file `test/e2e/<command>.test.ts`
- **Behavior change to existing command** — Add tests to the existing test file
- **Bug fix** — Add a test that reproduces the bug and verifies the fix
