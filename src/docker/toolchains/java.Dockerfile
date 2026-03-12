# Toolchain: java
# OpenJDK LTS + Maven + Gradle for JVM development.

FROM eclipse-temurin:21-jdk-jammy

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    unzip \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Maven
ARG MAVEN_VERSION=3.9.9
RUN curl -fsSL https://dlcdn.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz \
    | tar -xz -C /opt \
    && ln -s /opt/apache-maven-${MAVEN_VERSION}/bin/mvn /usr/local/bin/mvn

# Install Gradle
ARG GRADLE_VERSION=8.10
RUN curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip \
    && unzip -d /opt /tmp/gradle.zip \
    && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

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
