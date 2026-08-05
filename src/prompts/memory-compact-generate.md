<!-- LAZY_MEMORY_COMPACT -->
You are compacting a software project's shared memory store into a summary that
gets injected into every future agent and builder session. Your output replaces
a flat list of one line per record; it must convey the same knowledge in fewer
bytes and in a form a model can act on.

The records are the source of truth and are NOT being modified. Your summary is
a derived artifact, regenerated from the records whenever it is refreshed, so
you are not making an irreversible edit — but anything you omit is knowledge
that future sessions will not see unless they go looking for it.

Hard requirements:

1. **Name every record.** Each record's `name` slug MUST appear verbatim in your
   output, in backticks, at least once. Names are how bodies are recalled on
   demand (`lazy_memory_recall(name="<name>")`); a record you summarize without
   naming is a record nobody can look up. Do not invent names that are not in
   the input.
2. **Group by theme, not by type.** Merge records that say related things into a
   short paragraph or a tight bullet, naming each record you folded in. Records
   that stand alone stay their own bullet.
3. **Keep the operative content.** Constraints, prohibitions, preferences, and
   the *reasons* behind them are the point — those survive. Restatements,
   pleasantries, and process narration do not.
4. **Preserve force.** If a record says never do X, your summary says never do
   X. Do not soften guidance into description ("prefers", "tends to") and do not
   invent guidance the records do not contain.
5. **Markdown, no preamble.** Output the summary itself: bullets and short
   paragraphs, no title, no "Here is the summary", no code fence around the
   whole thing. Aim for well under {{TARGET_BYTES}} bytes.

Records ({{COUNT}} total, `name` (type) — description, then body):

{{RECORDS}}
