# Searching tasks

`lazy search` looks across tasks, prompts, turns, commits, notes, follow-ups,
captured conversations, and shared memory records. The builder and task agents
reach the same engine through the `lazy_search` MCP tool — **both surfaces share
one parser and one evaluator**, so a query that works in one works in the other.

`lazy search --help` is the authoritative reference for flags; this page explains
the query language and the behavior that isn't obvious from a flag list.

## Three matching modes

| Mode | When it is used | What it matches |
| --- | --- | --- |
| **Structured** | The query contains a boolean operator, a `field:` term, or a bare `#tag` | Parsed query, evaluated per field |
| **Regex** | Plain text with none of the above | Case-insensitive regex over content |
| **Fuzzy** | `--fuzzy` / `fuzzy=true` | Typo-tolerant match; never parses `field:` syntax |

Mode selection is automatic — there is no flag to force structured search. Note
that `--fuzzy` **bypasses** the query language: `lazy search 'tag:launch' --fuzzy`
looks for the literal text `tag:launch`, not for tasks tagged `launch`.

## Quote the whole query

Always wrap the query in single quotes:

```bash
lazy search 'tag:launch AND status:blocked'
```

Two shell behaviors bite otherwise. `#` starts a comment in most shells, so an
unquoted `#onboarding` never reaches lazy. And an unquoted multi-word value is
split into separate argv entries before lazy sees it.

## Query language

Boolean operators are **case-sensitive** (`AND`, not `and`). `AND` binds tighter
than `OR`. Two adjacent terms with no operator are an implicit `AND`.

```
AND                Both conditions must match
OR                 Either condition matches
NOT                Negation
(A OR B) AND C     Parentheses group
```

Field filters:

```
status:<value>          Task status (working, blocked, backlog, complete, ...)
goal:<text>             Match against the task goal
code:<value>            Match the task code
tag:<value>             Tasks carrying this tag
#<value>                Shorthand for tag:<value> (see Tags below)
in:turns <text>         Within turn content
in:commits <text>       Within commit messages
in:comments <text>      Within comments
in:followups <text>     Within follow-ups
in:conversations <text> Within captured builder conversations
in:memories <text>      Within shared memory records
has:commits             Task has commits
has:turns               Task has turns
has:comments            Task has comments
has:followups           Task has follow-ups
created:>YYYY-MM-DD     Created after / before (also created:<)
updated:>YYYY-MM-DD     Last updated after / before (also updated:<)
```

## Tags

Tags are normalized **on write and on query**, identically: lowercased, with
every run of non-alphanumeric characters collapsed to a single hyphen and
leading/trailing hyphens stripped. All four of these find the task tagged
`my-feature`:

```bash
lazy search 'tag:my-feature'
lazy search 'tag:MY-FEATURE'
lazy search 'tag:My_Feature!'     # punctuation collapses to a hyphen
lazy search 'tag:#my-feature'     # a leading '#' is stripped
```

Normalization applies to **one token**. It does not join words across a space —
see the multi-word caveat below.

A tag value that normalizes to nothing (`tag:"!!!"`) is a **parse error**, not a
silent zero-result — the write side rejects the same input, so the query side
does too.

### `#name` is the spelling lazy prints

`lazy tag` and `lazy show` print tags with a leading `#` ("Tags: `#launch`"), so
that spelling has to work when pasted back into a search. A bare `#launch` term
is a **superset**, not a redirect — it matches `tag:launch` *or* the literal text
`#launch`. That keeps `#1234` issue references in commit messages findable.

```bash
lazy search '#launch'    # tag 'launch', OR the text '#launch' anywhere
```

### Quote a multi-word tag

This is the one real trap. `tag:` consumes a single token, and adjacent tokens
are an implicit `AND`:

```bash
lazy search 'tag:"My Feature Work"'   # matches the tag 'my-feature-work'
lazy search 'tag:My Feature Work'     # tag:my AND text "Feature" AND text "Work"
```

The second form is valid syntax that usually matches nothing. Lazy does not
guess between the two — `tag:x some text` is a legitimate query — so instead it
explains the empty result (below).

## Empty tag results explain themselves

A structured, non-fuzzy tag query that returns nothing prints a hint naming what
is actually missing, rather than a bare "No matches found":

```
$ lazy search 'tag:onbording'
No matches found.

No task is tagged #onbording — did you mean #onboarding?
Known tags: #infra #launch #onboarding
Tags are normalized to lowercase alphanumerics and hyphens. Quote a multi-word tag: tag:"My Feature Work"
```

Details worth knowing:

- Suggestions come from tags that actually exist, ranked by prefix/substring
  relation first and edit distance second — the ranking that surfaces
  `my-feature-work` when an unquoted multi-word tag queried only `my`.
- If **every** queried tag exists, there is no hint: the empty result came from
  the rest of the query (a status, a date range, a text term), not the tag.
- `NOT tag:x` never triggers a hint — it says nothing about whether `x` exists.
- With `--json`, the hint appears as a top-level `hint` field. The MCP
  `lazy_search` tool returns the same field.

## Examples

```bash
lazy search 'auth'                                      # regex, everywhere
lazy search 'catchup' --fuzzy                           # typo-tolerant
lazy search 'status:blocked AND in:turns "reconciler"'
lazy search 'has:commits AND NOT in:commits "wip"'
lazy search 'created:>2026-02-15 AND status:working'
lazy search 'tag:onboarding'
lazy search '#onboarding'                               # the printed spelling
lazy search 'tag:"My Feature Work"'
lazy search 'tag:launch AND status:blocked'
lazy search 'in:memories "credentials"'
lazy search 'auth' --json                               # structured output
```

## Related

- [docs/memory.md](./memory.md) — shared memory records and `in:memories`
- [docs/lazy-agent-design.md](./lazy-agent-design.md) — how agents reach search
  over MCP rather than by shelling out
