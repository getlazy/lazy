# Toolchain: base
# Minimal dev container with git, curl, and common utilities.
# Used as the fallback when no specific toolchain is detected.

FROM debian:bookworm-slim

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    gnupg \
    less \
    openssh-client \
    unzip \
    wget \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Headless browser, for screenshots.
#
# A turn report can carry screenshots, and for anything visual that image is the
# fastest answer a reviewer gets — so agents working on a web surface need a
# browser. Without one in the image they `apt-get install -y chromium`
# themselves, once per container, paying the same download over and over where
# nobody can see it; and where egress is restricted they simply cannot.
#
# Shipping it costs ~700 MB installed (Chromium itself is ~350 MB with its
# common files; the rest is the GTK/mesa/LLVM stack apt pulls in). That is the
# largest single thing in this image, and deliberate: it is paid once at build
# time instead of repeatedly at task time.
#
# $CHROME_BIN is the convention tooling looks for, and what lazy's own browser
# lookup checks first.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium

# Non-root user with sudo — passes Claude Code's root check while allowing tool installs
RUN useradd --create-home --shell /bin/bash user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
ENV COLORTERM="truecolor"
ENV PATH="/home/user/.local/bin:${PATH}"

# Install Claude Code via native installer as `user` so it lands in
# /home/user/.local/bin/claude — the layout Claude Code expects for the current user.
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /work
