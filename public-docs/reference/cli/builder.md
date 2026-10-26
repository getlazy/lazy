# lazy builder

This page is generated from `lazy builder --help`.

```text
Usage: lazy builder [list | attach [<id>] | stop [<id>] | end [<id>]] [--resume <id> [--import]] [--no-autonomous] [--yes]
                    [--effort <level>] [--model <id>] [--override-usage-pause]

Launch an interactive Claude Code session with Lazy builder instructions.

--override-usage-pause starts this builder session even when its credential is paused.

This starts Claude Code with the Lazy system prompt injected via --append-system-prompt.
Your CLAUDE.md and AGENTS.md are untouched — Lazy's orchestration instructions are appended to the system
prompt, not written to any file.

The host's ~/.claude/ directory is shared with the container, so Claude Code settings,
credentials, and conversation history are available. Conversations are captured
into lazy's store so they're searchable alongside task data.

Subcommands:
  list, ls             List captured builder conversations

In a clone logged in to Lazy Teams:
  Your builders run on the server; 'lazy builder' starts another one and
  attaches this terminal to it (you may run several at once). ctrl-] detaches
  and leaves it running.
  attach [<id>]        Reattach to one of yours (relaunching it if stopped)
  stop [<id>]          Stop one, keeping its conversation to resume
  end [<id>]           End one for good
  With several builders, attach/stop/end name the session id.

Resume options:
  --resume <id>        Resume a specific session by Claude session ID
  --import             Adopt a session that has never run under lazy's builder
                       isolation (use with --resume <id>; without it such a
                       resume errors instead of adopting silently)

When a builder session exits, the session ID is printed so you can resume it
with --resume <id>. Use 'lazy builder list' to look up an earlier session ID.

The interactive system prompt warning is automatically skipped when resuming.

Autonomous by default:
  The builder runs without permission prompts unless you pass --no-autonomous.
  It is an orchestrator, not a task agent: under Docker/Podman it runs in a
  container with your repository mounted READ-ONLY — less filesystem access than
  the task agents it directs — and every task operation goes through the daemon.
  Each autonomous launch prints that posture and asks you to type 'yes'; --yes
  skips the prompt (and is required in non-TTY mode).

Auto-resume across upgrade (docker/podman only):
  If 'lazy upgrade' stops this builder to rebuild the image, the session is
  automatically relaunched in place — same conversation, same terminal — once
  the upgrade finishes; no manual --resume needed. The wait has
  no time limit — progress lines print every ~15s, and ctrl-c cancels the wait
  while preserving your session (resume with --resume when ready). Finish typing
  any in-progress message before upgrading: unsent input cannot be recovered.
  If the relaunch can't complete, the command prints the exact
  'lazy builder --resume <id>' to run.

Flags:
  --autonomous         Run without permission prompts. This is the DEFAULT — the flag
                       is accepted so existing scripts keep working, but it changes
                       nothing. The builder runs in a container, which is what
                       confines it.
  --no-autonomous      Opt out: run with Claude Code's normal permission prompts.
  --yes                Auto-confirm prompts, including the autonomous-posture
                       confirmation (required for autonomous runs in non-TTY mode —
                       pass --no-autonomous instead to run with prompts)
  --effort <level>     Claude Code reasoning effort (low, medium, high, xhigh, max)
                       Defaults to lazy.toml [builder].effort (default "high")
  --model <id>         Override the model the builder itself runs as (passed
                       straight through to Claude Code's --model; no allow-list,
                       so brand-new models work). Takes precedence over the
                       Ollama-injected model. This is the BUILDER's model, not
                       the per-task --model used when starting tasks.

Examples:
  lazy builder                    # Start new session
  lazy builder --resume <uuid>    # Resume a specific session
  lazy builder list               # List captured conversations
  lazy builder --no-autonomous    # Run with permission prompts instead
  lazy builder --model mythos     # Run the builder on a specific model
```
