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
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for asset pipeline / esbuild / webpacker)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Yarn (common in Rails projects)
RUN npm install -g yarn

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash

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
