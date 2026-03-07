# Toolchain: go
# Go toolchain + common development tools.

FROM golang:1.23-bookworm

# System deps: git, curl, jq (golang image already has build-essential)
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    less \
    && rm -rf /var/lib/apt/lists/*

# Install golangci-lint
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Override GOPATH to user-writable location (base image sets GOPATH=/go owned by root)
ENV GOPATH=/home/user/go
ENV PATH="$GOPATH/bin:/home/user/.local/bin:$PATH"

WORKDIR /work
