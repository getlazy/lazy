#!/usr/bin/env bash
# Align the in-container `docker` group with the mounted socket's gid — and say
# precisely what happened when that cannot work. Sourced by
# lazy-teams-entrypoint at container start and by test-runtime-docker-gid.sh.
#
# A pre-built image must run on any host — baking the build machine's gid into the
# image (the old DOCKER_GID build-arg) silently broke pull-and-go installs.
#
# ## Why this reports instead of just doing
#
# The first version assumed the alignment was always POSSIBLE and always TOOK.
# Neither is guaranteed, and both failures looked identical from outside: the
# entrypoint printed the socket's gid and "check host socket permissions",
# which is true of every one of these cases and useful in none of them.
#
#   - A socket whose MODE gives its group nothing cannot be opened by any group,
#     so no amount of groupmod helps. Only the owner can use it, and the answer
#     is on the host, not in here.
#   - `groupmod` / `usermod` can fail, and a caller that ignores their exit
#     status cannot tell that from success.
#   - Even when both succeed, the membership the kernel sees is what matters.
#     Asking `id -G rails` afterwards is the only check that means anything.
#
# So the function records what it observed in DOCKER_SOCKET_* and never decides
# on its own that the container should die — the caller owns that, and owns
# saying it in words an operator can act on.

# Owner uid, owner gid and octal mode of a socket, space separated.
# GNU stat first, BSD stat second: the image is Debian, the script is also read
# by people on a Mac.
docker_socket_facts() {
  local socket="$1"
  stat -c '%u %g %a' "${socket}" 2>/dev/null || stat -f '%u %g %Lp' "${socket}"
}

# Does this octal mode give the socket's GROUP both read and write?
#
# The group digit is the middle of the last three, which is why this indexes
# from the right: a mode may arrive as `660` or as `0660` depending on whose
# stat answered.
socket_group_rw() {
  local mode="$1" digit
  digit="${mode: -2:1}"
  [[ "${digit}" =~ ^[0-7]$ ]] || return 1
  (( (digit & 6) == 6 ))
}

# Sets, for the caller to report:
#   DOCKER_SOCKET_UID / _GID / _MODE  what the socket actually is
#   DOCKER_SOCKET_ALIGNMENT           ok | ungroupable | *-failed | not-applied
#
# shellcheck disable=SC2034  # this file is SOURCED; every one of these is read
# by entrypoint.sh, which is the whole point of setting them.
configure_docker_socket_access() {
  local socket="${DOCKER_SOCKET_PATH:-/var/run/docker.sock}"
  DOCKER_SOCKET_UID=""
  DOCKER_SOCKET_GID=""
  DOCKER_SOCKET_MODE=""
  DOCKER_SOCKET_ALIGNMENT="no-socket"
  [[ -S "${socket}" ]] || return 0

  local uid gid mode
  read -r uid gid mode <<<"$(docker_socket_facts "${socket}")"
  DOCKER_SOCKET_UID="${uid}"
  DOCKER_SOCKET_GID="${gid}"
  DOCKER_SOCKET_MODE="${mode}"

  # Nothing to align to. Said plainly rather than attempted and blamed on the
  # host afterwards: a 0600 socket is a decision somebody made, not a mistake
  # this container can repair.
  if ! socket_group_rw "${mode}"; then
    DOCKER_SOCKET_ALIGNMENT="ungroupable"
    return 0
  fi

  local err
  if getent group docker >/dev/null 2>&1; then
    # docker.io creates this group at image build time; groupmod beats a second
    # groupadd, which fails when the name already exists. `-o` because the
    # socket's gid may already belong to another group — gid 0 on Docker
    # Desktop, where it is root's.
    if ! err="$(groupmod -o -g "${gid}" docker 2>&1)"; then
      DOCKER_SOCKET_ALIGNMENT="groupmod-failed: ${err}"
      return 0
    fi
  elif ! err="$(groupadd -o --system --gid "${gid}" docker 2>&1)"; then
    DOCKER_SOCKET_ALIGNMENT="groupadd-failed: ${err}"
    return 0
  fi

  if ! err="$(usermod -aG docker rails 2>&1)"; then
    DOCKER_SOCKET_ALIGNMENT="usermod-failed: ${err}"
    return 0
  fi

  # The only question that matters: does the kernel now give rails that gid?
  # /etc/group agreeing is not the same thing, and this is the check the old
  # version never made.
  local groups
  groups="$(id -G rails 2>/dev/null || true)"
  if [[ " ${groups} " == *" ${gid} "* ]]; then
    DOCKER_SOCKET_ALIGNMENT="ok"
  else
    DOCKER_SOCKET_ALIGNMENT="not-applied: rails is in groups [${groups}], socket needs ${gid}"
  fi
}
