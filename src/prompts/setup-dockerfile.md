Read the existing Dockerfile in the project root. Create a new file called
Dockerfile.lazy that:

1. Starts FROM the same base image as the original Dockerfile
2. Includes all the original Dockerfile's layers and setup
3. Adds a layer that installs the {{agentName}} CLI: `{{agentInstall}}`
4. Sets WORKDIR to /work

Alternatively, if the project does not need a specific base image, Dockerfile.lazy
can `FROM lazy-runner` to inherit the base runner image (Debian bookworm-slim with
git, curl, jq, sudo, Chromium and the Claude Code CLI, and no language runtimes —
add node, bun, python or whatever the project needs; lazy runs Claude Code inside
the container for its own merge turns regardless of which agent your tasks use).
lazy-runner is built locally (it is on no registry); lazy builds it first when
it is missing. When inheriting from lazy-runner you still need the layer from step 3 unless {{agentName}} is Claude Code.

No lazy.toml change is needed: when `[docker].dockerfile` is unset, lazy uses a
`Dockerfile.lazy` in the project root automatically. (If lazy.toml already names
a different Dockerfile, that setting wins — point it at Dockerfile.lazy.)

Make sure the resulting image would work for running {{agentName}} agents — it
needs git, the project's dependencies, and the {{agentName}} CLI on PATH for the
non-root `user` account the container runs as.

Run `lazy system export-dockerfile --stdout` to see lazy's own default image
definition for reference on what the agent container needs.
