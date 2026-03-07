# Toolchain: node
# Node.js LTS + npm + common native build dependencies (node-gyp, python3, make, gcc).

FROM node:22-slim

# System deps: git, curl, jq, and native build tools for node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /work
