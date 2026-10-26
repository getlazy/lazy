# lazy-runner: the default agent image, published as getlazy/lazy-runner.
# A minimal dev container with git, curl, common utilities and every agent CLI.

FROM debian:bookworm-slim

# System deps: git, curl, jq, and basic dev utilities. tmux: a task's services and
# long-running commands run in named tmux sessions in its container, which
# survive daemon restarts and can be watched or attached to.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    gnupg \
    less \
    openssh-client \
    openssh-server \
    unzip \
    wget \
    sudo \
    tmux \
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

# SSH into a task (`lazy shell <task> --ssh-config`): lazy starts `sshd -i`
# per connection over the container runtime's own exec — nothing listens and
# no port is published, so the package's own service and host keys are unused.
RUN rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub

# Non-root user with sudo — passes Claude Code's root check while allowing tool installs
RUN useradd --create-home --shell /bin/bash user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
ENV COLORTERM="truecolor"
ENV PATH="/home/user/.local/bin:${PATH}"

# Every agent CLI lazy can run in a container is appended after this point, one
# RUN per agent, as `user` so each lands in /home/user/.local/bin (the layout
# Claude Code expects). lazy composes them from each agent's own install line;
# `lazy system export-dockerfile` prints the full result.
