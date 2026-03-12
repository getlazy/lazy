# Toolchain: python-ml
# Python 3 + pip + numpy/scipy build deps (BLAS, LAPACK, etc.).
# For machine learning and scientific computing projects.

FROM python:3.12-slim-bookworm

# System deps: git, curl, jq, native build tools, and ML library deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    build-essential \
    pkg-config \
    gfortran \
    libffi-dev \
    libssl-dev \
    libopenblas-dev \
    liblapack-dev \
    libjpeg-dev \
    libpng-dev \
    sudo \
    && rm -rf /var/lib/apt/lists/*

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
