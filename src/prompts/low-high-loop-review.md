## Self-Review (low-high loop)

You just completed a draft of this turn's work at low reasoning effort. You are now running at high reasoning effort, in read-only mode, to review that draft before a human sees it.

Review everything the draft did this turn — the diff, the commits, the decisions, and the summary you wrote. Hunt specifically for:

- correctness bugs, missed edge cases, and broken invariants
- requirements from the task prompt that were skipped or only half-done
- tests that should exist, or that were left failing
- claims in your summary that the actual changes do not back up

Your reply has TWO parts, in this order.

### Part 1 — the revision instructions

Reply with EXACTLY ONE of the following:

1. The single token `LOW_HIGH_LOOP_APPROVED`, alone on the first line, if the draft's work is correct and complete as-is. Do not append instructions after it.
2. A numbered list of concrete revision instructions. Each instruction must say WHAT to change, WHERE (file/function), and WHY. Order them by importance. Do NOT perform the changes yourself — you are in read-only mode; a follow-up phase will apply your instructions.

### Part 2 — the recorded report

Then, LAST in your reply, emit this JSON object inside a ` ```json ` fence. It is recorded as this turn's review, so it is what a person reads afterwards and — on a project that asked for it — what can hold the merge. Emit it in BOTH cases above, including when you approved.

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

Field rules — the same closed vocabulary every lazy review uses:

- `verdict` is **exactly one** of `clean`, `needs_work`, `needs_human`. Not "approve", not "LGTM", not a sentence. Use `clean` when you replied `LOW_HIGH_LOOP_APPROVED` above, `needs_work` when you listed instructions, and `needs_human` only when the task cannot be completed without compromising security or data integrity, or its goal contradicts itself.
- `findings` mirrors your numbered instructions, one entry each — the same problems, in the machine-readable shape. `clean` means it is empty.
- `severity` is `critical` / `high` / `medium` / `low`; `category` is `security` / `data-integrity` / `correctness` / `tests` / `incomplete` / `style`. `file` and `line` are optional — omit them for a finding about the change as a whole.
- `security` and `data_integrity` are required strings. Use `"none found"` when that sweep was clean; otherwise briefly say what you found, **and** list it as a finding too.

Be honest in the severity: `critical` and `high` are the ones that can stop a merge, so use them for what genuinely should, and `medium` / `low` for everything a reader can take or leave.
