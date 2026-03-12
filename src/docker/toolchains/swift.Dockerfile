# Toolchain: swift
# Swift toolchain for server-side Swift development on Linux.

FROM swift:6.0-bookworm-slim

# System deps: git, curl, jq, and basic dev utilities
# (Swift image already includes build-essential and related tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    pkg-config \
    libsqlite3-dev \
    libssl-dev \
    sudo \
    && rm -rf /var/lib/apt/lists/*

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
