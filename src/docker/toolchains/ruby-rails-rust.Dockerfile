# Toolchain: ruby-rails-rust
# Everything in ruby-rails PLUS Rust toolchain.
# For projects with a Ruby frontend and Rust backend/extensions.
# PRIORITY toolchain — this is the user's exact day-job stack.

FROM ruby:3.3-slim-bookworm

# System deps: git, curl, jq, build essentials, Rails deps, and Rust build deps
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
    libssl-dev \
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

# Install Rust via rustup to shared locations accessible by all users.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default

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
