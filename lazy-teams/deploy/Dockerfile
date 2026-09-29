# syntax=docker/dockerfile:1
# Self-host image for Lazy Teams: Rails + the lazy CLI + a vendored smolvm (one
# microVM per project, given /dev/kvm) + the Docker client.
#
# Operators pull a pre-built image (ghcr.io/getlazy/lazy-teams) — see
# public-docs/self-hosting-lazy-teams.md. Developers build from the repo root:
#
#   docker build $(scripts/source-stamp-build-args.sh) -f lazy-teams/deploy/daemon-image/Dockerfile -t lazy-daemon:local .
#   docker build -f lazy-teams/deploy/Dockerfile \
#     --build-arg LAZY_DAEMON_IMAGE=lazy-daemon:local -t lazy-teams:local .
#   # or: scripts/publish-lazy-teams-image.sh --daemon-image lazy-daemon:local
#
# LAZY IS BUILT ONCE PER RELEASE. This image does not build the lazy checkout:
# it copies /opt/lazy (and the bun that resolved its lockfile) out of the lazy
# daemon image named by LAZY_DAEMON_IMAGE — the guest image every project
# daemon boots. The app and the daemons it launches therefore run
# byte-identical lazy by construction. The publish script pins that image to
# this commit's own version tag, never `latest`, and refuses to build when it
# does not exist.
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
# The lazy daemon image to take the lazy checkout from. Deliberately no default:
# an empty value fails the build at the `lazy-daemon` stage below, naming this
# argument. scripts/publish-lazy-teams-image.sh passes the daemon image of the
# same commit (ghcr.io/getlazy/lazy-daemon:<its version tag>).
ARG LAZY_DAEMON_IMAGE=
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
      ca-certificates curl git git-lfs libjemalloc2 libvips sqlite3 && \
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

# ── lazy CLI: the daemon image's checkout ────────────────────────────────────
#
# The daemon image (lazy-teams/deploy/daemon-image/Dockerfile) owns building
# the checkout — the COPY list that is a module graph, `bun install`,
# generate:version, the lazy-agent placeholder and `.source-fingerprint` (written
# by `lazy system source-id --write`).
# Its runtime is debian bookworm, the same release as this image's ruby base,
# so its glibc-linked bun runs here unchanged.

FROM ${LAZY_DAEMON_IMAGE} AS lazy-daemon

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

# Bun for `bun run /lazy/src/index.ts` (LocalSupervisor's default command):
# the exact bun that resolved the checkout's bun.lock, from the daemon image.
COPY --from=lazy-daemon /usr/local/bin/bun /usr/local/bin/bun

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
#
# The same source identity the daemon image was built with (LAZY_BUILD_*,
# src/utils/source-stamp.ts), for the app itself: the footer on every page and
# GET /version read it (AppVersion). Passed by publish-lazy-teams-image.sh.
ARG LAZY_TEAMS_VERSION=
ARG LAZY_BUILD_SHA=
ARG LAZY_BUILD_BRANCH=
ARG LAZY_BUILD_DIRTY=
# Part of the one shared arg set (scripts/source-stamp-build-args.sh) and unused
# here — the version is LAZY_TEAMS_VERSION — declared so docker does not warn
# about build args nothing consumed.
ARG LAZY_BUILD_COMMIT_COUNT=
ARG LAZY_BUILD_TIME=
ENV LAZY_TEAMS_VERSION="${LAZY_TEAMS_VERSION}" \
    LAZY_TEAMS_BUILD_SHA="${LAZY_BUILD_SHA}" \
    LAZY_TEAMS_BUILD_BRANCH="${LAZY_BUILD_BRANCH}" \
    LAZY_TEAMS_BUILD_DIRTY="${LAZY_BUILD_DIRTY}" \
    LAZY_SMOLVM_BINARY="/opt/smolvm/smolvm"

COPY --from=rails-build --chown=rails:rails "${BUNDLE_PATH}" "${BUNDLE_PATH}"
COPY --from=lazy-daemon --chown=rails:rails /opt/lazy /lazy
COPY --from=rails-build --chown=rails:rails /lazy/lazy-teams /lazy/lazy-teams

RUN mkdir -p /var/lib/lazy-fleet /lazy/lazy-teams/storage && \
    chown -R rails:rails /var/lib/lazy-fleet /lazy/lazy-teams/storage /lazy

# PROVE THE COPIED LAZY RUNS HERE, AS RAILS, WHERE FAILING IS CHEAP. The
# checkout and bun came from another image; this is the first time either runs
# on this image's glibc, at /lazy, owned by uid 1000. It must answer from the
# baked fingerprint the daemon image wrote, never by re-hashing.
RUN gosu rails bun run /lazy/src/index.ts system source-id --json | tee /dev/stderr | grep -q '"kind": *"baked"'

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
