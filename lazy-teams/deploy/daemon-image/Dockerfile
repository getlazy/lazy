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
#   * `gh` / `glab` — PR/MR creation (`lazy submit`) and review reads,
#     authenticated by the GH_TOKEN / GITLAB_TOKEN the fleet injects.
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
# Forge CLIs, exact release versions. Bumping one means updating its two rows
# in the checksum table below; the build refuses a version it has no sha for.
ARG GH_VERSION=2.101.0
ARG GLAB_VERSION=1.119.0

# ── lazy CLI (bun + source checkout) ─────────────────────────────────────────
# The ONE build of lazy per release: lazy-teams/deploy/Dockerfile copies this
# checkout (to /lazy) rather than building its own. lazy runs from TypeScript
# sources, not a compiled bundle, so the tree ships as-is.

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
# Teams image copies this checkout, fingerprint included.
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
      git-lfs \
      iproute2 \
      iptables \
      jq \
      procps \
      socat \
      unzip \
      xz-utils && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

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
# The daemon (root) must trust worktrees a task container (uid 1000) has taken
# ownership of, or its own git refuses them — see the file's header.
COPY lazy-teams/deploy/daemon-image/gitconfig /etc/gitconfig
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
