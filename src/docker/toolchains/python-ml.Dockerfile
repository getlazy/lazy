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
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /work
