# lazy show

This page is generated from `lazy show --help`.

```text
Usage: lazy show|view <id> [--full] [--chunks] [--flat] [--lines N..M] [--json]

Show detailed information about a task, conversation, or file.

If given a task ID or task code, shows the task with its session, turns,
commits, comments, and any child tasks (variants).

If given a conversation session ID (or prefix), shows the full interleaved
conversation transcript.

If given a file path, renders the file in a scrollable TUI viewer.
Markdown files (.md) are rendered with formatting.

Also supports viewing built-in system prompts (lazy-prompt-*).

Arguments:
  <id>         Task ID, task code, conversation session ID, file path,
               or built-in prompt code

Turn grouping:
  'lazy view' groups turns into review chunks by default (parity with the
  'lazy browse' TUI); the canonical 'lazy show' lists turns flat by default.
  Use --chunks or --flat to force either mode regardless of how it was invoked.

Options:
  --full       Show complete turn and comment content instead of truncated preview
  --chunks     Group turns into review chunks (one human/builder boundary plus its
               following agent/supervisor/system turns) instead of a flat list
  --flat       List turns flat (the default for 'lazy show'; overrides the chunked
               default of 'lazy view')
  --lines N..M Return only lines N through M of the output (1-indexed, inclusive)
               Formats: N..M (range), N.. (from N to end), ..M (start to M)
  --json       Output as structured JSON instead of human-readable text

Examples:
  lazy show abc12345                          # Show task by ID
  lazy show abc1                              # Prefix matching works
  lazy show abc1 --full                       # Show full turn and comment content
  lazy show abc1 --chunks                     # Group turns by human/builder review boundary
  lazy view abc1                              # Turns grouped into chunks by default
  lazy view abc1 --flat                       # Force the flat turn list
  lazy show abc1 --lines 10..20               # Show only lines 10-20 of output
  lazy show abc1 --lines 50..                 # Show from line 50 to end
  lazy show abc1 --json                       # Output task as JSON
  lazy show dddddddd                          # Show conversation by session ID prefix
  lazy show dddddddd --lines 1..100           # Show first 100 lines of conversation
  lazy show lazy-prompt-system-instructions   # View a built-in system prompt
  lazy show README.md                         # View a file in scrollable TUI
  lazy show src/index.ts                      # View a TypeScript file
  lazy show AGENTS.md --lines 1..50           # Show first 50 lines of file
```
