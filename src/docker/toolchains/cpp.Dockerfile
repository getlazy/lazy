# Toolchain: cpp
# GCC + Clang + CMake + make + common build essentials for C/C++ development.

FROM debian:bookworm-slim

# System deps: git, curl, jq, and C/C++ build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    build-essential \
    clang \
    cmake \
    ninja-build \
    pkg-config \
    gdb \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code agent via Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
