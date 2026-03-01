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

# Install Claude Code agent
RUN npm install -g @anthropic-ai/claude-code@latest

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
