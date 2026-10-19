# lazy daemon config

This page is generated from `lazy daemon config --help`.

```text
Usage: lazy daemon config <subcommand> [options]

Runtime control + visibility for the daemon's builder concurrency cap
([limits] max_concurrent_builders in lazy.toml) and the usage pause
([usage_pause] in lazy.toml). Agent tasks are uncapped — every `lazy start`
launches immediately.

Overrides set here are EPHEMERAL — they live only in the running daemon and
reset on restart (reverting to lazy.toml). This command never writes lazy.toml.
The usage_pause_threshold override is also ONE-SHOT: it is used up by the first
launch BESIDE any task (a one-shot such as lazy report, a chat, a review
conversation) that it lets past a pause, and then lazy.toml applies again.
With --task <task> it is instead that task's allowance: its next turn starts past
the pause, whichever launch that is (lazy start/unblock/resume/review/ask also
take --override-usage-pause for the same thing).

Subcommands:
  get                    Show the cap: configured value, ephemeral override,
                         effective limit, and current running count; and the
                         usage pause: thresholds, override, what is paused
  set <key> <value>      Set an ephemeral override for this daemon session
                         (usage_pause_threshold off --task <task>: let that
                         task's next turn through the pause)
  reset [key]            Clear the override, reverting to lazy.toml
                         (usage_pause_threshold --task <task>: drop that task's)

Options:
  --task <task>          (usage_pause_threshold, set/reset) act on that task's
                         allowance instead of the daemon-wide override

Keys:
  max_concurrent_builders  (alias: builders) max concurrent builder containers
  usage_pause_threshold    (alias: usage-pause) 'off' lets ONE paused turn start
                           regardless of usage; a percent is a threshold for
                           that one turn (100 still pauses at a full or refused
                           window). Only from your own terminal: it is refused
                           without one, inside a container, and from an agent.
                           With --task, a person or the builder may set it;
                           a task agent never

Examples:
  lazy daemon config get                            # Show current limit + usage
  lazy daemon config set builders 4                 # Lower the builder cap to 4
  lazy daemon config set usage_pause_threshold off  # Let one paused one-shot start
  lazy daemon config set usage_pause_threshold off --task abc1  # Let abc1's next turn start
  lazy daemon config reset                          # Clear the overrides
```
