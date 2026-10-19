# lazy completion

This page is generated from `lazy completion --help`.

```text
Usage: lazy completion --bash | --zsh

Output shell completion script to stdout.

Options:
  --bash    Output bash completion script
  --zsh     Output zsh completion script

Setup:
  # Bash: add to ~/.bashrc
  eval "$(lazy completion --bash)"

  # Zsh: add to ~/.zshrc
  eval "$(lazy completion --zsh)"

Completions include:
  - Command names (lazy <TAB>)
  - Subcommands (lazy system/daemon/config/memory/stats <TAB>)
  - Task IDs for commands that accept them (lazy show <TAB>)
  - Flags for each command (lazy list --<TAB>)
```
