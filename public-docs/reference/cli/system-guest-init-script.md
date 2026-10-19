# lazy system guest-init-script

This page is generated from `lazy system guest-init-script --help`.

```text
Usage: lazy system guest-init-script [options]

Write the lazy-guest-init script this lazy carries to the run directory and
print its path. The lazy daemon image runs it through a shim, so the guest's
preparation script is upgraded together with the lazy binary.

Options:
  --id               Print the script's id (16 hex of its sha256) and write nothing
  --run-dir <path>   Where to write it (default: $LAZY_GUEST_RUN_DIR, else /run)

Examples:
  lazy system guest-init-script               # /run/lazy-guest-init.<id>
  lazy system guest-init-script --id          # Which script does this lazy carry?
```
