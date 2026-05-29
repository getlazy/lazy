You are writing the description that will land on the target branch when this
task's work is merged. It becomes the permanent record of *what actually
happened* — so it must reflect the work as it really unfolded, not the plan it
started from.

The initial goal and prompt below are where the task STARTED. The events that
follow (agent turns, human feedback, child contributions, commits) are what the
work BECAME. When they diverge, the events win: describe pivots, course
corrections, scope changes, and review feedback that reshaped the work.

## Initial goal

{{goal}}

## Initial prompt

{{prompt}}

## What actually happened

{{bundle}}

## Instructions

Write a concise, factual Markdown summary of the work that was actually done.

- Lead with a one-paragraph overview of what changed and why.
- Use short bullet points for notable specifics: pivots away from the original
  plan, rounds of human feedback that changed direction, and contributions
  merged from child/subtask work.
- Do NOT invent details not supported by the events. If the work matched the
  plan, say so briefly rather than padding.
- Do NOT include a heading like "# Summary" — output just the body Markdown.
- Do NOT restate the raw event log; synthesize it.

Output only the Markdown body. No preamble, no sign-off.
