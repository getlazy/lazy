# lazy memory

This page is generated from `lazy memory --help`.

```text
Usage: lazy memory <subcommand>

Manage lazy-owned shared memory — small, named records of curated cross-task
knowledge. A one-line index of every record is injected into builder and agent
launches; the full body is read on demand.

Subcommands:
  list                     Show the index of all records (default)
  show <name>              Print one record in full
  save <name>              Create or update a record
  rm <name>                Remove a record (tombstone; history is preserved)
  history [<name>]         Show the append-only, actor-attributed write history
  compact                  Regenerate the derived compact used for injection

Options:
  -a, --all                (list) Include removed records
  -d, --description "..."  (save) One-line summary (max 200 chars) — injected
  -t, --type <type>        (save) One of: user, feedback, project, reference
  -b, --body "..."         (save) Record body; omit to use piped stdin or $EDITOR
  -y, --yes                (rm) Skip the confirmation prompt
      --mechanical         (compact) Code-only compaction; no model needed
      --llm                (compact) Require the model path; fail if unavailable
  -m, --model <model>      (compact) Model for the LLM path
      --show               (compact) Print the current compact and what it covers
      --clear              (compact) Delete the compact; injection uses the full index

Compaction: `lazy memory compact` writes a separate, derived summary of the
records and injects that instead of the full index. The records are never
modified, every run regenerates from them (never from the previous compact), and
anything written since the compact is injected as its live index line — a newer
line always supersedes the summary. Over `[memory] warn_bytes` (default 4KB) every
launch warns and suggests compacting; nothing is ever truncated or blocked.

A compact that would make the injected context BIGGER is rejected and not
saved (exit 1); any existing compact stays in place. A compact carries its own
explanatory preamble, so small or already-dense stores cannot be compacted
below their plain index — curating the records is what helps there.
`--show` prints the compact plus its coverage: when it was generated, how many
records it covers, and which newer records are injected raw alongside it.

Who can write: humans (this command) and the builder (lazy_memory_save). Task
agents are READ-ONLY — memory is injected into every future session, so an
agent-writable store would be a prompt-injection channel. Agents read it with
lazy_memory_recall and lazy_search 'in:memories <text>'.

Memory vs journal: the journal (lazy journal) is a raw, per-task record read on
demand — its text is never injected, only its new-entry count; memory is curated,
cross-task knowledge that IS injected.

Examples:
  lazy memory list
  lazy memory save vm-credentials-idea -t project -d "Why VM creds are injected at boot"
  echo "Body text" | lazy memory save deploy-window -t reference -d "Deploys are Tue/Thu 10am"
  lazy memory show vm-credentials-idea
  lazy memory history vm-credentials-idea
  lazy memory rm stale-note --yes
  lazy memory compact
  lazy memory compact --mechanical
  lazy memory compact --show
  lazy search 'in:memories "credentials"'

Documentation: https://docs.getlazy.dev/memory
```
