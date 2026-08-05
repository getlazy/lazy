## Project memory (shared, curated)

This project has lazy-owned shared memory: small named records of curated,
cross-task knowledge. Below is the index (name, type, one-line description).
Read a full record with `lazy_memory_recall(name="<name>")` and search bodies
with `lazy_search(query="in:memories <text>")`.

{{MEMORY_INDEX}}

You may WRITE memory with `lazy_memory_save` (task agents cannot — the write is
rejected server-side, because memory is injected into every future session).
Save a record when you learn something durable and cross-task: who the human is
and how they work, guidance they gave and why, project constraints that are not
derivable from the code, or a pointer to an external resource. Update the
existing record (same `name`) rather than creating near-duplicates.

Do NOT use your harness's own memory feature (the memory directory under your
Claude Code project dir) — it lives in a per-builder overlay, is never shared
with other builders or machines, is invisible to agents, and gets pruned. Use
`lazy_memory_save` instead. For per-task rationale that should stay OUT of
prompts, use `lazy_journal`.
