# The agent container

Every task's agent runs in a Docker container of its own. This page is for anyone
whose agents need tools the default image does not have, or who is diagnosing an
agent that cannot start: what the default image contains, how to give your
project its own image, and when lazy rebuilds it.

## The default image

A project with no `[docker] dockerfile` in its `lazy.toml` runs agents in lazy's
default image, `lazy-runner`, which is deliberately minimal. It is Debian
(bookworm-slim) with:

| Package | Why |
| --- | --- |
| `git`, `curl`, `jq`, `wget`, `unzip`, `less`, `openssh-client`, `gnupg`, `sudo` | Basic tools |
| Chromium (`$CHROME_BIN`) | Screenshots for visual checks of UI work |
| Claude Code | The agent binary |

The agent runs as `user`, with passwordless `sudo`, so it can install what it
needs for one task. Agents other than Claude Code get their own variant of this
image with their binary added. Lazy itself is never baked into an image: it is
mounted in when the container starts, so an image never pins you to an older
lazy.

To see exactly what the default image is built from:

```bash
lazy system export-dockerfile --stdout
```

## Giving your project its own image

When agents keep installing the same toolchain (a language runtime, a database
client, your project's dependencies), build it into an image instead. Write a
Dockerfile, usually starting from the default image, and point `lazy.toml` at
it:

```dockerfile
FROM lazy-runner
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends postgresql-client
```

```toml
[docker]
dockerfile = "Dockerfile.lazy"
```

The path is relative to the project root. If `FROM lazy-runner` names a base
image that is not built yet, lazy builds it first. The build is done by the
daemon on your machine, from the project root's copy of the file; an agent
editing the Dockerfile on its task branch does not change the image your tasks
run in. All `[docker]` settings, including `build_inputs` (rebuild when a
lockfile changes), are in [lazy.toml](lazy-toml.md#docker).

If your task containers need to be *created* with extra Docker flags (for
example `--cap-add=SYS_PTRACE`), that is `[docker] run_args` — a container
setting, not an image one, so no Dockerfile change can provide it.

### Scripts that call `node`

`bun install` writes `node_modules/.bin/*` shims that start with
`#!/usr/bin/env node`. If your image has no `node` (the default image has none),
any `package.json` script that runs a dependency's CLI by name — `tsc --noEmit`,
`eslint .` — fails with **exit 127** before the tool runs. Either install node
in your image, or run the tool's entry module through bun:

```json
"typecheck": "bun node_modules/typescript/lib/tsc.js --noEmit"
```

Watch for this in `[checks] post_turn`: a check whose scripts all exit 127
checks nothing.

## The headless browser

Agents find the browser through `$CHROME_BIN` (and `chromium` on `PATH`). If you
build your own image from something other than `lazy-runner`, set `CHROME_BIN`
too, so agents do not try to install a browser in every task. Rendering an HTML
file to an image is one command:

```
"$CHROME_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1280,1600 --screenshot=/tmp/shot.png file:///tmp/page.html
```

Chromium logs D-Bus and GPU warnings on every run in a container; they are noise,
not failure. The exit code and a non-empty output file are the signals.

## Rebuilding

Lazy names a custom image after the content of its Dockerfile
(`lazy-custom-<hash>`), so editing the Dockerfile in the project root rebuilds
it on the next task launch — no manual step.

A Dockerfile's text says nothing about what it *pulls*: the same file builds a
different image a month later. So lazy also rebuilds on two schedules:

- **`lazy upgrade` always rebuilds**, from scratch.
- **After 14 days**, the next task launch rebuilds an older image once, without
  the build cache.

The image *tag* is lazy's major.minor version (for example
`lazy-custom-<hash>:0.22`); it is an identity, not a freshness signal.
`lazy doctor` lists older images left behind. What happens during a rebuild, and
how to watch it, is in [Image rebuilds on upgrade](upgrade-image-rebuild.md).

## When an agent cannot start

`lazy doctor` checks the container runtime, the image and the agent binary, and
says what to fix. The most common causes:

- **Docker is not running.** Start Docker Desktop (or your Docker daemon) and
  retry.
- **The image failed to build.** The build output names the failing step; fix
  your Dockerfile and launch again. `lazy system build` rebuilds on demand.
- **Lazy's agent binary is not the compiled one.** Lazy mounts its own
  `lazy-agent` binary into every container; if that file is missing or is not a
  built lazy agent, the agent starts with no `lazy_*` tools. Reinstall lazy,
  then run `lazy upgrade`.

See also [Troubleshooting](troubleshooting.md).
