# Toolchain: go
# Go toolchain + common development tools.

FROM golang:1.23-bookworm

# System deps: git, curl, jq (golang image already has build-essential)
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    less \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install golangci-lint
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Override GOPATH (base image sets GOPATH=/go owned by root)
ENV GOPATH=/root/go
ENV PATH="$GOPATH/bin:$PATH"

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
