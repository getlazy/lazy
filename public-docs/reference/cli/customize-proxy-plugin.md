# lazy customize proxy-plugin

This page is generated from `lazy customize proxy-plugin --help`.

```text
Usage: lazy customize proxy-plugin <name> [--force] [--no-prompt]

Scaffold a proxy request plugin into .lazy/plugins/.

Lazy's proxy sits on every agent's model traffic. A request plugin receives the
parsed JSON body of each outbound request and may return a replacement body.
NOTE: Repository plugins (.lazy/plugins) are not run: lazy never runs code from the repository inside its own process on the host. A scaffolded plugin is NOT
loaded; the daemon log and lazy doctor say so.

Two files are written: the plugin (a working no-op you edit) and a smoke test
encoding the contract. A guide prompt is printed afterwards for handing to an
agent. .lazy/plugins/ is not gitignored — commit them to share the
plugin with your team.

Were plugins loaded, their code would run INSIDE the lazy daemon process, on the
host, unsandboxed — which is why they are not.

Arguments:
  <name>          Plugin name: lowercase letters, digits and dashes

Options:
  -f, --force     Overwrite existing files with the same name
  --no-prompt     Scaffold only; do not print the agent guide prompt

Examples:
  lazy customize proxy-plugin strip-trailing-space
  lazy customize proxy-plugin redact-secrets --no-prompt
  bun test ./.lazy/plugins/strip-trailing-space.test.ts
```
