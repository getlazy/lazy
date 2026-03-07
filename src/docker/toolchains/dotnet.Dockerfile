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
    && rm -rf /var/lib/apt/lists/*

# Create user before installing tools so they go to /home/user/
RUN useradd -m -s /bin/bash user
USER user

# Install .NET global tools as user (installs to /home/user/.dotnet/tools)
RUN dotnet tool install --global dotnet-ef

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="$PATH:/home/user/.dotnet/tools:/home/user/.local/bin"

WORKDIR /work
