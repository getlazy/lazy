# lazy system

This page is generated from `lazy system --help`.

```text
Usage: lazy system <subcommand>

Inspect and prebuild Lazy system internals, and toggle project-wide modes.

Subcommands:
  prompts            List built-in system prompt templates
  build <name>       Prebuild a lazy system image (bypasses lazy.toml)
  runner-image       The project's runner image the daemon builds at start: status, log, rebuild, cancel
  machine            What the project's machine is doing: services, logs, CPU, memory, disk
  status             Show current system state (offline/online, driver, daemon, storage)
  source-id          Print the content identity of this lazy source tree
  guest-init-script  Write out the daemon image's guest preparation script this lazy carries
  agent              Show agent readiness, switch the default agent, or set an agent API key
  passphrase         Enroll, inspect, or delete this machine's approval passphrase
  offline            Enable offline mode (skip all remote operations)
  online             Disable offline mode (restore remote operations)
  export-dockerfile  Write the embedded default Dockerfile to disk for customization
  repair-commits     Fix recorded commit lists that name commits a task never made
  store-check <path> Report what a store directory holds, without opening it
  store-rehome       Transfer a stopped project's store to this checkout
  store-backup       Copy and verify the store into <store>.backups/ (taken before every upgrade)
  store-backups      List the store's backups
  store-restore <b>  Put a backup back (daemon stopped; the current store is moved aside)

System prompts use the 'lazy-prompt-' prefix (e.g. lazy-prompt-system-instructions).
View any with: lazy show <code>

Examples:
  lazy system prompts                             # List all built-in system prompts
  lazy system status                              # Show current system state
  lazy system source-id                           # Which lazy code is this?
  lazy system agent set cursor                    # Switch the default agent to Cursor
  lazy system agent set-key cursor                # Store the Cursor API key (masked prompt)
  lazy system passphrase set                      # Enroll the approval passphrase (masked prompt)
  lazy system passphrase                          # Is one enrolled on this machine?
  lazy system build lazy-runner                   # Prebuild the base runner image
  lazy system runner-image                        # Is the project's runner image ready?
  lazy system runner-image log --follow           # Watch its build, step by step
  lazy system machine --logs                      # Services, their logs, resource use
  lazy system offline                             # Skip all remote operations
  lazy system online                              # Restore remote operations
  lazy system export-dockerfile                   # Write Dockerfile.lazy for customization
  lazy system repair-commits --all                # Which commit lists are wrong?
  lazy system store-check ~/.lazy/my-project      # Is this store safe to hand over?
  lazy system store-backups                       # Which pre-upgrade backups exist?
  lazy show lazy-prompt-system-instructions       # View a specific system prompt
```
