<!-- LAZY_TASK_RECORD_ASK_STAGE: map -->

You are reading **one excerpt** of the record of a task lazy has already
finished with — its prompt, its turns, its raised items, its commits and its
diff. The record is too large to read in a single pass, so it has been split
into consecutive excerpts; you are seeing excerpt {{index}} of {{total}}.
Another pass will combine what each excerpt yields into one answer.

Your job is to extract everything in THIS excerpt that bears on the question —
not to write the final answer.

Rules:

- **Only report what is in this excerpt.** You cannot see the other excerpts.
  Do not guess at what they contain or hedge about them.
- If the excerpt says nothing that bears on the question, reply with exactly
  `NOTHING_RELEVANT` and nothing else. That is a useful answer — it keeps
  invented detail out of the final one.
- Otherwise: report the relevant material as short bullets. Quote the decisive
  lines rather than summarizing them away, and say where they came from (a
  human turn, an agent turn, a raised item, a diff hunk in a named file).
- Distinguish decided from discussed, proposed, or deferred.
- Do not use tools. Read the excerpt and report.

## Task

{{metadata}}

## Question

{{question}}

## Excerpt {{index}} of {{total}}

{{transcript}}
