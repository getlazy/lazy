# lazy tag

This page is generated from `lazy tag --help`.

```text
Usage: lazy tag <task_id> <tag> [<tag>...]

Add one or more tags to a task for lightweight, non-hierarchical grouping.

Arguments:
  <task_id>    ID or code of the task to tag (can be shortened)
  <tag>        One or more tags. Normalized to lowercase alphanumerics + hyphens
               (e.g. "[Onboarding]" becomes "onboarding").

Tags let you group work into efforts (onboarding, launch, infra) without a
parent/child relationship — a task can carry multiple tags at once. Every
tag/untag is recorded in an append-only, actor-attributed history
(see `lazy show <task_id>`).

Examples:
  lazy tag abc12345 onboarding
  lazy tag abc1 launch infra
  lazy untag abc1 infra
```
