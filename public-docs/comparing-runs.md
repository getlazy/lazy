# Comparing runs: `lazy clone --same-base`

To find out how another agent or model handles the same work, re-run a task on
exactly the code the original saw:

```bash
lazy clone fix-auth --same-base --agent cursor --model gpt-5
lazy start fix-auth-clone-1
```

The clone gets the source task's goal, current prompt and type, and the same
parent. It works for any task, finished ones included.

## What `--same-base` does

- **The branch starts from the source task's starting commit.** That is the
  commit the source task's branch was created from when it was first started,
  before any of its turns ran. It is *not* the parent branch's current head, so
  work that landed on the parent since then is not in the clone.
- **The clone is pinned there.** Nothing merges the parent in automatically: no
  sync after another task is accepted, no retry of a queued sync, no merge before
  a resumed turn, and the task's own agent cannot sync it either. Otherwise a
  single silent merge would quietly spoil the comparison.
- **`lazy sync <clone>` lifts the pin.** Run by you (or the builder), sync merges
  the parent in as usual, and from then on the clone is an ordinary task.
- **Accepting works as usual.** A pinned clone is merged into its parent like any
  other task.

Anywhere a task's upstream status is shown (`lazy show`, the dashboard's task
header), a pinned task reads like
`pinned to 1a2b3c4d5e6f, 7 behind main (no automatic sync; lazy sync lifts the pin)`.

## Options

| Option | Effect |
| --- | --- |
| `--same-base` | Branch from the source task's starting commit and pin the clone there. |
| `--base <sha>` | The same, but pinned to a commit you name (any SHA or ref git resolves). |
| `--agent <profile>` | Run the clone on another agent profile. Default: the source's. |
| `--model <model>` | Run the clone on another model. Default: the source's model, or the new agent's default model when `--agent` names a different agent. |

The agent and model are stored on the clone, so every later turn keeps them. Model names are not portable between agents, so switching `--agent` without `--model` never carries the source's model over.

The dashboard's and Lazy Teams' **Clone** / **Make a copy** action offers the
same choices: agent, model, and a "Same base" checkbox. Over MCP, `lazy_clone`
takes `same_base`, `base` and `agent`; with `same_base` or `base` it creates the
same kind of sibling clone `lazy clone` does.

## When the starting commit is gone

An old task's starting commit may only have been reachable from a branch that
has since been deleted. If git has already removed it, the clone is refused with
a message saying so and nothing is created. Fetch the commit from a remote that
still has it and try again, or clone without a pinned base.

Once the clone exists, its own branch keeps the commit alive: the branch is
created at the pinned commit by `lazy clone` itself, and `lazy start` works on
it. Closing a clone that was never started leaves that branch in place.
