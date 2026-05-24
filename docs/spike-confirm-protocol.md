# Spike: Confirmation Protocol for Destructive/Risky Operations

## Problem

MCP tool handlers (used by the builder LLM) bypass all confirmation prompts by passing
`--yes` to CLI commands. This means the builder can fire off destructive operations —
rejecting work, accepting unreviewed diffs, closing tasks with commits — with zero friction.
The CLI has interactive prompts for human users, but LLMs need a different kind of friction:
contextual guidance that forces a second tool call.

## 1. Operation Inventory

### Confirmation levels

| Level | Meaning | MCP behavior | CLI behavior |
|-------|---------|-------------|--------------|
| **none** | Safe, read-only, or trivially reversible | Execute immediately | Execute immediately |
| **light** | Moderate risk, easily recoverable | Return guidance + confirmation code | No prompt (or info message) |
| **standard** | Destructive or hard to reverse | Return guidance + confirmation code | `promptYesNo()` |
| **stern** | High stakes, common mistake patterns | Return stern guidance + confirmation code | `promptYesNo()` with warning |

### Tool/command classification

| Operation | Default level | Scales up when... | Scales down when... |
|-----------|--------------|-------------------|---------------------|
| `lazy_accept` | light | Large diff (>100 lines or >5 files) → standard. Very large (>500 lines or >10 files) → stern | Tiny diff (<10 lines, ≤2 files) → none |
| `lazy_reject` | stern | Always stern — rejection wastes work and pollutes task codes | Never scales down |
| `lazy_close` | standard | Task has commits (work will be abandoned) → stern | Task has no commits and no session → light |
| `lazy_redo` | standard | Old task has many commits → stern | — |
| `lazy_reopen` | light | Reopening a completed (accepted) task → standard | — |
| `lazy_start` | none | — | — |
| `lazy_unblock` | none | — | — |
| `lazy_create` | none | Parent is `main` while builder is actively working on a task → light (guidance: "Did you mean to create under the active task?") | — |
| `lazy_edit` | none | — | — |
| `lazy_clone` | none | — | — |
| `lazy_propose` | none | — | — |
| `lazy_comment` | none | — | — |
| `lazy_commit` | none | — | — |
| `lazy_search/show/list/diff/...` | none | — | — |

### Rationale for each confirmed operation

**`lazy_reject`** — Always stern. Rejection is the most dangerous builder mistake.
It discards agent work, pollutes task codes (the redo gets a new code), and signals
"this approach is wrong" when often the builder just wanted a tweak. The guidance
must ask: "Did you consider giving feedback via `lazy_unblock` instead? Rejection
discards all work on this task."

**`lazy_accept`** — Scales with change size. A 5-line typo fix needs no ceremony.
A 2000-line feature merge deserves "This merges 47 files with 2,134 additions.
Have you reviewed the diff thoroughly?"

**`lazy_close`** — Standard by default because it abandons a task. Stern when commits
exist because work is being thrown away. Light when the task is empty (no session,
no commits — likely just cleaning up a mistaken create).

**`lazy_redo`** — Standard because it closes the old task and creates a replacement.
The old task's work is abandoned. Stern when the old task has significant history.

**`lazy_reopen`** — Light by default (easily reversible — just close again). Standard
when reopening a completed task because that task was already accepted and merged;
reopening it creates ambiguity about the merged work.

**`lazy_create`** — Usually none. Light only when the builder appears to be making
a common mistake: creating a subtask under `main` when there's an active task that's
likely the intended parent.

## 2. The Confirmation Protocol

### Two-step pattern for MCP tools

**Step 1: Request** — Builder calls the tool normally (e.g., `lazy_reject`).
The handler evaluates the confirmation level. If confirmation is required, it returns
a response with guidance and a confirmation code instead of executing the operation.

```
Builder calls: lazy_reject({ task_id: "a1b2c3d4", reason: "Wrong approach" })

Response (not executed yet):
{
  "status": "confirm_required",
  "confirmation_code": "rj-7f3a",
  "operation": "reject",
  "task_id": "a1b2c3d4",
  "guidance": "⚠ You are about to REJECT task fix-login-bug.\n\nThis will:\n- Discard all agent work (3 commits, 247 lines changed)\n- Mark the task as abandoned\n- The task code 'fix-login-bug' cannot be reused\n\nDid you consider giving feedback with lazy_unblock instead?\nRejection means 'this approach is fundamentally wrong.'\nFeedback means 'adjust this specific thing.'\n\nTo proceed, call lazy_reject again with confirmation_code: \"rj-7f3a\""
}
```

**Step 2: Confirm** — Builder calls the same tool again, this time including
the confirmation code.

```
Builder calls: lazy_reject({
  task_id: "a1b2c3d4",
  reason: "Wrong approach",
  confirmation_code: "rj-7f3a"
})

Response (executed):
{
  "status": "success",
  "message": "Task fix-login-bug rejected."
}
```

### Confirmation code design

- **Format**: `<verb-prefix>-<4-hex>` (e.g., `ac-7f3a`, `rj-b2c1`, `cl-9d4e`)
  - Verb prefix makes codes non-interchangeable between operations
  - 4 hex chars = 65,536 possibilities, enough to prevent accidental reuse
- **Scoped**: Code is tied to (operation, task_id). A reject code cannot confirm an accept.
- **Single-use**: Each code can only be used once.
- **Time-limited**: Valid for 5 minutes. After that, the builder must request a fresh
  code (and gets fresh guidance reflecting current state).
- **Storage**: In-memory map in the MCP server process. No persistence needed — if the
  MCP server restarts, codes are invalidated, which is the safe default.

```typescript
interface PendingConfirmation {
  code: string;           // e.g., "rj-7f3a"
  operation: string;      // e.g., "reject"
  taskId: string;         // full task ID
  createdAt: number;      // Date.now()
  args: Record<string, unknown>; // original args for validation
}

// In-memory store, keyed by confirmation code
const pendingConfirmations = new Map<string, PendingConfirmation>();
```

### Why not a separate `lazy_confirm` tool?

A dedicated `lazy_confirm` tool was considered but rejected:

1. **Loses type safety** — The builder would call `lazy_confirm({ code: "rj-7f3a" })`
   without re-stating what operation it's confirming. Harder to audit.
2. **Breaks tool semantics** — Each tool should do one thing. `lazy_confirm` would be
   a meta-tool that does everything.
3. **Same tool, optional param** is simpler — adding `confirmation_code` as an optional
   parameter to each confirmed tool keeps the operation and its confirmation co-located.

## 3. Scaling Rules

### `lazy_accept` — scales with diff size

```typescript
function acceptConfirmationLevel(task: Task, diffStat: DiffStat): ConfirmationLevel {
  const { filesChanged, linesAdded, linesRemoved } = diffStat;
  const totalLines = linesAdded + linesRemoved;

  if (totalLines <= 20 && filesChanged <= 2) return 'none';
  if (totalLines > 500 || filesChanged > 10) return 'stern';
  if (totalLines > 100 || filesChanged > 5) return 'standard';
  return 'light';
}
```

Guidance template at each level:

- **light**: "Accepting task `<code>`: <N> files changed, <M> lines. Confirm to merge."
- **standard**: "This merges <N> files with <M> additions and <K> deletions into `<parent>`. Have you reviewed the diff? Call `lazy_diff` first if not."
- **stern**: "⚠ Large merge: <N> files, <M>+ / <K>−. This is a significant change to `<parent>`. Ensure you have reviewed the diff thoroughly before confirming."

### `lazy_reject` — always stern

Guidance template:
```
⚠ You are about to REJECT task <code>.

This will:
- Discard all agent work (<N> commits, <M> lines changed)
- Mark the task as abandoned
- The task code '<code>' cannot be reused

Did you consider giving feedback with lazy_unblock instead?
Rejection means "this approach is fundamentally wrong."
Feedback means "adjust this specific thing."
```

### `lazy_close` — scales with work invested

```typescript
function closeConfirmationLevel(task: Task, commitCount: number): ConfirmationLevel {
  if (commitCount === 0 && task.status === 'backlog') return 'light';
  if (commitCount > 0) return 'stern';
  return 'standard';
}
```

Guidance templates:

- **light**: "Closing task `<code>` (no work started). Confirm to proceed."
- **standard**: "Closing task `<code>` will abandon this task. A reason is required."
- **stern**: "⚠ Task `<code>` has <N> commits with <M> lines of work. Closing will abandon all of it. Are you sure this work should be discarded?"

### `lazy_redo` — scales with old task history

```typescript
function redoConfirmationLevel(task: Task, commitCount: number): ConfirmationLevel {
  if (commitCount > 5) return 'stern';
  return 'standard';
}
```

### `lazy_create` — conditional, based on parent detection

```typescript
function createConfirmationLevel(
  parentId: string | undefined,
  activeTask: Task | undefined
): ConfirmationLevel {
  // No parent specified, or parent is not main → no confirmation
  if (!parentId || parentId !== 'main') return 'none';
  // Parent is main but there's an active task the builder might have meant
  if (activeTask) return 'light';
  return 'none';
}
```

Guidance: "You're creating a task under `main`, but you have an active task
`<active-code>`. Did you mean to create a subtask under `<active-code>` instead?
If `main` is intentional, confirm to proceed."

## 4. Guidance Templates

All guidance templates live in `src/prompts/confirmations/` as `.md` files, following
the existing prompt convention. Variable substitution uses `{{placeholder}}` syntax.

### Template files

```
src/prompts/confirmations/
  accept-light.md
  accept-standard.md
  accept-stern.md
  reject.md
  close-light.md
  close-standard.md
  close-stern.md
  redo-standard.md
  redo-stern.md
  reopen-standard.md
  create-parent-warning.md
```

### Example: `reject.md`

```markdown
⚠ You are about to REJECT task {{task_code}}.

This will:
- Discard all agent work ({{commit_count}} commits, {{lines_changed}} lines changed)
- Mark the task as abandoned
- The task code '{{task_code}}' cannot be reused

Did you consider giving feedback with `lazy_unblock` instead?
- **Rejection** means "this approach is fundamentally wrong — start over."
- **Feedback** (via `lazy_unblock`) means "adjust this specific thing."

To proceed, call `lazy_reject` again with confirmation_code: "{{confirmation_code}}"
```

### Example: `accept-stern.md`

```markdown
⚠ Large merge into {{parent_branch}}.

Task {{task_code}} changes:
- {{files_changed}} files changed
- {{lines_added}} additions, {{lines_removed}} deletions
- {{commit_count}} commits

This is a significant change. Before confirming:
1. Have you reviewed the diff? (`lazy_diff {{ task_id }}`)
2. Are you confident in the test coverage?

To proceed, call `lazy_accept` again with confirmation_code: "{{confirmation_code}}"
```

## 5. Implementation Sketch

### New module: `src/mcp/confirmation.ts`

This module owns the confirmation protocol logic. It is used exclusively by MCP tool
handlers — CLI commands continue to use their existing `promptYesNo()` pattern.

```typescript
// src/mcp/confirmation.ts

import { randomBytes } from 'crypto';

export type ConfirmationLevel = 'none' | 'light' | 'standard' | 'stern';

export interface ConfirmationRequest {
  level: ConfirmationLevel;
  guidance: string;         // rendered template
  code: string;             // e.g., "rj-7f3a"
  operation: string;
  taskId: string;
}

interface PendingConfirmation {
  code: string;
  operation: string;
  taskId: string;
  createdAt: number;
  argsHash: string;        // hash of original args to detect tampering
}

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const pending = new Map<string, PendingConfirmation>();

/** Generate a confirmation code with verb prefix */
export function generateCode(verbPrefix: string): string {
  const hex = randomBytes(2).toString('hex');
  return `${verbPrefix}-${hex}`;
}

/** Store a pending confirmation */
export function storePending(conf: PendingConfirmation): void {
  // Garbage-collect expired entries
  const now = Date.now();
  for (const [key, val] of pending) {
    if (now - val.createdAt > EXPIRY_MS) pending.delete(key);
  }
  pending.set(conf.code, conf);
}

/** Validate and consume a confirmation code */
export function validateCode(
  code: string,
  operation: string,
  taskId: string
): boolean {
  const conf = pending.get(code);
  if (!conf) return false;
  if (conf.operation !== operation) return false;
  if (conf.taskId !== taskId) return false;
  if (Date.now() - conf.createdAt > EXPIRY_MS) {
    pending.delete(code);
    return false;
  }
  pending.delete(code); // single-use
  return true;
}
```

### How MCP handlers change

Each confirmed tool handler gets a thin wrapper. Example for `lazy_reject`:

```typescript
// In src/mcp/tools.ts — createRejectHandler

export function createRejectHandler(ctx: McpToolContext): McpToolHandler {
  return async (args) => {
    const taskId = args.task_id as string;
    const reason = args.reason as string | undefined;
    const confirmationCode = args.confirmation_code as string | undefined;

    // Resolve task for context
    const storage = await requireStorage();
    const resolved = await storage.resolveTask(taskId);
    if (!resolved.task) throw new Error(`Task not found: ${taskId}`);
    const task = resolved.task;

    // Check if this is step 2 (confirming)
    if (confirmationCode) {
      if (!validateCode(confirmationCode, 'reject', task.id)) {
        throw new Error('Invalid or expired confirmation code. Call lazy_reject without a code to get a new one.');
      }
      // Proceed with actual execution
      const cliArgs = ['reject', taskId, '--yes'];
      if (reason) cliArgs.push('--reason', reason);
      const result = await runLazyCliCommand(cliArgs, ctx.worktreePath);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to reject task: ${(result.stderr || result.stdout).trim()}`);
      }
      return { output: result.stdout.trim() };
    }

    // Step 1: evaluate confirmation level and return guidance
    const level = 'stern'; // reject is always stern
    const context = await gatherRejectContext(storage, task);
    const guidance = renderTemplate('reject', { ...context, task_code: task.code });
    const code = generateCode('rj');
    storePending({ code, operation: 'reject', taskId: task.id, createdAt: Date.now(), argsHash: hashArgs(args) });

    await storage.close();

    return {
      status: 'confirm_required',
      confirmation_code: code,
      operation: 'reject',
      task_id: shortId(task.id),
      guidance,
    };
  };
}
```

### Input schema changes

Each confirmed tool adds `confirmation_code` as an optional parameter:

```typescript
inputSchema: {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '...', minLength: 1 },
    reason: { type: 'string', description: '...' },
    confirmation_code: {
      type: 'string',
      description: 'Confirmation code from a previous call. If omitted, returns guidance and a code instead of executing.',
    },
  },
  required: ['task_id'],
},
```

### Context-gathering functions

Each operation needs a function to collect the data that drives scaling and templates:

```typescript
// src/mcp/confirmation.ts

export interface AcceptContext {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
  parentBranch: string;
}

export interface RejectContext {
  commitCount: number;
  linesChanged: number;
}

export interface CloseContext {
  commitCount: number;
  linesChanged: number;
  hasSession: boolean;
}

/** Gather diff stats for accept confirmation */
export async function gatherAcceptContext(
  storage: Storage,
  task: Task
): Promise<AcceptContext> {
  // Use git diff --stat against parent branch
  // Use storage to count commits
  // ...
}
```

### File organization

```
src/mcp/
  confirmation.ts          # Protocol logic, code generation, validation
  confirmation-context.ts  # Context-gathering functions (diff stats, commit counts)
  tools.ts                 # Modified handlers (existing file)

src/prompts/confirmations/ # Guidance templates (new directory)
  accept-light.md
  accept-standard.md
  accept-stern.md
  reject.md
  close-light.md
  close-standard.md
  close-stern.md
  redo-standard.md
  redo-stern.md
  reopen-standard.md
  create-parent-warning.md
```

## 6. CLI and `--yes` Interaction

### MCP path (builder LLM)

- **Always** uses the two-step protocol for confirmed operations.
- The `--yes` flag is still passed to the underlying CLI command in step 2 (after
  confirmation code is validated), because the MCP handler is non-interactive.
- The confirmation protocol replaces `--yes` as the safety mechanism for LLMs. The
  `--yes` flag becomes an implementation detail of MCP→CLI bridging, not a safety gate.

### CLI interactive (human at terminal)

- **No change to current behavior.** Humans get `promptYesNo()` as they do today.
- The guidance text from templates can optionally be shown before the yes/no prompt,
  giving humans the same contextual information the builder gets. This is a nice-to-have
  enhancement, not a requirement for this protocol.
- `--yes` skips confirmation as it does today.

### CLI with piped stdin

- Current behavior: some commands require `--yes` when stdin is piped, others silently
  proceed. This is already handled correctly and doesn't change.

### Summary of confirmation paths

```
                    ┌─────────────────────────┐
                    │   Operation requested   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Which interface?      │
                    └───┬────────┬────────┬───┘
                        │        │        │
                   MCP tool   CLI tty  CLI --yes
                        │        │        │
              ┌─────────▼──┐  ┌──▼────┐  ┌▼────────┐
              │ Eval level │  │prompt │  │ Execute  │
              │ (scaling)  │  │YesNo  │  │ directly │
              └─────┬──────┘  └───┬───┘  └──────────┘
                    │             │
              level = none?       │
              ┌──yes──┴──no──┐    │
              │              │    │
         ┌────▼────┐  ┌─────▼────▼──┐
         │ Execute │  │ Return      │
         │ directly│  │ guidance +  │
         └─────────┘  │ code        │
                      └──────┬──────┘
                             │
                      ┌──────▼──────┐
                      │ Builder     │
                      │ calls again │
                      │ with code   │
                      └──────┬──────┘
                             │
                      ┌──────▼──────┐
                      │ Validate &  │
                      │ execute     │
                      └─────────────┘
```

## 7. Edge Cases and Decisions

### What if the builder ignores the guidance and never confirms?

No problem. The pending confirmation expires after 5 minutes and is garbage-collected.
No state is modified. The builder simply didn't perform the operation.

### What if the builder calls with a wrong/expired code?

Return a clear error: "Invalid or expired confirmation code. Call `lazy_reject` without
a code to get a fresh one." Do not auto-generate a new code — force the builder to
explicitly re-request, so it gets fresh guidance reflecting current state.

### What if the builder passes someone else's code?

Codes are scoped to (operation, taskId). A code for rejecting task A cannot be used
to reject task B, or to accept task A. The verb prefix (`rj-`, `ac-`, `cl-`) makes
this visually obvious and programmatically enforced.

### What if args change between step 1 and step 2?

The confirmation stores a hash of the original args. If the builder changes the reason
or other parameters in step 2, we allow it — the confirmation is about the *operation*
and *target*, not the specific parameters. The reason might be refined after reading
the guidance.

### Should the builder's system prompt mention the protocol?

No. The protocol is self-documenting through tool responses. When the builder calls
`lazy_reject` and gets back `{ status: "confirm_required", confirmation_code: "rj-7f3a",
guidance: "..." }`, the response tells it exactly what to do. Adding protocol docs to
the system prompt would be noise.

### What about `lazy_unblock` — should it ever confirm?

No. Unblock is the feedback mechanism we *want* the builder to use instead of reject.
Adding friction to unblock would be counterproductive. The same applies to `lazy_start`.

### Can the human disable confirmations for MCP?

Not in the initial implementation. If needed later, a config option like
`[mcp] confirmations = false` could be added to `lazy.toml`. But the default must be
safe, and we should collect data on false-positive rates before adding an escape hatch.

## 8. Testing Strategy

### Unit tests for `src/mcp/confirmation.ts`

- Code generation produces correct format (`verb-4hex`)
- Code validation succeeds for matching (operation, taskId)
- Code validation fails for wrong operation, wrong taskId, expired, already-used
- Scaling functions return correct levels for boundary values
- Template rendering substitutes all placeholders

### E2E tests for confirmed MCP tools

```typescript
// test/e2e/confirm-protocol.test.ts

test('lazy_reject requires confirmation via MCP', async () => {
  const taskId = await createTask(ctx, 'test task');
  // ... start and get to blocked state ...

  // Step 1: call without code → get guidance
  const step1 = await ctx.mcpCall('lazy_reject', { task_id: taskId, reason: 'bad' });
  expect(step1.status).toBe('confirm_required');
  expect(step1.confirmation_code).toMatch(/^rj-[0-9a-f]{4}$/);
  expect(step1.guidance).toContain('lazy_unblock');

  // Step 2: call with code → executes
  const step2 = await ctx.mcpCall('lazy_reject', {
    task_id: taskId,
    reason: 'bad',
    confirmation_code: step1.confirmation_code,
  });
  expect(step2.status).toBe('success');
});

test('confirmation code cannot be reused', async () => { ... });
test('confirmation code expires after 5 minutes', async () => { ... });
test('reject code cannot confirm accept', async () => { ... });
test('accept skips confirmation for tiny diffs', async () => { ... });
test('accept requires confirmation for large diffs', async () => { ... });
```

## 9. Migration / Rollout

1. **Add `confirmation.ts` module** — pure logic, no side effects.
2. **Add guidance templates** in `src/prompts/confirmations/`.
3. **Modify MCP handlers one at a time** — start with `lazy_reject` (highest value,
   always stern, simplest scaling logic).
4. **Add e2e tests** alongside each handler change.
5. **Roll out remaining handlers**: close → accept → redo → reopen → create.
6. **Update builder prompt** — not to explain the protocol, but to reinforce
   "prefer `lazy_unblock` over `lazy_reject`" as a general principle.

No breaking changes to CLI behavior. MCP tool schemas gain an optional
`confirmation_code` parameter, which is backward-compatible.
