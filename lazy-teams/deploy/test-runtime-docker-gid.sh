#!/usr/bin/env bash
# Prove runtime Docker gid alignment: an image built without the host's docker
# group id still reaches /var/run/docker.sock after entrypoint configuration.
#
# Requires Docker on the host and a real daemon socket. Not run in CI by default
# (lazy-teams CI does not build the deploy image); run locally before release:
#
#   lazy-teams/deploy/test-runtime-docker-gid.sh
#
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${DEPLOY_DIR}/../.." && pwd)"
CONFIGURE_SH="/usr/local/bin/configure-docker-socket.sh"

fail() { echo "test-runtime-docker-gid: $*" >&2; exit 1; }
log() { echo "test-runtime-docker-gid: $*"; }

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"
[[ -S /var/run/docker.sock ]] || fail "/var/run/docker.sock is missing"

SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock)"
# Deliberately wrong gid — must not match a typical host docker group.
WRONG_GID=$(( (SOCKET_GID + 17) % 60000 + 1000 ))

IMAGE="lazy-teams-gid-test:local"

log "building test image"
docker build -f "${DEPLOY_DIR}/Dockerfile" -t "${IMAGE}" "${ROOT}" >/dev/null

log "host socket gid=${SOCKET_GID}; simulating image baked with docker gid=${WRONG_GID}"
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --entrypoint bash \
  "${IMAGE}" \
  -c "
    set -euo pipefail
    groupmod -o -g ${WRONG_GID} docker
    # Exercise the same helper the entrypoint sources — not a reimplementation.
    source ${CONFIGURE_SH}
    configure_docker_socket_access
    gosu rails docker info >/dev/null
    echo \"rails groups: \$(gosu rails id -Gn)\"
  "

log "passed — configure-docker-socket.sh reaches Docker after runtime gid alignment"
