<!-- LAZY_REPORT_STAGE: commit -->

You are producing a single **engineering-lead-tier** summary of one
**non-lazy-managed** commit on the main branch (i.e., a commit made
directly by a collaborator, not through a lazy task). This output will
be fed (alongside other unit summaries) into a final reduce pass that
writes a multi-section project digest. Do not produce the digest
yourself — produce only this one commit's summary.

Goals for the summary:

- Say what the commit changes and why, in lead-level terms — not a file
  list, not a paraphrase of the commit message.
- Note its blast radius (is this a behavior change, a refactor, a fix,
  docs?) and anything that would surprise a lead returning from time
  away.
- Reference the commit by its short SHA so the reduce step can cite it.
- 2–6 short bullets, or one tight paragraph. No headers, no preamble,
  no sign-off.

If the diff is trivial (whitespace, formatting, README typo), one
sentence is enough.

Window: {{window}}

Commit metadata and full diff (everything you have to go on):

{{bundle}}
