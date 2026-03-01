# Toolchain: base
# Minimal dev container with git, curl, and common utilities.
# Used as the fallback when no specific toolchain is detected.

FROM debian:bookworm-slim

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    gnupg \
    less \
    openssh-client \
    unzip \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code agent via Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
