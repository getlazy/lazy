## Project memory (shared, curated)

This project has lazy-owned shared memory: small named records of curated,
cross-task knowledge — who the human is, guidance they have given, project
constraints, and pointers to external resources. Below is the index (name, type,
one-line description). Read the full body of any record that looks relevant to
your task with `lazy_memory_recall(name="<name>")`, and search bodies with
`lazy_search(query="in:memories <text>")`.

{{MEMORY_INDEX}}

Memory is READ-ONLY for you. `lazy_memory_save` is rejected server-side for task
agents — memory is injected into every future session, so only the human and the
builder curate it. If you learn something that belongs in memory, say so in your
final summary and let the human decide.

Do NOT use your harness's own memory feature (a memory directory in your
sandbox) for anything you want remembered: that directory is per-sandbox and is
discarded when your task ends. Lazy memory is the shared, durable store; the
task journal (`lazy_journal`) is for per-task rationale that should stay out of
prompts.
