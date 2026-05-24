# Lazy

A development environment that sits between software developers and AI coding agents, capturing all interactions into a searchable database.

## Vision

Software development with AI agents produces valuable artifacts beyond code: the rationale for decisions, alternatives considered and rejected, the iterative dialogue that shaped the implementation. Today this is lost - scattered across terminal sessions, chat windows, and memory.

Lazy treats the review/decision cycle as the primary abstraction, not an afterthought bolted onto version control. The conversation *is* the commit message. The rejection rationale *is* the documentation of what we chose not to do.

Git is a kludge - a transaction log emulated through files because we insist on flat text files as source code organization. Lazy uses git for interoperability but structures data such that git can eventually be replaced. The database is the source of truth; git is a projection.

## Core Concepts

**Task**: A unit of work with a specification. Created by the human architect, worked on by agents.

**Session**: A bounded interaction between human and agent working on a task. Maps to a git branch. Contains conversation turns and commits.

**Turn**: A single message in the conversation - human or agent. The dialogue that led to decisions.

**Commit**: A code change produced during a session. Has review status. Even rejected commits are preserved with rationale.

**Review**: A human verdict on a commit with rationale. The "why" that explains the decision.

## Data Model

```
Task {
  id: uuid
  title: string
  spec: text (markdown)
  status: draft | active | complete | abandoned
  created_at: timestamp
  completed_at: timestamp?
}

Session {
  id: uuid
  task_id: uuid (FK)
  agent_id: string
  started_at: timestamp
  ended_at: timestamp?
  git_branch: string
  git_start_sha: string
}

Turn {
  id: uuid
  session_id: uuid (FK)
  sequence: integer
  role: human | agent
  content: text
  timestamp: timestamp
}

Commit {
  id: uuid
  session_id: uuid (FK)
  sha: string
  message: string
  diff: text
  status: pending_review | approved | rejected | superseded
  timestamp: timestamp
}

Review {
  id: uuid
  commit_id: uuid (FK)
  verdict: approve | reject | request_changes
  rationale: text
  reviewer: string
  timestamp: timestamp
}
```

## CLI Interface

The CLI command is `lazy`. Reads like English.

```bash
# Initialize lazy in a git repository
lazy init

# Task management
lazy task create --title "implement auth middleware"
lazy task create -f spec.md
lazy task list
lazy task show <task_id>

# Session management (creates branch, launches agent, captures interaction)
lazy session start <task_id>
lazy session list
lazy session show <session_id>

# Review workflow
lazy review                      # show pending commits with conversation context
lazy review --commit <sha>       # review specific commit
lazy approve <sha> --rationale "clean implementation"
lazy reject <sha> --rationale "breaks existing tests, see Turn 14"
lazy request-changes <sha> --rationale "needs error handling"

# Merge completed work
lazy merge <task_id>             # merge when all commits approved

# Query the archive
lazy log                         # timeline view
lazy why <file:line>             # show rationale chain for this code
lazy search "auth middleware"    # full-text search across turns, reviews, specs
```

## Architecture

```
lazy/
  src/
    cli/              # command handlers (one file per command group)
      init.ts
      task.ts
      session.ts
      review.ts
      query.ts
    db/
      schema.ts       # table definitions
      migrations/     # schema migrations
      queries.ts      # typed query functions
    capture/
      claude.ts       # Claude Code interception/wrapping
      parser.ts       # conversation parsing
    git/
      operations.ts   # branch, commit, merge operations
      sync.ts         # bidirectional sync with lazy db
    config/
      types.ts        # configuration type definitions
      loader.ts       # TOML parser and config loader
      index.ts        # public config API
    types/
      index.ts        # core data types
    index.ts          # CLI entry point
  .lazy/              # local database and config (like .git)
  lazy.toml           # user configuration (like bunfig.toml)
  package.json
  tsconfig.json
  bunfig.toml
```

## Technical Decisions

**Language: TypeScript on Bun**

Rationale: Bun runs TypeScript directly without transpilation ceremony. Bun was acquired by Anthropic and powers Claude Code - alignment with the ecosystem we're building for. Single-file executables via `bun build --compile` for distribution. Native SQLite bindings (`bun:sqlite`) are fast.

**Database: SQLite with FTS5**

Rationale: Single file, no server, embedded. Full-text search built-in for the "search across everything" use case. The `.lazy/` directory contains the database - portable, inspectable.

**Configuration: TOML**

Rationale: Lazy uses `lazy.toml` for configuration, following the pattern of tools like `bunfig.toml` and `pyproject.toml`. TOML is human-readable, easy to edit, and has native support in Bun via `Bun.TOML.parse()`. Configuration includes model selection, session behavior (verbose/debug modes), git workflow settings, and output formatting. The config file is created automatically on `lazy init` with sensible defaults and inline documentation.

**Git Integration: Essential but Abstracted**

Rationale: Git is required for adoption - developers won't use a tool that doesn't integrate with their existing workflow. But we don't depend on git-specific features (no worktrees, no exotic features). Git operations are isolated in `src/git/` so the backing store can change. The database is authoritative; git is synchronized.

**Capture Mechanism: Wrap Claude Code**

Rationale for v0.1: `lazy session start` launches `claude` as a subprocess, intercepts stdin/stdout, parses conversation. Preserves familiar Claude Code UX. Architecture allows switching to Claude Agent SDK later for richer control.

**Review Interface: CLI for v0.1**

Rationale: Get the data model and capture right first. Web UI comes in v0.2 - enables richer interaction, comments, threads, different views for different audiences.

## What's in v0.1

- `lazy init` - initialize lazy in a repo
- `lazy task create/list/show` - task management
- `lazy session start` - launch agent session with capture
- `lazy review` - CLI review of pending commits
- `lazy approve/reject` - verdict with rationale
- `lazy merge` - complete a task
- `lazy log` - basic timeline
- `lazy search` - full-text search

## What's Deferred

- Web UI (v0.2)
- Conversation import from claude.ai (v0.2)
- Multi-agent coordination / standups
- Specialist agent integration (security review, etc.)
- DB-as-filesystem mounting (FUSE)
- Git replacement / native versioning
- Agent awareness of each other's work
- A/B testing prompts at specific commits
- Fine-tuning data extraction

## Design Rationale Archive

This section preserves key decisions from the initial design conversation.

**Why not Python?**

Claude's error rate is lowest in Python, but the human architect is deeply familiar with the Node/TypeScript ecosystem after years of production experience. Shared understanding between human and AI is more valuable than marginal AI accuracy improvement. Bun's acquisition by Anthropic further tips the balance.

**Why code review as primary interaction model?**

Agents generate too much code for synchronous pair-programming style review. Asynchronous review - agent works, commits, human reviews - matches how senior engineers work with junior team members. The code review page is the most important page in GitHub, yet it's barely evolved in 10+ years and is ill-suited for agent-based teams.

**Why preserve rejected work?**

"Why we didn't do something" is often as valuable as "why we did." Design docs and comments age badly. The rich tapestry of decisions - including rejections - is the actual documentation. Query: "why did we do this?" should surface the conversation, alternatives considered, and rationale.

**Why the human remains architect?**

Agents are team members, not responsible parties. The human is the architect, takes advice from specialists (including specialized agents), but holds responsibility. No hierarchy among agents - they work on parallel tasks, merge conflicts resolved by whoever merges second.

**Why git-as-kludge thesis?**

Nobody designing a development system from first principles would say "organize into directories and flat files, then emulate a transaction log through another set of files." The source of truth should be a database with intrinsic versioning where every mutation is a transaction with attached rationale. Git is an import/export format for interoperability.

## Bootstrap Goal

Create a task, work with an agent, review commits with rationale, query "why did we do X?" - within a week of focused work. Then move development of lazy itself into lazy.
