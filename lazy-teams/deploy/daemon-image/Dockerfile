# syntax=docker/dockerfile:1
#
# The lazy daemon image — the image a project daemon runs in inside its VM:
# bun + a lazy checkout + a Docker engine, in one OCI image. Nothing below is
# smolvm-specific; smolvm is simply the vehicle in use today, and it boots this
# image as a microVM with `smolvm machine create -I <image>`.
#
# Build it from the repository root (the build context is the repo):
#
#   scripts/publish-lazy-daemon-image.sh                  # local, host arch
#   scripts/publish-lazy-daemon-image.sh --platform linux/arm64,linux/amd64 --push
#
# What the fleet supervisor expects of this image, and why each piece is here,
# is docs/design/lazy-daemon-image.md. The short version:
#
#   * `lazy` on PATH — every supervisor entry point into the guest is
#     `machine exec -- sh -c '. env.sh; exec lazy …'`, so the wrapper installed
#     at /usr/local/bin/lazy is the ONLY hook the image gets. It brings the
#     guest up (docker data-root + dockerd) before handing off to the CLI.
#   * `git` — the supervisor clones the project repo inside the guest.
#   * a Docker engine — task containers run on the guest's own dockerd, and
#     managed mode has no other runner. dockerd cannot use the rootfs overlay
#     (ramfs lower layer), which is what lazy-guest-init exists to work around.
#   * the lazy sources at /opt/lazy, including Dockerfile.lazy — the daemon
#     builds the lazy-runner agent image from it on the guest's dockerd.
#
# One Dockerfile, both architectures: nothing below is arch-conditional. bun
# comes from the official multi-arch bun image rather than the install script,
# so the runtime bun is byte-identical to the one that resolved bun.lock.

ARG BUN_VERSION=1.2.21
ARG DEBIAN_TAG=bookworm-slim

# ── lazy CLI (bun + source checkout) ─────────────────────────────────────────
# Same shape as lazy-teams/deploy/Dockerfile: lazy runs from TypeScript sources,
# not a compiled bundle, so the tree ships as-is.

FROM docker.io/oven/bun:${BUN_VERSION} AS lazy-checkout

WORKDIR /opt/lazy

COPY package.json bun.lock ./
COPY scripts ./scripts
COPY src ./src
COPY public-docs ./public-docs
COPY Dockerfile.lazy ./
COPY tsconfig.json ./
# src/server/styles.ts imports this at module load (`with { type: "text" }`),
# so a checkout without it cannot even answer `lazy --version` (MEASURED,
# hardware run 20260920-081830: "Cannot find module ../../design/industry/
# styles.css"). Same line as the Teams image; test/unit/lazy-daemon-image.test.ts
# derives the list of out-of-src imports and checks every one has a COPY.
COPY design/industry/styles.css ./design/industry/styles.css

# lazy-agent is gitignored and excluded from the build context (.dockerignore);
# create the placeholder the same way `bun run ensure:agent-placeholder` does.
RUN bun install && \
    bun run generate:version && \
    bun run ensure:agent-placeholder && \
    { find src package.json Dockerfile.lazy bun.lock -type f | LC_ALL=C sort | xargs sha256sum; } \
      | sha256sum | awk '{print substr($1,1,16)}' > .source-fingerprint

# ── Guest runtime ────────────────────────────────────────────────────────────

FROM docker.io/library/debian:${DEBIAN_TAG} AS runtime

# A stale guest image is otherwise undetectable from the host: the supervisor
# only ever sees `lazy --version` output from inside. These labels let an
# operator read the build off the image itself, and the fingerprint is the same
# content hash the publish script puts in the `sha-…` tag.
ARG LAZY_VERSION=unknown
ARG LAZY_SOURCE_FINGERPRINT=unknown
LABEL lazyVersion="${LAZY_VERSION}" \
      lazySourceFingerprint="${LAZY_SOURCE_FINGERPRINT}" \
      org.opencontainers.image.title="lazy-daemon" \
      org.opencontainers.image.description="the image a lazy project daemon runs in inside its VM (bun + lazy + dockerd)" \
      org.opencontainers.image.source="https://github.com/getlazy/lazy" \
      org.opencontainers.image.version="${LAZY_VERSION}"

# docker.io brings dockerd, the docker CLI, containerd, runc and iptables.
# socat: the forwarder lazy-guest-init runs from the guest's link address to the
# daemon's loopback, because the VM's published-port relay dials the link address
# (measured on smolvm v1.9.3) and managed mode pins the daemon to 127.0.0.1.
# git: the supervisor's in-guest `git clone`. ca-certificates: every fetch the
# daemon and the runner build make. iproute2/procps/e2fsprogs: what
# lazy-guest-init and any operator debugging need to see the guest's disks and
# processes without an apt-get inside a VM that may have no egress to apt.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      ca-certificates \
      curl \
      docker.io \
      e2fsprogs \
      git \
      iproute2 \
      iptables \
      jq \
      procps \
      socat \
      unzip \
      xz-utils && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# The exact bun that resolved bun.lock in the stage above.
COPY --from=lazy-checkout /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

COPY --from=lazy-checkout /opt/lazy /opt/lazy

COPY lazy-teams/deploy/daemon-image/lazy-guest-init /usr/local/bin/lazy-guest-init
# Named lazy-wrapper in the repository, `lazy` in the guest: the repo's
# .gitignore ignores any path component called `lazy` (the compiled binary), and
# the build context is `git archive`, so a file named `lazy` would silently not
# exist at build time.
COPY lazy-teams/deploy/daemon-image/lazy-wrapper /usr/local/bin/lazy
RUN chmod 0755 /usr/local/bin/lazy-guest-init /usr/local/bin/lazy

# LAZY_CHECKOUT is what the wrapper runs; LAZY_GUEST_STORAGE_ROOT is where
# lazy-guest-init looks for the machine's real disk (smolvm mounts the
# `--storage` ext4 volume at /storage).
ENV LAZY_CHECKOUT="/opt/lazy" \
    LAZY_GUEST_STORAGE_ROOT="/storage" \
    PATH="/usr/local/bin:${PATH}"

# smolvm boots its own init and drives the guest through `machine exec`, so it
# never runs this. It is here so the image is testable as a plain container.
CMD ["/bin/bash"]
