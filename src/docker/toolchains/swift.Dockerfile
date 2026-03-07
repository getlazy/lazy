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
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /work
