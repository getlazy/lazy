# lazy config

This page is generated from `lazy config --help`.

```text
Usage: lazy config <set|get> <key> [value] [options]

Runtime configuration toggles for lazy.

Subcommands:
  set <key> <value>    Set a runtime config value
  get <key>            Get current value of a runtime config key

Available keys:
  auto_react           Auto-triggered agent turns (on/off)
  offline              Offline mode — skip all remote operations (on/off, global)

Options:
  --task <id>          Apply to a specific task instead of globally
  --reason <text>      Reason for the change (used with set)

Runtime toggles control on/off behavior at runtime. Budget sizes and other
static config remain in lazy.toml.

Per-task "set auto_react on" also resets all auto-react counters (trigger
counts, consecutive auto-turn count, and backoff timers) for the task.

Examples:
  lazy config set auto_react off                        # Pause all auto-reacts globally
  lazy config set auto_react off --task abc1            # Pause auto-react for task abc1
  lazy config set auto_react off --reason "investigating"  # Pause with a reason
  lazy config set auto_react on                         # Resume globally
  lazy config set auto_react on --task abc1             # Resume task abc1 (resets counters)
  lazy config get auto_react                            # Show global status
  lazy config get auto_react --task abc1                # Show global + task status
  lazy config set offline on                            # Enable offline mode
  lazy config set offline off                           # Disable offline mode
  lazy config get offline                               # Show offline status
```
