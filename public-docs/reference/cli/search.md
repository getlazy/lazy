# lazy search

This page is generated from `lazy search --help`.

```text
Usage: lazy search <query> [options]

Search across tasks, prompts, turns, commits, notes, raised items, conversations,
and shared memory records.

Options:
  -f, --fuzzy        Use fuzzy matching (typo-tolerant)
  -g, --group        Group results by task
  --json             Output as structured JSON with line numbers

Filter by type:
  --tasks            Search task goals only
  --prompts          Search task prompts only
  --turns            Search conversation turns only
  --commits          Search commit messages only
  --notes            Search task notes only
  --followups        Older spelling of --raised
  --raised           Search agent-raised questions/decisions only
  --conversations    Search captured builder conversations only
  --memories         Search shared memory records only
  --scratch          Search captured builder scratch files only

Query language:
  Supports Lucene-style syntax with boolean operators and field filters.
  When operators, field syntax, or a #tag are detected, structured search is
  used automatically. Plain text queries use regex (case-insensitive) matching.
  The dashboard's search page shows this same grammar inline.

  Boolean operators:
    A AND B                   Both must match (also the implicit operator between two adjacent terms)
    A OR B                    Either matches
    NOT A                     Negation
    (A OR B) AND C            Parentheses group; AND binds tighter than OR

  Field filters:
    task:<text>               Task code CONTAINS this text (case-insensitive)
    status:<value>            Task status, exact (working, blocked, backlog, complete, abandoned, ...)
    goal:<text>               Task goal contains this text (case-insensitive)
    tag:<value>               Task carries this tag, exact after normalization
    #<value>                  Shorthand for tag:<value>, also matching the literal text "#value"

  Scoped text search:
    in:tasks <text>           Across tasks and all content attached to them
    in:active <text>          Within working, interrupted, or blocked tasks
    in:backlog <text>         Within backlog tasks
    in:finished <text>        Within accepted, closed, or rejected tasks
    in:turns <text>           Within turn content
    in:commits <text>         Within commit messages
    in:comments <text>        Within comments
    in:raised <text>          Within raised items (blocking and non-blocking alike)
    in:followups <text>       Alias for in:raised (the pre-unification spelling)
    in:conversations <text>   Within captured builder conversations
    in:memories <text>        Within shared memory records
    in:scratch <text>         Within captured builder scratch files

  Existence checks:
    has:commits               Task has commits
    has:turns                 Task has turns
    has:comments              Task has comments
    has:raised                Task has raised items
    has:followups             Alias for has:raised

  Date filters:
    created:>YYYY-MM-DD       Created after (also created:< for before)
    updated:>YYYY-MM-DD       Last updated after (also updated:< for before)

Good to know:
  - Boolean operators are case-sensitive: AND, not and. AND binds tighter
    than OR, and two adjacent terms with no operator are an implicit AND.
  - task:, goal: and every in: scope are case-insensitive SUBSTRING matches —
    task:spike finds spike-vm-isolation and publish-runner-spike alike.
    status: and tag: are exact.
  - A query with no operator, no field: term and no #tag is a
    case-insensitive REGEX over all content.
  - An id works as a bare query: paste a task id, raised item, comment,
    journal entry, turn, commit SHA, artifact, review comment, system message
    or conversation id — a prefix of at least 6 characters or the whole thing
    — and every entity it names is listed first. An ambiguous prefix lists
    every match. Not available with --fuzzy.
  - Fuzzy matching (--fuzzy, or fuzzy=true over MCP) BYPASSES the query
    language: it looks for the literal text you typed, so tag:launch --fuzzy
    searches for "tag:launch".
  - Tags are normalized identically on write and on query — lowercased, runs
    of non-alphanumerics collapsed to hyphens, a leading # stripped. Quote a
    multi-word tag: tag:"My Feature Work", or only its first word counts.
  - In a shell, wrap the whole query in single quotes: # starts a comment,
    and an unquoted multi-word value is split into separate terms.

Examples:
  lazy search 'auth'                                      # Regex search over everything
  lazy search 'task:spike'                                # Every task whose code contains "spike"
  lazy search 'status:blocked AND in:turns "reconciler"'  # Blocked tasks whose turns mention a reconciler
  lazy search 'goal:memory AND status:backlog'            # Combine a goal substring with a status
  lazy search 'has:commits AND NOT in:commits "wip"'      # Existence check plus a negation
  lazy search 'created:>2026-02-15 AND status:working'    # Date range plus a status
  lazy search 'tag:"My Feature Work"'                     # A multi-word tag — quote it
  lazy search '#onboarding'                               # Tag, using the spelling lazy prints
  lazy search 'in:memories "credentials"'                 # Search shared memory records
  lazy search 'catchup' --fuzzy                           # Typo-tolerant
  lazy search 'design decision' --conversations           # Filter to conversations only
  lazy search 'auth' --json                               # JSON output with line numbers

Documentation: https://docs.getlazy.dev/search
```
