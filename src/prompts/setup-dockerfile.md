Read the existing Dockerfile in the project root. Create a new file called
Dockerfile.lazy that:

1. Starts FROM the same base image as the original Dockerfile
2. Includes all the original Dockerfile's layers and setup
3. Adds a layer that installs the {{agentName}} CLI: `{{agentInstall}}`
4. Sets WORKDIR to /work

Alternatively, if the project does not need a specific base image, Dockerfile.lazy
can `FROM lazy-runner` to inherit the base runner image (which already includes
git, bun, node, and the Claude Code CLI — lazy runs Claude Code inside the
container for its own merge turns regardless of which agent your tasks use). Users
building the project on a fresh machine must first run `lazy system build
lazy-runner` to prebuild that base image. When inheriting from lazy-runner you
still need the layer from step 3 unless {{agentName}} is Claude Code.

Then update lazy.toml to set:
```toml
[docker]
dockerfile = "Dockerfile.lazy"
```

Make sure the resulting image would work for running {{agentName}} agents — it
needs git, the project's dependencies, and the {{agentName}} CLI on PATH for the
non-root `user` account the container runs as.

Run `lazy system export-dockerfile --stdout` to see lazy's own default image
definition for reference on what the agent container needs.
