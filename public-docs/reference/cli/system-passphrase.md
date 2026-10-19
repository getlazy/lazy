# lazy system passphrase

This page is generated from `lazy system passphrase --help`.

```text
Usage: lazy system passphrase [status|set|delete]

Manage the approval passphrase that `lazy accept` asks for when a merge
crosses a protected branch or task.

The passphrase is stored HASHED at ~/.lazy/passphrase.json
(mode 0600), outside every repository, and covers every lazy project on this
machine — enroll it once. It is never stored in the clear and cannot be
recovered; a forgotten passphrase is re-enrolled, not recovered.

Subcommands:
  status (default)  Whether a passphrase is enrolled, where the store lives,
                    and when it was last set. Never reveals or hints at the
                    value itself.
  set               Enroll or rotate. Typed twice at a masked prompt; rotating
                    first asks for the current passphrase.
  delete            Un-enroll (also requires the current passphrase). Protected
                    merges then fail closed until you enroll again.

Forgot it? There is no recovery — the store holds a hash, not the passphrase.
Both `set` (rotation) and `delete` ask for the current one, so the way back is
to remove the store yourself and enroll again:

  rm ~/.lazy/passphrase.json
  lazy system passphrase set

That is a local file only you can write; it resets the passphrase, nothing else.

Interactive terminal ONLY: there is deliberately no flag, environment
variable, or piped-stdin form, and the command refuses to run inside a
container. A passphrase supplied non-interactively lands in shell history, CI
config, or an agent transcript — this credential exists to show a human typed
it. For the same reason there is no MCP tool and no daemon RPC: enrollment
happens in this process, on the host, while verification stays daemon-side.

Examples:
  lazy system passphrase              # is anything enrolled on this machine?
  lazy system passphrase set          # enroll, or rotate an existing one
  lazy system passphrase delete       # un-enroll
```
