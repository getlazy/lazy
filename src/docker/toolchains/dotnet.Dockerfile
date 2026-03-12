# Toolchain: dotnet
# .NET SDK (latest LTS) + common tools (dotnet-ef, etc.).
# PRIORITY toolchain — used on the user's day job.

FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install .NET global tools (installs to /root/.dotnet/tools)
RUN dotnet tool install --global dotnet-ef

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="$PATH:/root/.dotnet/tools"

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
