# Toolchain: python
# Python 3 + pip + venv + common native build dependencies.

FROM python:3.12-slim-bookworm

# System deps: git, curl, jq, and native build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    build-essential \
    pkg-config \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code agent via Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
