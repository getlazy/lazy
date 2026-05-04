Read the existing Dockerfile in the project root. Create a new file called
Dockerfile.lazy that:

1. Starts FROM the same base image as the original Dockerfile
2. Includes all the original Dockerfile's layers and setup
3. Adds a layer that installs Claude Code: `bun install -g @anthropic-ai/claude-code@latest`
4. Sets WORKDIR to /work

Alternatively, if the project does not need a specific base image, Dockerfile.lazy
can `FROM lazy-runner` to inherit the base runner image (which already includes
git, bun, node, and claude-code). Users building the project on a fresh machine
must first run `lazy system build lazy-runner` to prebuild that base image.

Then update lazy.toml to set:
```toml
[docker]
dockerfile = "Dockerfile.lazy"
```

Make sure the resulting image would work for running Claude Code agents — it needs
git, the project's dependencies, and claude-code installed globally via bun.

Study the default Dockerfile embedded in src/capture/claude.ts for reference on what
the agent container needs.
