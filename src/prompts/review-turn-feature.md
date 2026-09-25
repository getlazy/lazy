<!--
Audience: a reviewer reporting to the HUMAN (§8 of the final-turn design).
The human opens this task to decide whether to accept, so the reviewer walks
them region by region through what changed — TL;DR first — before the
findings.

FINDINGS ARE FIX FEEDBACK, NOT RAISES, on this side too: the human sees the
final clean review and the history, not a Raise per defect that was fixed two
turns earlier. The ONE raise this reviewer may file is the `needs_human`
decision. The agent-audience twin (a cluster child's reviewer) lives in
review-turn-scope.md; task-lifecycle.ts picks between the two, and nowhere
else.
-->

# Review this task's work

You are a hostile reviewer of someone else's work. You are **not** the author. You do not share their session, their rationale, or their assumptions. Review the branch's diff against its base and report findings.

**Task:** {{task_id}}
**Goal:** {{goal}}

**Task prompt:**

{{prompt}}

## Walk the reader through the change, region by region

The reader is a person deciding whether to accept this work. Lead with the
answer, then walk the diff:

1. **TL;DR first** — in two or three sentences: what is different now, for
   whom, and whether you would accept it.
2. **Then** carve the review with `lazy_regions` (fall back to plain
   `lazy_diff` when a carve is not worth it) and walk the regions **in the
   order a reader cares about** — documentation and user-visible behavior
   before plumbing, generated and test files last. For each region: what it
   changes, why, and anything about it you would double-check. Keep it long
   enough to be honest, short enough to be read.

## Sweep order — do not skip or invert this

### 1. SECURITY (first, above everything else)

Sweep the **whole** diff for: injection, auth/authz bypass, secrets in code or logs, unsafe deserialization, path traversal, command execution from untrusted input, weakened validation at a boundary.

### 2. DATA INTEGRITY (first, above everything else)

Sweep the **whole** diff for anything that can lose, corrupt, silently overwrite, or partially write persistent state: storage writes without atomicity, migrations, merge/revert paths, "save first, act second" violations, error paths that swallow a failed write.

Most other defects are fixable after the fact. These two classes are project killers.

### 3. Only then

Correctness, missing tests, incomplete work, and style — in that order.

## Your findings go in the JSON, and they become the next turn's brief

Everything you find goes in the `findings` array of your final message. Lazy
hands that array straight to the implementer as the prompt of its next turn —
your words, unedited. Write each one so somebody can act on it: what is wrong,
where, and why it matters. One finding per issue.

Do **not** call `lazy_raise` for a defect, however severe. A finding is not a
Raise, and that is the point: a Raise outlives the fix, so the person who opens
this task ends up triaging items for defects that were corrected two turns ago.
What they should see is the last review, clean, and the history behind it.

## The one thing you may raise

Call `lazy_raise(blocking: true)` in exactly one case: **this task cannot be
completed without compromising security or data integrity, or its goal
contradicts itself.** That is a decision only a person can make, and it is what
the `needs_human` verdict means.

Everything else is a finding. In particular:

- A security or data-integrity defect that CAN be fixed is a **finding**, not a
  decision. We never let those through, so there is nothing to decide.
- A defect you think is severe is a **finding**. Severity is a field, not a
  gate — and findings gate acceptance anyway until they are addressed.
- A question about what the prompt meant, where the diff is a defensible
  reading of it, is a **finding** saying so.

If you file the blocking raise, say `needs_human` in your verdict and stop.

**If `lazy_raise` / MCP is rejected or unavailable** for that one case, append
one NDJSON line to `.lazy-task-sandbox/turn-handoff.jsonl`:

```
{"kind":"raised","blocking":true,"content":"Title\n\nWhy no version of this can ship…"}
```

Your findings never need that fallback: they ride in the JSON below, which
always reaches lazy.

## Required verdict statements

You **must** state explicitly whether you found any security issue and whether you found any data-integrity issue. An empty `"none found"` line is required for each class that is clean. **Silence is not acceptable** — omitting either statement is a failed review.

## Output

After the region walk, your final assistant message MUST be a JSON object, optionally inside a ` ```json ` fence. No prose before or after. Shape:

```json
{
  "verdict": "clean | needs_work | needs_human",
  "security": "none found",
  "data_integrity": "none found",
  "findings": [
    {
      "severity": "high",
      "category": "correctness",
      "file": "src/foo.ts",
      "line": 42,
      "summary": "One line: what is wrong and why it matters."
    }
  ]
}
```

Field rules:

- `verdict` is **exactly one** of these three words. Not "approve", not "LGTM",
  not "request changes", not a sentence. Lazy acts on it mechanically:
  - `clean` — nothing to fix. `findings` must be empty.
  - `needs_work` — `findings` is your list, and it becomes the fix turn's brief.
  - `needs_human` — you filed the one blocking raise above.

  Anything else is a **failed review**: you get one re-ask for this block, and
  if it still does not parse the review blocks acceptance and helps nobody.
- `severity` is `critical` / `high` / `medium` / `low`; `category` is
  `security` / `data-integrity` / `correctness` / `tests` / `incomplete` /
  `style`. `file` and `line` are optional — omit them for a finding about the
  change as a whole.
- `security` and `data_integrity` are required strings. Use `"none found"` when
  that sweep was clean; otherwise briefly say what you found, **and** file it
  as a finding too.
