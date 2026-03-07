# Toolchain: kotlin
# OpenJDK + Kotlin compiler + Gradle for Kotlin/JVM development.

FROM eclipse-temurin:21-jdk-jammy

# System deps: git, curl, jq, and basic dev utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    less \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Gradle (primary build tool for Kotlin)
ARG GRADLE_VERSION=8.10
RUN curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o /tmp/gradle.zip \
    && unzip -d /opt /tmp/gradle.zip \
    && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# Install Kotlin compiler
ARG KOTLIN_VERSION=2.0.21
RUN curl -fsSL https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip -o /tmp/kotlin.zip \
    && unzip -d /opt /tmp/kotlin.zip \
    && ln -s /opt/kotlinc/bin/kotlin /usr/local/bin/kotlin \
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc \
    && rm /tmp/kotlin.zip

RUN useradd -m -s /bin/bash user
USER user

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /work
