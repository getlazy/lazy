# lazy init

This page is generated from `lazy init --help`.

```text
Usage: lazy init [--external-path PATH] [--skip-auth-check] [--skip-remote-check] [--skip-completion-check]

Initialize lazy in the current git repository.

Requires an interactive terminal to display warnings and instructions.

If a supported remote (GitHub, etc.) is detected, offers to configure it.

Options:
  --external-path PATH      Store path: absolute, ~/..., or relative to the project root.
                            Answers the storage prompt, so it also works without a TTY,
                            and rewrites storage.external_path in an existing lazy.toml.
  --skip-auth-check         Skip authentication check during init
  --skip-remote-check       Skip remote driver detection during init
  --skip-github-check       Alias for --skip-remote-check
  --skip-completion-check   Skip shell completion recommendation
```
