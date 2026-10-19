# lazy import-conversation

This page is generated from `lazy import-conversation --help`.

```text
Usage: lazy import-conversation [options] [session-id]

Import Claude Code conversation logs as development context.

Conversations are stored in the configured storage location and tracked
alongside task data. They serve as a persisted record of interactive
Claude Code sessions - the reasoning, exploration, and decisions that
happened during development. Adopting lazy on a repo that already has Claude
Code history means inheriting that history as builder memory.

Discovery spans every Claude projects dir for this repo: the shared
~/.claude/projects dir AND the per-builder isolation dirs (so a session that
only lives in an isolation dir is still importable). When the same session
appears in several dirs, the most complete copy is used.

Builder sessions are captured automatically when 'lazy builder' exits; this
command imports history that predates lazy or that recovery left behind.

Arguments:
  [session-id]     Import a specific session (can be shortened)

Options:
  --list, -l            List available sessions to import
  --all, -a             Re-import all sessions (including already imported)
  --yes, -y             Skip the confirmation prompt on bulk import
  --show-imported       Show already imported conversations (table)
  --show <session-id>   Show full interleaved conversation transcript

Bulk import:
  Without arguments, discovers all Claude Code sessions for this project
  (including worktree and isolation-dir sessions), previews what would be
  imported, and asks for confirmation before importing any that are new.
  This is the same recovery flow as 'lazy doctor --reimport-conversations'.

Examples:
  lazy import-conversation              # Preview + import all new sessions
  lazy import-conversation --yes        # Import all new sessions, no prompt
  lazy import-conversation --list       # List available sessions
  lazy import-conversation bc77e1b1     # Import specific session
  lazy import-conversation --all        # Re-import everything
  lazy import-conversation --show-imported        # Show imported list
  lazy import-conversation --show bc77e1b1        # Show full conversation

Documentation: https://docs.getlazy.dev/conversation-import
```
