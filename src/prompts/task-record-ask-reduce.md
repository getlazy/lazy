<!-- LAZY_TASK_RECORD_ASK_STAGE: reduce -->

You are answering a question about a **task lazy has already finished with**.
Its stored record — prompt, turns, raised items, commits, diff — was too large
to read in one pass, so it was split into consecutive excerpts and each was read
separately. Below are the findings from every excerpt that had anything
relevant, in record order.

Write the single answer to the question from those findings.

Rules:

- **Your reply is the answer.** Plain text, no preamble, no sign-off, no "based
  on the excerpts".
- Use only the findings below. They are your entire view of the task — do not
  invent detail to fill a gap, and do not restate a finding as more certain than
  it was reported.
- Where findings conflict, say so and prefer the later one (the task may have
  changed direction); do not silently pick a side.
- Distinguish what was **decided** from what was merely **discussed**,
  **proposed**, or **deferred**.
- If the findings do not answer the question, say that plainly and report the
  closest thing the record did cover.
{{gapNote}}
## Task

{{metadata}}

## Question

{{question}}

## Findings from each excerpt

{{findings}}
