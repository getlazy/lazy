FROM oven/bun:slim

RUN apt-get update && apt-get install -y git jq && rm -rf /var/lib/apt/lists/*

# bun install -g puts packages in /root/.bun/ and symlinks binaries to /usr/local/bin/.
# The symlinks point into /root/ which is 700 by default, so the non-root user can't
# follow them. Open /root for traversal so the "user" account can run claude.
RUN bun install -g @anthropic-ai/claude-code@latest && chmod o+x /root && chmod -R o+rX /root/.bun

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
