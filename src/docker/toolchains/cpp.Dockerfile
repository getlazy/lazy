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

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /work
