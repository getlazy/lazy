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
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with sudo — passes Claude Code's root check while allowing tool installs
RUN useradd --create-home --shell /bin/bash user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
ENV PATH="/home/user/.local/bin:${PATH}"

# Install Claude Code via native installer as `user` so it lands in
# /home/user/.local/bin/claude — the layout Claude Code expects for the current user.
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /work
