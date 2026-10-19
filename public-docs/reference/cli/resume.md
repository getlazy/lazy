# lazy resume

This page is generated from `lazy resume --help`.

```text
Usage: lazy resume <task_id> [--model <model>] [--effort <level>] [--override-usage-pause] [--default-image] [--yes] [--follow]

Resume a task with NO new feedback — writes a command for the supervisor and
launches a container if needed. To send guidance instead, use
'lazy unblock <task_id> --message "..."'.

Tasks become 'interrupted' when:
  - The Docker container crashes or is killed
  - The machine goes down while an agent is running
  - Network connectivity is lost during execution

Also resumes a 'blocked' or 'conflict' task exactly as it left off, with no new
context — the agent picks up where its last turn ended. A protected-file
decision still pending does not block a resume: nothing reverts a file, and the
decision is made at 'lazy accept'.

Arguments:
  <task_id>    ID of the task to resume

Options:
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-5-5)
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
  --follow           Wait for the agent to finish, streaming output in real time
  --override-usage-pause  Let this task's next turn start even though its credential is past the
                       usage-pause threshold (used up by that one turn)
  --default-image    While the project's runner image is still building (or failed), run on
                     lazy's default runner image instead of being asked (--yes does too)

Examples:
  lazy resume abc12345
  lazy resume abc1 --model opus
  lazy resume abc1 --follow              # Wait for completion
```
