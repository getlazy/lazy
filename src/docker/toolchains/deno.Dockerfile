# Toolchain: deno
# Deno runtime for JavaScript/TypeScript development.

FROM debian:bookworm-slim

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    unzip \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Make Claude available system-wide (for non-root builder sessions)
RUN cp /root/.local/bin/claude /usr/local/bin/claude
# Remove native install artifacts so Claude Code doesn't detect a stale native install
RUN rm -rf /root/.local/bin/claude
# Non-root user with sudo — passes Claude Code's root check while allowing tool installs
RUN useradd -m -s /bin/bash user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

WORKDIR /work
