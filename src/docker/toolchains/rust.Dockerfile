# Toolchain: rust
# Rust via rustup + cargo + common system dependencies.

FROM debian:bookworm-slim

# System deps: git, curl, jq, build essentials, and common Rust build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    build-essential \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust via rustup to shared locations accessible by all users.
# chmod ensures the non-root user can run rustup/cargo and install crates.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default \
    && chmod -R a+w /usr/local/cargo /usr/local/rustup

# Install Claude Code agent via Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
