<!-- LAZY_REPORT_STAGE: reduce -->

You are writing the final activity digest for a Lazy project, covering
**all main-branch activity in the window** — both lazy-managed tasks
and direct (non-lazy) commits on main, plus any builder/engineer
conversations not tied to a tracked task.

You are given pre-summarized "unit summaries" produced by upstream
calls. Each unit is labeled with its kind (`lazy task` or `non-lazy
commit`), its identifier (task code/short id, or commit short SHA + author),
and its lead-tier summary text. Trust those summaries — do not
fabricate detail beyond them.

Produce a single markdown document with **exactly three sections**, in
this order:

1. `## Brief` — a tight, top-level clustering of all activity in the
   window. One short paragraph (2–4 sentences) plus 3–6 bullets. Aim:
   an engineering manager can skim it in 15 seconds.

2. `## For the engineering manager` — decisions made, direction
   changes, architectural movements, releases, anything affecting
   roadmap or stakeholder communication. **Bulleted, not prose.**
   Group bullets by theme. No code dumps, no file lists, no per-task
   minutiae.

3. `## For the engineering lead` — more substance. **Cluster related
   work thematically** rather than reprinting per-unit summaries.

   **Required structure for this section:**
   - Give each thematic cluster its own `###` sub-heading. Use 2–6
     clusters total; collapse any with only one or two related items
     into a broader theme rather than leaving them as single-item
     groups.
   - Under each sub-heading, use bullet points. Sub-bullets (indent
     two spaces) are fine for detail under a cluster point. **Do not
     write prose paragraphs in this section** — every line should be
     a heading or a bullet.
   - Each bullet that references a unit must cite it inline:
     - lazy-managed work: by task code, e.g. `` `task-code` ``
     - non-lazy commits: by short SHA + author, e.g. `` `abc1234` ``
       (Alice)
   - At the end of the section add a final `### Other notable
     activity` sub-heading for any units that don't fit a cluster,
     even if it only contains one or two bullets.

   The lead should be able to rebuild their mental model by skimming
   the sub-headings, then drilling into the bullets they care about.

Output **only** the markdown report. No preamble, sign-off, or extra
prose outside the three sections. Do not add a `## Window` section —
the caller already printed the window above your output.

If the unit summaries are empty or all trivial, say so plainly under
each section ("Nothing of note in this window.") rather than inventing
content.

If `{{failed_units}}` is non-empty, mention in the Brief that N
unit(s) could not be summarized (so reviewers know the digest is
partial). Otherwise omit that note.

Window: {{window}}

Unit summaries:

{{units}}

Builder/engineer conversations not tied to a tracked task (raw — these
were not pre-summarized):

{{orphan_conversations}}

Failed units (could not be summarized; mention briefly if non-empty):

{{failed_units}}
