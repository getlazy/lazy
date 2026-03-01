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

# Install Claude Code agent via Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@latest \
    && rm -rf /var/lib/apt/lists/*

# Create user before installing .NET tools so they go to /home/user/.dotnet/tools
RUN useradd -m -s /bin/bash user
USER user

# Install .NET global tools as user (installs to /home/user/.dotnet/tools)
RUN dotnet tool install --global dotnet-ef
ENV PATH="$PATH:/home/user/.dotnet/tools"

WORKDIR /work
