# syntax=docker/dockerfile:1
# Self-host image for Lazy Teams: Rails + the lazy CLI + a vendored smolvm (one
# microVM per project, given /dev/kvm) + the Docker client.
#
# Operators pull a pre-built image (ghcr.io/getlazy/lazy-teams) — see
# public-docs/self-hosting-lazy-teams.md. Developers build from the repo root:
#
#   docker build -f lazy-teams/deploy/Dockerfile -t lazy-teams:local .
#   # or: docker compose -f lazy-teams/deploy/docker-compose.yml \
#   #         -f lazy-teams/deploy/docker-compose.build.yml build
#
# The image is intentionally NOT the stock lazy-teams/Dockerfile: a fleet host
# must shell out to lazy, talk to the host Docker daemon, and keep persistent
# fleet state outside the container layer.
#
# The tree is laid out the way the repository is: the lazy checkout at /lazy,
# this Rails app at /lazy/lazy-teams. LazyCheckout's default — the parent of the
# Rails root — is therefore correct here by construction, and the image names no
# lazy path at all.

ARG RUBY_VERSION=3.4.10
# THE `-bookworm` SUFFIX IS LOAD-BEARING. `ruby:X-slim` follows whatever Debian
# the official image currently tracks, and it moved from bookworm to trixie
# under us. On trixie, `docker.io` (26.1.5) ships only `dockerd`,
# `docker-proxy` and `docker-init` — the CLI was split into its own package —
# so this image silently stopped containing `/usr/bin/docker`, and the
# entrypoint's first act died with "executable file not found in $PATH" on a
# host where everything else was correct. Nothing in this file changed; the
# base image changed operating systems.
#
# Pinned to the same release `Dockerfile.lazy` pins, so the two images this
# product ships agree on one OS. Moving to trixie is a real upgrade — a new
# glibc, new libvips and sqlite3, and a different docker packaging story — and
# belongs in its own change with a build behind it, not as a side effect of a
# floating tag.
FROM docker.io/library/ruby:${RUBY_VERSION}-slim-bookworm AS base

# Kamal identifies containers and prunes old images by this label — required
# even when deploying the pre-built ghcr.io/getlazy/lazy-teams image.
LABEL service="lazy_teams"

WORKDIR /lazy/lazy-teams

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      ca-certificates curl git libjemalloc2 libvips sqlite3 && \
    ln -s /usr/lib/$(uname -m)-linux-gnu/libjemalloc.so.2 /usr/local/lib/libjemalloc.so && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# LAZY_FOREIGN_DOCKER_HOST declares what is true of THIS image and of nothing
# else lazy runs in: the Docker daemon it talks to is the HOST's, reached
# through a bind-mounted socket, and it does not share this container's
# filesystem or network. A task container launched from here would be handed
# `-v <path>:<path>` mount sources the host does not have — created EMPTY by
# native Linux Docker rather than refused — and told to reach the daemon at
# `host.docker.internal`, which is the host, not this container. Lazy refuses
# the launch instead. It is set on the IMAGE rather than in compose because it
# is a property of the image's topology, not an operator's choice.
# See docs/design/self-host-task-containers.md.
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_WITHOUT="development" \
    LD_PRELOAD="/usr/local/lib/libjemalloc.so" \
    LAZY_FOREIGN_DOCKER_HOST="1" \
    LAZY_FLEET_ROOT="/var/lib/lazy-fleet"

# ── Rails build stage ────────────────────────────────────────────────────────

FROM base AS rails-build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential git libvips libyaml-dev pkg-config && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

COPY lazy-teams/Gemfile lazy-teams/Gemfile.lock ./
COPY lazy-teams/vendor ./vendor/

RUN bundle install && \
    rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git && \
    bundle exec bootsnap precompile -j 1 --gemfile

COPY lazy-teams/ .

RUN bundle exec bootsnap precompile -j 1 app/ lib/ && \
    SECRET_KEY_BASE_DUMMY=1 ./bin/rails assets:precompile

# ── The pinned smolvm distribution, for THIS image's architecture ───────────
#
# smolvm is the default fleet backend: one microVM per project, which is how
# this image runs agent turns. bin/vendor-smolvm is the only way a smolvm tree
# enters this image — it fetches the pinned release, refuses it unless the
# archive matches SmolvmRelease::ARCHIVE_SHA256, unpacks the WHOLE distribution
# and writes the manifest every launch re-verifies. Never upstream's
# install.sh, never a smolvm off PATH. `TARGETARCH` is buildx's name for the
# platform being built, so a multi-arch publish vendors each arch's own tree.
# SECRET_KEY_BASE_DUMMY for the same reason assets:precompile needs it: the
# script loads the app for its constants and reads no secret.
ARG TARGETARCH
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) smolvm_platform=linux-x86_64 ;; \
      arm64) smolvm_platform=linux-arm64 ;; \
      *) echo "no smolvm build for architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    SECRET_KEY_BASE_DUMMY=1 ./bin/vendor-smolvm --platform "${smolvm_platform}" --into /opt/smolvm

# ── lazy CLI (bun + source checkout) ─────────────────────────────────────────

FROM oven/bun:1.2.21 AS lazy-checkout

WORKDIR /lazy

# Copy only what `bun install` and `bun run src/index.ts` need. The full tree
# is required because lazy runs from TypeScript sources, not a compiled bundle.
#
# THIS LIST IS A MODULE GRAPH, NOT A GUESS. Anything `src/` imports from outside
# `src/` has to be here or the first `bun run src/index.ts` below dies at import
# time — which is how this image shipped unbuildable: `src/server/styles.ts`
# imports the design stylesheet as text, `design/` was not copied, and nothing
# noticed until somebody built the image. `test/unit/deploy-image-copy-graph.test.ts`
# now resolves every escaping import and fails if one is missing from this list.
COPY package.json bun.lock ./
COPY scripts ./scripts
COPY src ./src
COPY public-docs ./public-docs
COPY Dockerfile.lazy ./
COPY tsconfig.json ./
# Imported as text by src/server/styles.ts. The file itself, not the directory:
# the rest of design/ is source material for humans and does not belong in a
# runtime image.
COPY design/industry/styles.css ./design/industry/styles.css

# lazy-agent is gitignored and excluded from the build context (.dockerignore);
# create the placeholder the same way `bun run ensure:agent-placeholder` does.
#
# The fingerprint is computed by lazy itself (`system source-id --write`), not by
# a shell pipeline here. It used to be the latter, and that made this file a
# second implementation of an identity the daemon also reports and Rails also
# compares — three spellings nothing kept in agreement. `.source-fingerprint` is
# now a build-time CACHE of src/utils/source-id.ts and nothing else.
RUN bun install && \
    bun run generate:version && \
    bun run ensure:agent-placeholder && \
    bun run src/index.ts system source-id --write

# ── Runtime image ──────────────────────────────────────────────────────────

FROM base AS runtime

# Docker CLI only — the daemon socket is mounted from the host at run time.
# git is required for project provisioning (clone + lazy init). iproute2 for
# `ss`, which bin/smolvm-hardware-probe reads the microVM relays' listeners
# with — the documented on-server check of this image.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      docker.io gosu iproute2 unzip && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Bun for `bun run /lazy/src/index.ts` (LocalSupervisor's default command).
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# The `docker` group is created by docker.io above with an arbitrary gid.
# entrypoint.sh aligns it to the mounted socket at container start so one
# published image works on any host (no DOCKER_GID build-arg).
RUN groupadd --system --gid 1000 rails && \
    useradd rails --uid 1000 --gid 1000 --create-home --shell /bin/bash && \
    usermod -aG docker rails

# PROVE THE ENTRYPOINT'S FIRST COMMAND WORKS, HERE, WHERE FAILING IS CHEAP.
#
# The entrypoint runs `gosu rails docker info` before Rails starts, and a
# container that cannot exec that dies seconds after `docker compose up` with a
# message an operator has to correlate against an image they did not build.
# This is the same check, run at build time: it needs no daemon (`--version` is
# pure CLI) and it asserts all three things at once — the CLI is installed, it
# is on the PATH this image actually has, and uid 1000 may execute it.
#
# It is deliberately `gosu rails` and not a bare `command -v`: root finding the
# binary says nothing about the user that will really run it.
RUN gosu rails docker --version

# The vendored smolvm tree, OWNED BY ROOT and not writable by rails: the app
# runs it but must not be able to change it. `--chown=root:root` explicitly,
# because tar ran as root in the build stage and so kept the ARCHIVE's uids —
# whatever numeric owner upstream packed with, which could be 1000 = rails.
# `COPY --from` keeps the modes and the path the manifest was written at, so
# the launch-time verification sees exactly the tree bin/vendor-smolvm
# verified. The build proves both halves as rails further down.
COPY --from=rails-build --chown=root:root /opt/smolvm /opt/smolvm

# Which release this image IS — the `v<major.minor>.<count>` tag
# scripts/publish-lazy-teams-image.sh computes and publishes it under. The
# daemon image is published under the same tag from the same commit, so
# SmolvmSupervisor defaults LAZY_DAEMON_IMAGE to
# ghcr.io/getlazy/lazy-daemon:<this>. A local build passes nothing and gets no
# default: then LAZY_DAEMON_IMAGE must be set, which setup health says.
ARG LAZY_TEAMS_VERSION=
ENV LAZY_TEAMS_VERSION="${LAZY_TEAMS_VERSION}" \
    LAZY_SMOLVM_BINARY="/opt/smolvm/smolvm"

COPY --from=rails-build --chown=rails:rails "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=lazy-checkout --chown=rails:rails /lazy /lazy
COPY --from=rails-build --chown=rails:rails /lazy/lazy-teams /lazy/lazy-teams

RUN mkdir -p /var/lib/lazy-fleet /lazy/lazy-teams/storage && \
    chown -R rails:rails /var/lib/lazy-fleet /lazy/lazy-teams/storage /lazy

# PROVE THE VENDORED TREE, AS THE USER THAT RUNS IT, WHERE FAILING IS CHEAP.
# (1) the launch-time verification passes for rails — every file in the tree
# matches the manifest bin/vendor-smolvm wrote; (2) rails can write NOTHING in
# it: no file, no directory. A tree rails could rewrite would make the
# manifest check a formality, since it re-verifies what rails put there.
RUN SECRET_KEY_BASE_DUMMY=1 gosu rails ./bin/rails runner \
      'SmolvmRelease.verify_binary!(ENV.fetch("LAZY_SMOLVM_BINARY")); puts "smolvm tree verifies as rails"' && \
    writable="$(gosu rails find /opt/smolvm -writable -print -quit)" && \
    if [ -n "${writable}" ]; then echo "rails can write ${writable} in the vendored smolvm tree" >&2; exit 1; fi

COPY lazy-teams/deploy/configure-docker-socket.sh /usr/local/bin/configure-docker-socket.sh
COPY lazy-teams/deploy/entrypoint.sh /usr/local/bin/lazy-teams-entrypoint
RUN chmod 0755 /usr/local/bin/configure-docker-socket.sh /usr/local/bin/lazy-teams-entrypoint

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/lazy-teams-entrypoint"]
CMD ["./bin/thrust", "./bin/rails", "server"]
