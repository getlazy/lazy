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

# Install Claude Code agent via Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

# Override GOPATH to user-writable location (base image sets GOPATH=/go owned by root)
ENV GOPATH=/home/user/go
ENV PATH="$GOPATH/bin:$PATH"

WORKDIR /work
