# lazy create

This page is generated from `lazy create --help`.

```text
Usage: lazy create [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--agent <profile>] [--effort <level>] [--runner <docker|container|podman>] [--review <mode>] [--review-gate <gate>] [--review-auto-fix <on|off>] [--tag <tag>]

Create a new task. Interactive if no flags provided.

Options:
  --goal <goal>      Task goal
  --prompt <text>    Task prompt/specification
  --model <model>    Set model for this task (e.g. opus, sonnet, claude-opus-5-5)
  --type <type>      Set task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release, cluster)
                     Default: task
                     cluster: the task's own agent drives its subtasks instead of
                     doing the work — it decides how many run at once, reviews
                     each one and accepts it into the cluster's branch.
  --code <code>      Human-readable code (e.g. "fix-models", "add-auth")
                     Lowercase alphanumeric + hyphens, 2-63 chars
  --parent <ref>     Parent: a task code/short-ID (creates a child task) or a
                     raw branch name (top-level task targeting that branch).
                     Parent task must not be in a terminal state.
                     Without --parent, the task targets the repo's default
                     integration branch (origin/HEAD → main fallback). The
                     branch the user currently has checked out is NEVER
                     adopted silently — pass it explicitly if you want it.
  --agent <profile>  Agent profile to run this task with — an [agents.<name>] block in
                     lazy.toml (harness + model + endpoint + credential). The harness
                     names (claude-code, codex, cursor, pi) are the built-in profiles.
                     See them with lazy system agent. Default: from lazy.toml.
  --effort <level>   Claude Code reasoning effort for this task (low, medium, high, xhigh, max)
                     Persists across resumes. Default: from lazy.toml [agent].effort (medium)
                     An effort you set here is respected in low-high review
                     mode: the draft runs at it, not at [review] draft_effort.
                     A project-wide [agent] effort does not do that — only a
                     choice about this task.
  --runner <type>    Run this task on a specific runner regardless of the global
                     [runner] type: docker, container, or podman.
                     Default: inherit lazy.toml [runner] type.
  --review <mode>    How this task gets reviewed once it declares final:
                       low-high  (default) the writer self-reviews in its own
                                 session — a low-effort draft, a high-effort
                                 hostile self-review, one revise pass
                       separate  a reviewer runs afterwards in its own session
                                 and its verdict gates accept: 3-4x the
                                 wall-clock and tokens, for when it is worth it
                       off       no review at all
  --review-gate <g>  When a recorded review holds the merge: auto (default —
                     the mode decides, and a review you asked for with
                     'lazy review' always gates), always (any recorded review
                     gates, the low-high self-review included), or never.
  --review-auto-fix <on|off>
                     In 'separate' mode, whether a review that found something
                     starts a fix turn by itself. Default off: the task parks
                     with its findings and you decide whether a round is worth
                     it.
                     All three persist on the task and take effect next turn.
                     Omit any of them to inherit the parent task's value, or
                     the lazy.toml [review] default for a top-level task.
  --tag <tag>        Add a tag for grouping (repeatable). Normalized to lowercase
                     alphanumerics + hyphens. E.g. --tag onboarding --tag launch

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy create                              # Interactive mode
  lazy create --goal "Add auth"            # Create with goal only
  lazy create --goal "Add auth" --code add-auth
  lazy create --goal "Add auth" --tag onboarding --tag launch
  lazy create --goal "Add auth" --prompt "Implement OAuth2 login"
  lazy create --goal "Refactor" --model opus --type refactor
  lazy create --goal "Sub-task" --parent abc12345
  lazy create --goal "Fix bug" --agent claude-code
  echo "Detailed prompt" | lazy create --goal "Add auth"  # Piped stdin as prompt
```
