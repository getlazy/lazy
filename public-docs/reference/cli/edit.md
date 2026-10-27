# lazy edit

This page is generated from `lazy edit --help`.

```text
Usage: lazy edit <task_id> [--goal <goal>] [--prompt <text>] [--model <model>] [--type <type>] [--code <code>] [--parent <task_id>] [--runner <docker|container|podman>] [--effort <level>] [--agent <profile>] [--review <mode>] [--review-gate <g>] [--review-auto-fix <on|off>] [--token-cap <count>]

Edit a task's goal, prompt, model, type, code, parent, runner, effort, agent, or review mode. Interactive if no flags provided.
Once an agent has worked on the task, only --model, --effort, --runner, --agent and the
--review* flags can still be changed; goal/prompt/type/parent edits are rejected. --code (refused when another live task already uses it) can still be
changed on its own: the rename is cosmetic — the task's branch, worktree, container and any PR/MR keep
their old names, while lookups, dashboard links and service hostnames use the new code. The --runner, --agent and
--review overrides take effect on the next turn.
Linked tasks that haven't been agent-started are still fully editable.
Use 'lazy comment' to add annotations to started tasks.

Arguments:
  <task_id>          ID of the task to edit

Options:
  --goal <goal>      New goal
  --prompt <text>    New prompt
  --model <model>    Change model (e.g. opus, sonnet, claude-opus-5-5)
  --type <type>      Change task type (task, fix, spike, refactor, test, audit, migrate, document, tidy, rework, feature, release, cluster)
                     Warning: changing type after prompt is set may lead to mismatched expectations
  --code <code>      Set or change the task code (pass "" to clear)
  --parent <task_id> Set or change parent task (pass "" to clear)
                     Parent must exist and not be in a terminal state
  --runner <type>    Set the runner for this task: docker, container, or
                     podman (pass "" to clear and inherit the global [runner]
                     type). Allowed any time; takes effect next turn.
  --effort <level>   Change Claude Code reasoning effort for the next turn:
                     low, medium, high, xhigh, max. Allowed any time; takes
                     effect next turn. Respected in low-high review mode — the
                     draft runs at it rather than at [review] draft_effort.
  --review <mode>    Change how this task gets reviewed at its next final:
                     low-high (the writer self-reviews in its own session),
                     separate (a reviewer runs afterwards and gates accept), or
                     off. Allowed any time; takes effect next turn — which is
                     how you pull a task out of a reviewer cycle that is costing
                     more than it is finding.
  --review-gate <g>  Change when a recorded review holds the merge: auto (the
                     mode decides), always, or never. Allowed any time.
  --token-cap <count>
                     The task's own token cap, e.g. 50M, 200k or 50000000; "none"
                     clears it. Allowed any time. Once the task has spent that
                     many tokens its running turn is stopped (work kept) and it
                     does not continue until the cap is raised or cleared.
  --review-auto-fix <on|off>
                     Change whether a 'separate' review that found something
                     starts a fix turn by itself. Allowed any time.
                     Each of the three is independent: setting one leaves the
                     others inherited from the parent task, or the project.
  --agent <profile>  Switch to a different agent profile — an [agents.<name>] block in
                     lazy.toml; harness names (claude-code, codex, cursor, pi) are the
                     built-in profiles.
                     Refused while the task is working (a turn is in flight);
                     wait for it to block or run lazy stop first. Otherwise
                     allowed any time; takes effect next turn. When switching
                     agents mid-task, the session is reset (cannot resume across
                     agents), and model/effort are re-resolved for the new agent
                     unless you also pass --model / --effort on the same command.
                     The task's conversation history is preserved and accessible
                     via lazy tools.

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy edit abc123                           # Interactive mode
  lazy edit abc123 --goal "New goal"
  lazy edit abc123 --prompt "Updated spec"
  lazy edit abc123 --model opus
  lazy edit abc123 --effort medium           # Dial the next turn down from max
  lazy edit abc123 --type refactor           # Change to refactor task
  lazy edit abc123 --code fix-auth
  lazy edit abc123 --code ""                 # Clear the code
  lazy edit abc123 --parent def45678         # Set parent task
  lazy edit abc123 --parent ""               # Clear parent (reparent to main)
  lazy edit abc123 --agent cursor            # Switch to Cursor agent
  echo "New prompt text" | lazy edit abc123  # Piped stdin as prompt
```
