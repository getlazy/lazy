# Storage Migration Architecture

Design for migrating lazy state between any two storage backends.

## Context

Lazy has three storage drivers implementing the `Storage` interface (`src/storage/interface.ts`):

- **FileStorage** (`src/storage/file-storage.ts`) — JSON files in `.lazy/tasks/<id>/` directories
- **OrphanBranchStorage** (`src/storage/orphan-branch-storage.ts`) — delegates to FileStorage in a git orphan branch worktree
- **PostgresStorage** (`src/storage/postgres-storage.ts`) — relational tables in PostgreSQL

This design supersedes the `add-system-migrate` task prompt, which only considered file-based moves (in-repo to external). The design here covers any-to-any migration.

## Entity Inventory

All entities that must be migrated, with their storage locations:

| Entity | FileStorage | PostgresStorage | Notes |
|--------|-------------|-----------------|-------|
| Task | `tasks/<id>/task.json` | `tasks` table | Core entity, all others reference it |
| Session | `tasks/<id>/session.json` | `sessions` table | 1:1 with task, FK to task |
| Turn | `tasks/<id>/turns.json` | `turns` table | FK to session |
| Commit | `tasks/<id>/commits.json` | `commits` table | FK to session |
| Review | `tasks/<id>/reviews.json` | `reviews` table | FK to commit |
| Comment | `tasks/<id>/comments.json` | `comments` table | FK to task |
| Prompt History | `tasks/<id>/prompt-history.json` | `prompt_history` table | FK to task |
| Worktree Snapshot | `tasks/<id>/snapshots.json` | `worktree_snapshots` table | FK to session |
| Status Changelog | `tasks/<id>/status-changelog.json` | `status_changelog` table | FK to task |
| Conversation | `conversations/<sessionId>.json` | `conversations` table | Standalone, keyed by session ID |
| Storage Version | `version.json` | `schema_version` table | Driver-internal metadata, created by `initialize()`, not migrated |

### Key observations

1. **OrphanBranchStorage is just FileStorage** with auto-commit. Its internal layout is identical. Migration to/from orphan branch is a FileStorage-to-FileStorage copy plus git plumbing.

2. **No driver stores extra state beyond the interface.** `version.json` and `schema_version` are driver-internal metadata created by `initialize()` — not user data. There is no hidden state that isn't exposed through Storage read methods.

3. **Metadata field** on tasks is `Record<string, string> | null` in both drivers. FileStorage stores it in `task.json`; Postgres stores it as JSONB. Both serialize/deserialize identically.

## Dependency Graph

Entities have the following foreign key relationships:

```
Tasks (no dependencies)
  ├── Sessions (FK: task_id -> tasks)
  │     ├── Turns (FK: session_id -> sessions)
  │     ├── Commits (FK: session_id -> sessions)
  │     │     └── Reviews (FK: commit_id -> commits)
  │     └── Worktree Snapshots (FK: session_id -> sessions)
  ├── Comments (FK: task_id -> tasks)
  ├── Prompt History (FK: task_id -> tasks)
  └── Status Changelog (FK: task_id -> tasks)

Conversations (no FK dependencies, standalone)
```

This graph matters for Postgres FK enforcement. See the FK handling strategy below.

## Recommended Approach: `migrateFrom(source: Storage)`

### Why not "generic via Storage `create*` methods"?

The existing `create*` methods are unsuitable for migration:

1. **ID regeneration.** `createTask()`, `createSession()`, etc. all call `randomUUID()` internally. Migration must preserve original IDs. There's no way to pass an existing ID through the current interface.

2. **Timestamp regeneration.** Create methods use `Date.now()`. Migration must preserve original timestamps.

3. **Business logic.** `createTask()` initializes empty turns/commits/snapshots files (FileStorage) or records an initial status change. `updateTaskPrompt()` increments version numbers. These side effects corrupt migrated data.

4. **Missing write paths.** There's no `createTurn()` that accepts a full Turn object with a pre-set ID and timestamp. The `CreateTurnOptions` interface is close but still generates ID and timestamp internally.

### Recommended: `migrateFrom(source: Storage)` on `MigratableStorage`

Each driver implements one `migrateFrom` method that:
1. **Reads** from the source through the standard `Storage` interface (`listTasks()`, `getSessionByTaskId()`, `getSessionTurns()`, etc.)
2. **Writes** to itself using its own internal write mechanisms, bypassing `create*` business logic

There is no N x N complexity. Each driver reads from any source through the same `Storage` read methods — it never needs to know what the source driver is. This is N implementations of one method, same as every other Storage method:

- FileStorage's `migrateFrom` reads `source.listTasks()`, writes JSON files via `atomicWriteTask()`
- PostgresStorage's `migrateFrom` reads `source.listTasks()`, does direct INSERTs with explicit IDs/timestamps
- OrphanBranchStorage's `migrateFrom` delegates to its inner FileStorage, then auto-commits

The caller just does:

```typescript
const source = createStorage(sourceConfig);
const destination = createStorage(destConfig);
await source.initialize();
await destination.initialize();
await (destination as MigratableStorage).migrateFrom(source);
```

No standalone migration module is needed. Each driver owns its own write strategy internally.

## Interface Design

### `MigratableStorage` extends `Storage`

```typescript
// src/storage/migratable.ts

export interface MigrationProgress {
  phase: 'tasks' | 'conversations' | 'verification';
  current: number;
  total: number;
  entityId?: string;
}

export interface MigrationReport {
  tasksMigrated: number;
  tasksFailed: number;
  conversationsMigrated: number;
  conversationsFailed: number;
  failures: Array<{ entityType: string; entityId: string; error: string }>;
  verified: boolean;
}

/**
 * Extended storage interface for migration support.
 * Drivers that support being a migration target implement this.
 */
export interface MigratableStorage extends Storage {
  /**
   * Migrate all data from the source storage into this storage.
   * Reads from source via standard Storage read methods.
   * Writes using driver-internal mechanisms that preserve IDs and timestamps.
   *
   * @param source - Any Storage implementation to read from
   * @param onProgress - Optional callback for progress reporting
   * @returns Migration report with counts and any failures
   */
  migrateFrom(
    source: Storage,
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<MigrationReport>;
}
```

### Why `MigratableStorage` extends `Storage`

- Drivers opt in to migration support by implementing the extended interface.
- The base `Storage` interface stays clean — migration is a rare admin operation.
- Type narrowing tells the CLI command at compile time whether a driver supports being a migration target.

### Implementation per driver

Each driver's `migrateFrom` handles the complete read-from-source, write-to-self flow internally. The types `TaskBundle` and `MigrationData` may be useful as internal helpers within a driver's implementation, but they are not part of any public API.

**FileStorage**: `migrateFrom` reads all entities from source, writes JSON files directly using `atomicWriteTask()`. No `randomUUID()`, no `Date.now()`. Data is written verbatim.

**PostgresStorage**: `migrateFrom` reads all entities from source, disables FK constraints, inserts all rows with explicit IDs and timestamps using `INSERT ... ON CONFLICT DO UPDATE` for idempotency, re-enables FK constraints, then validates referential integrity. See FK handling section below.

**OrphanBranchStorage**: Delegates to its inner FileStorage's `migrateFrom`, then auto-commits.

## FK Handling During Migration (PostgresStorage)

Rather than topological sorting tasks (which can't handle cycles from `updateTaskParent`), PostgresStorage should:

1. **Disable FK constraints** at the start of migration:
   ```sql
   SET session_replication_role = 'replica';
   -- or: ALTER TABLE tasks DISABLE TRIGGER ALL; (per table)
   ```

2. **Import all data** without worrying about ordering — tasks, sessions, turns, commits, reviews, etc. in any order.

3. **Re-enable FK constraints:**
   ```sql
   SET session_replication_role = 'DEFAULT';
   ```

4. **Validate referential integrity** with explicit queries:
   ```sql
   -- Find sessions referencing non-existent tasks
   SELECT s.id FROM sessions s LEFT JOIN tasks t ON s.task_id = t.id WHERE t.id IS NULL;
   -- Find turns referencing non-existent sessions
   SELECT t.id FROM turns t LEFT JOIN sessions s ON t.session_id = s.id WHERE s.id IS NULL;
   -- ... etc for all FK relationships
   ```

5. **If validation finds violations**, fail the migration with a clear error listing the violating records. The data is still in the destination (constraints are re-enabled but existing bad data is flagged). The user can investigate and fix.

This approach is simpler than topological sort, handles edge cases including cycles, and cleanly separates "move data" from "validate data."

FileStorage has no FK enforcement, so it just writes everything. Optionally validates referential integrity after import.

## Task Locking During Migration

The pre-flight check "verify no tasks are working" is a point-in-time snapshot with a race condition: between checking and finishing migration, someone could `lazy start` a task, write to the source, and that data would be lost.

### Required: System-wide migration lock

Migration must acquire an exclusive lock that prevents concurrent task operations. The lock ships as part of the migration implementation — it is not a separate prerequisite.

**Mechanism:** Config flag in `lazy.toml`. All commands read `lazy.toml` already, so this is simple and driver-agnostic. When `migration_in_progress` is set, all mutating commands (`start`, `unblock`, `resume`, `accept`, `reject`) print "Migration in progress. Please wait." and exit.

**Lock format in `lazy.toml`:**
```toml
[migration]
in_progress = { pid = 12345, started_at = "2026-03-06T05:36:18Z" }
```

**Lock lifecycle:**

1. **Active task check** — Before acquiring the lock:
   - List all tasks in `working` or `interrupted` status
   - If any exist, refuse to migrate with a clear error: "Cannot migrate while tasks are active. Stop all agents first with `lazy stop --all`, then retry."
   - No force-stop built into migration — the user explicitly stops agents first

2. **Lock acquisition** — Only when `--execute` is confirmed (not during dry-run):
   - Write `migration.in_progress` to `lazy.toml` with current PID and timestamp
   - All task-mutating commands check for this flag and refuse to proceed if it exists

3. **Lock release** — After migration completes (success or failure):
   - Remove `migration.in_progress` from `lazy.toml`
   - Must be in a `finally` block to avoid stale locks on crash

**Stale lock detection:**
- Check if the lock's PID is still running using `process.kill(pid, 0)` (signal 0 tests existence without killing). If the PID is dead, the lock is stale — log a warning and proceed.
- No timeout-based override. A long migration on a huge dataset is legitimate; a dead PID is not.
- **Manual override**: If PID check fails (different user, container boundary), `--force` also overrides a stale lock with a warning.

## Migration Flow

### Step-by-step

1. **Pre-flight checks**
   - Verify no tasks are in `working` or `interrupted` status
   - Verify source storage is readable (initialize + list tasks)
   - Verify destination storage is writable (initialize)
   - If destination already has data, warn and require `--force`

2. **Dry-run report** (default behavior, skip with `--execute`) — no lock needed
   - Count entities per type
   - Report estimated migration size
   - Show source and destination backends
   - Exit without modifying destination

3. **Acquire migration lock** — Write `migration.in_progress` to `lazy.toml` with PID and timestamp. Only reached when `--execute` is set.

4. **Execute migration** — `destination.migrateFrom(source, onProgress)`

5. **Verification** (performed inside `migrateFrom`)
   - Count entities in destination, compare to source counts
   - Spot-check: pick N random tasks, compare all fields
   - For Postgres: validate referential integrity after re-enabling FK constraints
   - Report discrepancies

6. **Release migration lock** — Remove `migration.in_progress` from `lazy.toml` (in `finally` block)

7. **Config update** (optional, with `--update-config`)
   - Update `lazy.toml` to point to the new backend
   - This is a separate flag because the user might want to verify before switching

8. **Source cleanup** (never automatic)
   - Migration never deletes source data
   - User can manually clean up after verifying

## Error Handling and Recovery

### Partial failure strategy

- Each task is imported independently within `migrateFrom`. A failure on one task doesn't abort the migration.
- The migration report tracks successes and failures per entity.
- The user can re-run the migration; imports should be idempotent (upsert semantics).

### Idempotency

For Postgres: use `INSERT ... ON CONFLICT DO UPDATE` (or `DO NOTHING` for immutable entities like turns).

For FileStorage: overwrite files (the existing `atomicWriteTask` pattern handles this).

### Transaction boundaries

Each driver handles atomicity internally within `migrateFrom`:

- **Postgres**: Can use a single large transaction wrapping all inserts (rollback everything on failure), or per-task transactions for partial progress. The driver decides.
- **FileStorage**: Uses `atomicWriteTask` which writes to a temp directory then renames. Atomic at the task level.

### No global rollback

A global "undo the entire migration" is not supported. The destination is append-only during migration. If the migration fails partway through:
- The destination has some data (which is correct — just incomplete)
- Re-running the migration fills in missing data (idempotent)
- The source is never modified

## CLI UX

### Command

```
lazy system migrate [--source <backend>] [--destination <backend>] [options]
```

### Flags

| Flag | Description |
|------|-------------|
| `--source <backend>` | Source backend (default: current config). One of: `in-repo`, `external`, `orphan-branch`, `postgres` |
| `--destination <backend>` | Destination backend (required) |
| `--execute` | Actually perform the migration (default: dry-run) |
| `--update-config` | Update lazy.toml to use destination backend after successful migration |
| `--force` | Allow migration even if destination already has data (upsert semantics) |
| `--yes` | Skip confirmation prompts (for non-interactive use) |

### Example flows

**Dry run (default):**
```
$ lazy system migrate --destination postgres

Migration plan:
  Source:      in-repo (FileStorage at .lazy/)
  Destination: postgres (PostgresStorage)

  Tasks:         42
  Sessions:      38
  Turns:        156
  Commits:      203
  Reviews:       12
  Comments:      67
  Conversations:  8

  Estimated size: ~2.3 MB

  No active tasks found. Safe to migrate.

  This is a dry run. To execute, add --execute.
```

**Execute:**
```
$ lazy system migrate --destination postgres --execute

Acquiring migration lock...
Migration: in-repo -> postgres
  Migrating tasks...        42/42
  Migrating sessions...     38/38
  Migrating turns...       156/156
  Migrating commits...     203/203
  Migrating reviews...      12/12
  Migrating comments...     67/67
  Migrating conversations... 8/8

Verification:
  Tasks:         42/42
  Sessions:      38/38
  Turns:        156/156
  ...
  Referential integrity: OK

Migration complete. Releasing lock.
Source data preserved at .lazy/

To switch to postgres backend:
  lazy system migrate --destination postgres --update-config
  -- or edit lazy.toml manually:
    [storage]
    backend = "postgres"
```

### Destination-specific flags

Some backends need extra config for the destination:

```
# File-based destination needs a path
lazy system migrate --destination external --external-path ~/.lazy/myproject

# Orphan branch destination needs a branch name
lazy system migrate --destination orphan-branch --branch-name lazy-state

# Postgres destination reads from env vars (LAZY_POSTGRES_URL, PGHOST, etc.)
lazy system migrate --destination postgres
```

These mirror the existing `createStorage()` options.

## Implementation Task Prompt

This section replaces the `add-system-migrate` task prompt.

### Goal

Implement `lazy system migrate` for migrating state between any two storage backends.

### Implementation steps

1. **Add `MigratableStorage` interface** at `src/storage/migratable.ts` with `MigrationProgress`, `MigrationReport`, and `MigratableStorage` as designed above.

2. **Implement `migrateFrom` on each driver:**
   - `FileStorage`: Read all entities from source via Storage read methods. Write task.json and all entity files directly using `atomicWriteTask()`. Bypass `createTask()` entirely.
   - `PostgresStorage`: Read all entities from source via Storage read methods. Disable FK constraints, INSERT with explicit IDs and timestamps using `ON CONFLICT DO UPDATE`, re-enable constraints, validate referential integrity.
   - `OrphanBranchStorage`: Delegate to inner FileStorage's `migrateFrom`, then auto-commit.

3. **Add CLI command** at `src/cli/commands/system.ts` — `lazy system migrate` with all flags listed above.

4. **Implement migration lock** as part of this task (not a separate prerequisite) — `migration.in_progress` in `lazy.toml` with `{ pid, started_at }`, checked by all mutating commands (`start`, `unblock`, `resume`, `accept`, `reject`), acquired/released by the migrate command. Include stale-lock detection via `process.kill(pid, 0)`.

5. **Add e2e tests** — at minimum: file-to-file migration, idempotent re-run, active task rejection, migration lock prevents concurrent operations.

### Key invariants

- Source storage is never modified.
- All IDs (UUIDs) are preserved exactly.
- All timestamps are preserved exactly.
- Each driver handles its own write strategy — no external module needs driver internals.
- Migration is idempotent (safe to re-run).
- Active tasks (`working`/`interrupted` status) block migration.
- System-wide lock prevents concurrent task operations during migration.

## Open Questions

1. **Worktree snapshot enumeration.** The current Storage interface only exposes `getLatestWorktreeSnapshot(sessionId)` and `getWorktreeSnapshotForTurn(sessionId, turnSequence)`. To enumerate all snapshots for a session, `migrateFrom` must iterate through all turns and call `getWorktreeSnapshotForTurn` for each — an N+1 query pattern. Adding `listWorktreeSnapshots(sessionId): Promise<WorktreeSnapshot[]>` to the Storage interface would be more efficient but is not blocking. **Recommendation:** Add it as a nice-to-have improvement; migration works without it, just slower.

2. **Conversation-task linkage.** Conversations use `sessionId` as their primary key, but this is a Claude Code session ID — not a lazy session ID. They're standalone entities with no FK to tasks or sessions. Migration is straightforward: copy as-is.

3. **Large datasets.** For very large installations (thousands of tasks, large conversation transcripts), each driver's `migrateFrom` processes one task at a time (reads from source, writes to self), so memory usage scales with the largest single task bundle, not the total dataset. This is naturally streaming at the task level.
