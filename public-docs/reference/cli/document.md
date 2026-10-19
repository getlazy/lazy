# lazy document

This page is generated from `lazy document --help`.

```text
Usage: lazy document [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a documentation task. The agent reads code and produces design documents
in markdown with mermaid diagrams. It does NOT modify code files.

Options:
  --goal <goal>      Documentation goal (what to document)
  --prompt <text>    Additional instructions for the documentation agent
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-5-5)
  --code <code>      Human-readable code (e.g. "doc-storage", "doc-architecture")
                     Lowercase alphanumeric + hyphens, 2-63 chars
  --parent <task_id> Parent task ID (creates a child task)

The documents directory is configured in lazy.toml under [documents].path.
If not configured, auto-discovers docs/ or doc/, defaulting to docs/.

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy document --goal "Document the storage interface" --code doc-storage
  lazy document --goal "Update architecture overview" --code doc-architecture
  lazy document --goal "Document the supervisor protocol" --prompt "Focus on the lifecycle"
  lazy document                              # Interactive mode
  echo "Extra instructions" | lazy document --goal "Document auth flow"
```
