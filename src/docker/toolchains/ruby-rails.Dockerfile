# Toolchain: ruby-rails
# Ruby + Rails deps + Bundler + Node.js (asset pipeline) + PostgreSQL client + Redis client.
# PRIORITY toolchain — used on the user's day job.

FROM ruby:3.3-slim-bookworm

# System deps: git, curl, jq, build essentials, and Rails-specific deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    build-essential \
    pkg-config \
    libpq-dev \
    libsqlite3-dev \
    libvips-dev \
    libyaml-dev \
    libffi-dev \
    libreadline-dev \
    zlib1g-dev \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for asset pipeline / esbuild / webpacker)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Yarn (common in Rails projects)
RUN npm install -g yarn

# Install Claude Code agent
RUN npm install -g @anthropic-ai/claude-code@latest

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
