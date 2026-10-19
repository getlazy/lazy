# lazy branch

This page is generated from `lazy branch --help`.

```text
Usage: lazy branch <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--yes]

Create a child task branching from a parent task's current state and start it
immediately. The child task will have its git branch starting from the parent's
current HEAD.

Arguments:
  <task_id>          ID of parent task to branch from

Options:
  --goal <goal>      Goal for the variant (default: parent goal + "(variant)")
  --prompt <text>    Prompt for the variant (default: inherit parent's prompt)
  --model <model>    Override model for the variant (e.g. opus, sonnet, claude-opus-5-5)
  --code <code>      Set a human-readable code for the variant task
  --yes              Skip confirmation prompt when starting the variant task

Interactive Mode:
  - Without flags, requires an interactive terminal (TTY)
  - Prompts for goal and allows editing prompt in $EDITOR
  - For non-interactive use, provide --goal and/or --prompt flags

Examples:
  lazy branch abc123                                    # Interactive mode (requires TTY)
  lazy branch abc123 --goal "Try Redis instead"        # Custom goal (non-interactive)
  lazy branch abc123 --code try-redis                  # With a code
  lazy branch abc123 --prompt "Use async approach"     # Custom prompt (non-interactive)

After branching:
  lazy accept <child_task_id>   # Merge variant back into parent
  lazy reject <child_task_id>   # Discard variant
```
