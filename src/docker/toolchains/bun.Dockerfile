# Toolchain: bun
# Bun runtime + toolchain for JavaScript/TypeScript development.

FROM oven/bun:slim

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code agent
# bun install -g puts packages in /root/.bun/ and symlinks binaries to /usr/local/bin/.
# The symlinks point into /root/ which is 700 by default, so open /root for traversal.
RUN bun install -g @anthropic-ai/claude-code@latest \
    && chmod o+x /root \
    && chmod -R o+rX /root/.bun

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
