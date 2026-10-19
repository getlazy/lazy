# lazy refactor

This page is generated from `lazy refactor --help`.

```text
Usage: lazy refactor [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a refactoring task. The agent restructures code without changing behavior.
Enforces: no behavior changes, one step per commit, tests pass after each step.

Options:
  --goal <goal>      Refactoring goal (what to refactor and why)
  --prompt <text>    Additional instructions for the refactoring agent
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-5-5)
  --code <code>      Human-readable code (e.g. "refactor-auth", "refactor-storage")
                     Lowercase alphanumeric + hyphens, 2-63 chars
  --parent <task_id> Parent task ID (creates a child task)

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy refactor --goal "Extract storage interface from FileStorage" --code refactor-storage
  lazy refactor --goal "Reduce cyclomatic complexity in start.ts"
  lazy refactor --goal "Rename TaskStatus to WorkflowStatus" --prompt "Update all references"
  lazy refactor                              # Interactive mode
  echo "Focus on the auth module" | lazy refactor --goal "Split auth into separate modules"
```
