# syntax=docker/dockerfile:1
#
# The lazy daemon image — the image a project daemon runs in inside its VM:
# lazy as a compiled binary + a Docker engine, in one OCI image. Nothing below is
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
#   * `gh` / `glab` — PR/MR creation (`lazy submit`) and review reads,
#     authenticated by the GH_TOKEN / GITLAB_TOKEN the fleet injects.
#   * a Docker engine — task containers run on the guest's own dockerd, and
#     managed mode has no other runner. dockerd cannot use the rootfs overlay
#     (ramfs lower layer), which is what lazy-guest-init exists to work around.
#   * lazy itself as the compiled release binary at /opt/lazy/bin/lazy (built by
#     scripts/build.ts, the same build a release ships) — no sources, no
#     node_modules, no bun. The binary embeds its prompts, the lazy-runner
#     Dockerfile it builds on the guest's dockerd and the agent binary; the
#     project's own Dockerfile.lazy is read from the PROJECT checkout, never from
#     lazy's.
#
# One Dockerfile, both architectures: nothing below is arch-conditional. bun
# (build stage only) comes from the official multi-arch bun image rather than the
# install script, so the compiler is byte-identical to the one that resolved
# bun.lock.

# The repo's pinned bun (.bun-version) — the one every test runs on. The image
# used to compile lazy with an older bun (1.2.21) whose WebSocket client
# duplicated handshake headers, which broke ActionCable through task services;
# test/unit/lazy-daemon-image.test.ts keeps the two equal.
ARG BUN_VERSION=1.4.3
ARG DEBIAN_TAG=bookworm-slim
# Forge CLIs, exact release versions. Bumping one means updating its two rows
# in the checksum table below; the build refuses a version it has no sha for.
ARG GH_VERSION=2.101.0
ARG GLAB_VERSION=1.119.0
# Docker engine + buildx, exact versions from Docker's apt repo. Debian
# bookworm's docker.io is 20.10, whose `docker build` is the LEGACY builder: it
# rejects BuildKit-only syntax (`RUN --network`, `RUN --mount`, heredocs) that a
# project's Dockerfile.lazy may use ("Unknown flag: network"). Docker 23+ builds
# through buildx/BuildKit by default; a buildx binary alone would not help, as
# the 20.10 CLI never delegates `docker build` to it.
ARG DOCKER_VERSION=29.8.2
ARG DOCKER_BUILDX_VERSION=0.37.1

# ── lazy CLI (build stage: sources → compiled binary) ────────────────────────
# The ONE build of lazy per release: lazy-teams/deploy/Dockerfile copies the
# compiled binary and its sidecars (to /lazy) rather than building its own. The
# sources and node_modules stay in this stage and never reach the runtime image.

FROM docker.io/oven/bun:${BUN_VERSION} AS lazy-checkout

WORKDIR /opt/lazy

COPY package.json bun.lock ./
# Dependencies on their own layer, from the lockfile alone, so a release whose
# lockfile did not change takes this layer from the build cache. The root
# `prepare` script needs scripts/ and src/, which are not here yet — it runs
# explicitly below (generate:version, ensure:agent-placeholder).
RUN bun install --ignore-scripts
COPY scripts ./scripts
COPY src ./src
COPY public-docs ./public-docs
COPY Dockerfile.lazy ./
COPY tsconfig.json ./
# src/server/styles.ts imports this at module load (`with { type: "text" }`),
# so a checkout without it cannot even answer `lazy --version` (MEASURED,
# hardware run 20260920-081830: "Cannot find module ../../design/industry/
# styles.css"). test/unit/deploy-image-copy-graph.test.ts
# derives the list of out-of-src imports and checks every one has a COPY.
COPY design/industry/styles.css ./design/industry/styles.css

# lazy-agent is gitignored and excluded from the build context (.dockerignore);
# create the placeholder the same way `bun run ensure:agent-placeholder` does.
#
# The fingerprint is computed by lazy itself (`system source-id --write`), the
# one implementation RollsFleet compares against — never a shell pipeline. It
# also proves the CLI's module graph loads, here, where failing is cheap. The
# Teams image copies the compiled binary and this fingerprint.
#
# The checkout has no .git (.dockerignore; the publish script builds from a
# `git archive`), so the source identity comes in as build args from the
# script that has the repository, and is written to source-stamp.json BEFORE
# generate:version — which reads it for the version's commit count, and stamps
# build-info.ts from it so `lazy --version` and every lazy-agent compiled from
# this tree name their commit (src/utils/source-stamp.ts). Without the args the
# step warns and the build reports its source as 'unknown'.
ARG LAZY_BUILD_SHA=
ARG LAZY_BUILD_BRANCH=
ARG LAZY_BUILD_DIRTY=
ARG LAZY_BUILD_COMMIT_COUNT=
ARG LAZY_BUILD_TIME=
RUN bun run scripts/write-source-stamp.ts && \
    bun run generate:version && \
    bun run ensure:agent-placeholder && \
    bun run src/index.ts system source-id --write

# COMPILE the release binary, exactly as a release does (scripts/build.ts: the
# lazy-agent binary first, then lazy with it embedded, `--define
# LAZY_RELEASE_BUILD=true --minify-syntax`). It embeds the `.source-fingerprint`
# just written, so `lazy system source-id` in the guest answers the same id the
# fleet roll compares against. Runs for THIS image's platform (one build per
# arch under buildx), and the smoke line proves the binary starts here — and
# that it carries lazy-guest-init byte for byte, since the image's shim runs
# nothing else (docs/design/lazy-daemon-image.md, "What travels with the binary").
RUN bun run scripts/build.ts && \
    ./lazy --version && \
    ./lazy system source-id --json | tee /dev/stderr | grep -q '"kind": *"embedded"' && \
    [ "$(./lazy system source-id)" = "$(cat .source-fingerprint)" ]
# lazy-guest-init, out of the compiled binary: byte-identical to the source, and
# written under the id the binary reports (no hash tool here: the build stage
# hashes nothing itself — see deploy-image-fingerprint tests).
RUN gi="$(./lazy system guest-init-script --run-dir /tmp/guest-init-check)" && \
    cmp "$gi" src/guest/lazy-guest-init && \
    [ "$gi" = "/tmp/guest-init-check/lazy-guest-init.$(./lazy system guest-init-script --id)" ] && \
    rm -rf /tmp/guest-init-check

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
      org.opencontainers.image.description="the image a lazy project daemon runs in inside its VM (lazy + dockerd)" \
      org.opencontainers.image.source="https://github.com/getlazy/lazy" \
      org.opencontainers.image.version="${LAZY_VERSION}"

# THE GUEST ABI — raise it BY HAND whenever this stage changes what a machine's
# root filesystem holds outside /opt/lazy/bin/lazy: Debian, the packages, Docker,
# gh/glab, the lazy-guest-init SHIM, the wrapper, /etc/gitconfig, the ENV below.
# A Teams upgrade copies only the lazy binary into a running machine (an
# in-place swap that keeps its docker images and tools); a machine created under
# another ABI is REPLACED instead, because only a new machine gets a new root
# filesystem. lazy-guest-init's actual logic is NOT here: it is embedded in the
# binary (src/guest/lazy-guest-init) and upgrades in place with it, so changing
# it never needs a bump — that is what ABI 5 introduced the shim for.
# test/unit/lazy-daemon-image.test.ts pins a digest of this stage and those
# files to the number, so a change that forgets the bump fails there.
LABEL org.getlazy.guest-abi="5"

# The Docker engine comes from Docker's own apt repo (next block), not Debian's
# docker.io. gnupg: verifies that repo's key. iptables: dockerd's bridge rules.
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
      e2fsprogs \
      git \
      gnupg \
      git-lfs \
      iproute2 \
      iptables \
      jq \
      procps \
      socat \
      unzip \
      xz-utils && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Docker engine from Docker's apt repo, pinned. The repo key's fingerprint is
# verified, so a swapped key fails the build. The last command fails the build
# if the BuildKit builder is missing — the legacy builder must never silently
# come back (lazy-guest-init re-checks at boot).
ARG DOCKER_VERSION
ARG DOCKER_BUILDX_VERSION
RUN set -eu; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.asc; \
    gpg --show-keys --with-colons /tmp/docker.asc | grep -q '^fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' \
      || { echo "Docker apt key fingerprint mismatch" >&2; exit 1; }; \
    mkdir -p /tmp/dockergpg; chmod 700 /tmp/dockergpg; \
    gpg --homedir /tmp/dockergpg --batch --import /tmp/docker.asc; \
    gpg --homedir /tmp/dockergpg --batch --export 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 > /etc/apt/keyrings/docker.gpg; \
    [ "$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.gpg | grep -c '^pub:')" = 1 ] \
      || { echo "Docker apt keyring must hold exactly the asserted key" >&2; exit 1; }; \
    rm -rf /tmp/docker.asc /tmp/dockergpg; \
    echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update -qq; \
    apt-get install --no-install-recommends -y \
      "docker-ce=5:${DOCKER_VERSION}-1~debian.12~bookworm" \
      "docker-ce-cli=5:${DOCKER_VERSION}-1~debian.12~bookworm" \
      "docker-buildx-plugin=${DOCKER_BUILDX_VERSION}-1~debian.12~bookworm" \
      containerd.io; \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives; \
    docker --version; \
    docker buildx version

# gh and glab: the forge drivers' API features — opening PRs/MRs on
# `lazy submit`, reading their reviews and comments. No login step: the fleet
# puts the member's forge token in the daemon's environment as GH_TOKEN /
# GITLAB_TOKEN, which both CLIs read ahead of any stored credential. Official
# release tarballs, not apt (Debian's gh lags years behind; glab is not
# packaged). TARGETARCH is BuildKit's amd64/arm64, which is exactly how both
# projects name their tarballs — no arch branch; the table only LOOKS UP the
# checksum of whichever file was fetched.
ARG TARGETARCH
ARG GH_VERSION
ARG GLAB_VERSION
RUN set -eu; cd /tmp; \
    gh="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    glab="glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh}"; \
    curl -fsSLO "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${glab}"; \
    printf '%s\n' \
      "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8  gh_2.101.0_linux_amd64.tar.gz" \
      "b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f  gh_2.101.0_linux_arm64.tar.gz" \
      "4d83375d202ffa634eaf627fd9272b610fa599f20f5b711f55d770583eca2b84  glab_1.119.0_linux_amd64.tar.gz" \
      "8540c4afbe63c4da023c15bfce15f2f1ef9cc1afe4a6fd6812c426b9eeab073b  glab_1.119.0_linux_arm64.tar.gz" \
      > forge-cli.sha256; \
    grep -E "  (${gh}|${glab})\$" forge-cli.sha256 > want.sha256 || true; \
    [ "$(wc -l < want.sha256)" -eq 2 ] || { echo "no pinned sha256 for ${gh} and/or ${glab}: update the table with the version" >&2; exit 1; }; \
    sha256sum -c want.sha256; \
    tar -xzf "${gh}" --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    tar -xzf "${glab}" --strip-components=1 -C /usr/local/bin bin/glab; \
    rm -f "${gh}" "${glab}" forge-cli.sha256 want.sha256; \
    gh --version; glab --version

# lazy, as the compiled release binary and the three small files that name it.
# No bun, no sources, no node_modules: the build stage had them, this image does
# not. /opt/lazy/.source-fingerprint is what the fleet roll reads out of the image
# (DaemonImageFetcher, the publish script's --save); source-stamp.json and
# src/version.ts are the sidecars the Teams app image reads for its version.
COPY --from=lazy-checkout /opt/lazy/lazy /opt/lazy/bin/lazy
# source-stamp.json is absent when the build was handed no LAZY_BUILD_SHA, hence
# the bracket glob (a no-match glob is tolerated beside a file that does match).
COPY --from=lazy-checkout /opt/lazy/.source-fingerprint /opt/lazy/source-stamp.jso[n] /opt/lazy/
COPY --from=lazy-checkout /opt/lazy/src/version.ts /opt/lazy/src/version.ts

# A stable shim: it runs the lazy-guest-init embedded in the CURRENT lazy binary.
COPY lazy-teams/deploy/daemon-image/lazy-guest-init /usr/local/bin/lazy-guest-init
# Named lazy-wrapper in the repository, `lazy` in the guest: the repo's
# .gitignore ignores any path component called `lazy` (the compiled binary), and
# the build context is `git archive`, so a file named `lazy` would silently not
# exist at build time.
COPY lazy-teams/deploy/daemon-image/lazy-wrapper /usr/local/bin/lazy
# The daemon (root) must trust worktrees a task container (uid 1000) has taken
# ownership of, or its own git refuses them — see the file's header.
COPY lazy-teams/deploy/daemon-image/gitconfig /etc/gitconfig
RUN chmod 0755 /usr/local/bin/lazy-guest-init /usr/local/bin/lazy

# LAZY_BIN is what the wrapper runs; LAZY_GUEST_STORAGE_ROOT is where
# lazy-guest-init looks for the machine's real disk (smolvm mounts the
# `--storage` ext4 volume at /storage).
ENV LAZY_BIN="/opt/lazy/bin/lazy" \
    LAZY_GUEST_STORAGE_ROOT="/storage" \
    PATH="/usr/local/bin:${PATH}"

# smolvm boots its own init and drives the guest through `machine exec`, so it
# never runs this. It is here so the image is testable as a plain container.
CMD ["/bin/bash"]
