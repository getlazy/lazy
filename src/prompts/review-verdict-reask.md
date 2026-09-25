Your review is recorded, but its verdict could not be read.

A verdict is not a sentence — lazy acts on it mechanically: `clean` accepts,
`needs_work` sends your findings back to the implementer as its next brief,
`needs_human` parks the task for a person. Anything else is a failed review
that blocks acceptance and helps nobody.

Reply with the JSON object and **nothing else** — no prose before it, no prose
after it, no explanation of what you already said.

**What this reply must supply is the verdict and the two sweep statements.** So
the normal reply LEAVES `findings` OUT — omitting the key means "nothing to add"
and keeps every finding from your first reply, in full. You do not have to
repeat a list you already gave.

```json
{
  "verdict": "clean | needs_work | needs_human",
  "security": "none found",
  "data_integrity": "none found"
}
```

**Include `findings` only to CHANGE the list.** The array you send REPLACES what
you filed before — a finding you leave out of it is withdrawn — so send the ones
that still stand, in full:

```json
{
  "verdict": "needs_work",
  "security": "none found",
  "data_integrity": "none found",
  "findings": [
    { "severity": "high", "category": "correctness", "file": "src/foo.ts", "line": 42, "summary": "One line: what is wrong and why it matters." }
  ]
}
```

**If re-reading convinced you that none of them stand, send `"findings": []`
with a `clean` verdict.** That is the one way to withdraw, and it is honoured:
an explicitly empty array retracts the lot. Do not send `clean` while leaving
the key out — that keeps the findings, and a `clean` verdict over findings you
filed a moment ago is read as a contradiction, with the findings winning and
acceptance still held.

Rules, in one place:

- `verdict` is exactly one of `clean`, `needs_work`, `needs_human`. Not
  "approve", not "LGTM", not "request changes", not a sentence.
- `findings` is the issue list, and it is what the implementer will be asked to
  fix. `clean` means you found nothing, in this reply or the first one;
  `needs_work` means there is at least one finding between the two. Leave the
  key out to keep your list; send an array to replace it, `[]` to withdraw it.
- `security` and `data_integrity` are required strings. `"none found"` when
  that sweep was clean; otherwise say what you found, and file it as a finding
  too.
- Use `needs_human` only when the task cannot be completed without compromising
  security or data integrity, or its goal contradicts itself — and file the
  blocking raise for it. A defect that CAN be fixed is a finding, not a
  decision.

This is the only re-ask. If this reply is still not parseable JSON, the review
is recorded as failed.
