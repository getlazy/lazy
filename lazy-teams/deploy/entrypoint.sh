#!/usr/bin/env bash
# Self-host entrypoint: align Docker socket access, prepare the database, then
# hand off to Rails.
#
# It does NOT build the lazy-runner agent image any more. This image cannot
# launch agent containers at all (see the LAZY_TEAMS_BUILD_RUNNER block below
# and docs/design/self-host-task-containers.md), so that build produced an image
# nothing here could run and cost half an hour on a cold host. Setting
# LAZY_TEAMS_BUILD_RUNNER=1 arms it again.
set -euo pipefail
cd /lazy/lazy-teams

log() { echo "lazy-teams-entrypoint: $*" >&2; }

# Set by the image's ENV and by compose; defaulted here so `set -u` cannot turn
# a stripped environment into an unreadable error about an unbound variable.
LAZY_FLEET_ROOT="${LAZY_FLEET_ROOT:-/var/lib/lazy-fleet}"

# shellcheck source=configure-docker-socket.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/configure-docker-socket.sh"

# Runner rebuild marker id — the lazy checkout's own content identity, asked of
# lazy rather than reconstructed here. It is keyed on content and not on
# package.json VERSION, which is identical for every build of a release tarball
# without .git. This used to read .source-fingerprint directly with a sed
# fallback; lazy answers the same question from the same file and knows what to
# do when it is missing, so there is no second rule to keep in step.
#
# As `rails`, like every other lazy invocation here: root would be able to leave
# root-owned artefacts in a tree the app then runs as uid 1000.
lazy_source_id() {
  gosu rails bun run /lazy/src/index.ts system source-id
}

configure_docker_socket_access

# /dev/kvm for the default microVM fleet, opened AS RAILS.
#
# smolvm must run unprivileged and in the device's group — as root it drops
# each VM to its own uid, which then cannot read the project files (measured on
# Linux KVM, see app/clients/smolvm_host.rb). A passed-in device keeps the
# HOST's gid, which means nothing to this image's /etc/group, so the group is
# aligned here the way configure-docker-socket.sh aligns the socket's: one
# published image, any host.
#
# THE GRANT IS THE GID, NOT THE GROUP'S NAME. Membership of a group with gid N
# opens everything in this image that gid N opens, whatever the group is
# called — so a dedicated name alone protects nothing. The rule is therefore:
# rails joins the device's gid ONLY when no group of this image already owns
# it (other than `kvm`, which exists for exactly this device, or our own
# `kvm-host` from an earlier start). If the host gave /dev/kvm the gid of,
# say, `shadow`, `disk`, `sudo` or `docker` in this image, joining would grant
# that group's files too, so it refuses and names the collision. gid 0 is the
# same case at its worst. What rails then holds is: the device, plus anything
# in the image a group that did not previously exist can open — nothing.
#
# Nothing here exits. No device, or one rails still cannot open, is reported on
# setup health with the remedy (and the LAZY_FLEET_BACKEND=local escape hatch),
# where an operator will read it; dying here would hide the product surface
# that works without it.
configure_kvm_access() {
  local device=/dev/kvm gid group
  if [[ ! -c "${device}" ]]; then
    log "no ${device} in this container: microVM projects cannot run here (setup health says what to do)"
    return 0
  fi
  if gosu rails test -r "${device}" -a -w "${device}"; then
    return 0
  fi

  gid="$(stat -c %g "${device}")"
  if [[ "${gid}" == "0" ]]; then
    log "${device} belongs to group 0 and rails cannot open it; refusing to add rails to root's group."
    log "Give the device its own group on the host (a kvm group, mode 0660) and recreate this container."
    return 0
  fi

  local owners owner
  owners="$(getent group | awk -F: -v gid="${gid}" '$3 == gid { print $1 }')"
  for owner in ${owners}; do
    case "${owner}" in
      kvm | kvm-host) ;;
      *)
        log "${device} has gid ${gid}, which in this image is the group '${owner}': joining it would give"
        log "rails everything '${owner}' can open here, not just the device. Refusing. Give /dev/kvm a"
        log "gid on the host that no group in this image uses (a dedicated kvm group), then recreate this"
        log "container; setup health reports the device as unusable until then."
        return 0
        ;;
    esac
  done

  group=kvm-host
  if getent group "${group}" >/dev/null; then
    groupmod -o -g "${gid}" "${group}" || { log "could not set group ${group} to gid ${gid}"; return 0; }
  else
    groupadd -o --system --gid "${gid}" "${group}" || { log "could not create group ${group} (gid ${gid})"; return 0; }
  fi
  usermod -aG "${group}" rails || { log "could not add rails to group ${group}"; return 0; }

  if gosu rails test -r "${device}" -a -w "${device}"; then
    log "rails joined group ${group} (gid ${gid}) to open ${device}"
  else
    log "rails still cannot open ${device} (mode $(stat -c %a "${device}"), gid ${gid}); setup health will say so"
  fi
}

configure_kvm_access

# The rails user must reach the mounted Docker socket. Check AS rails — root
# bypasses group permissions and would hide a gid mismatch until the first
# task turn. Use `gosu rails` (no explicit group): `gosu rails:rails` drops
# supplementary groups, so the docker group membership would vanish.
#
# DOCKER'S OWN MESSAGE IS THE POINT. This used to be `>/dev/null 2>&1`, which
# threw away the one sentence that distinguishes "permission denied on the
# socket" from "docker: command not found", a wrong DOCKER_HOST, or a daemon
# that is simply not listening — and then printed a gid, which is true in all
# four cases and a remedy in none.
# Where the docker CLI is, said as a fact rather than inferred from a failure.
#
# `exec: "docker": executable file not found in $PATH` is what Go reports for
# THREE different situations — not installed, installed but off PATH, and
# present but not executable by this user — and the operator needs a different
# answer for each. The image proves at build time that `gosu rails docker` runs
# (see deploy/Dockerfile), so reaching any of these at run time means something
# replaced the environment the image shipped with, and the PATH is the evidence.
docker_cli_report() {
  local found
  found="$(command -v docker 2>/dev/null || true)"
  if [[ -n "${found}" ]]; then
    echo "on PATH at ${found}"
  elif [[ -x /usr/bin/docker ]]; then
    echo "INSTALLED at /usr/bin/docker but not on this process's PATH [${PATH}]"
  elif [[ -e /usr/bin/docker ]]; then
    echo "present at /usr/bin/docker but not executable ($(stat -c '%A %U:%G' /usr/bin/docker 2>/dev/null || echo 'stat failed'))"
  else
    echo "NOT INSTALLED — no /usr/bin/docker in this image; PATH is [${PATH}]"
  fi
}

if [[ -S /var/run/docker.sock ]]; then
  if ! docker_error="$(gosu rails docker info 2>&1 >/dev/null)"; then
    log "cannot talk to Docker at /var/run/docker.sock as rails (uid 1000)"
    log "socket: owner uid ${DOCKER_SOCKET_UID:-unknown}, gid ${DOCKER_SOCKET_GID:-unknown}, mode ${DOCKER_SOCKET_MODE:-unknown}"
    log "group alignment: ${DOCKER_SOCKET_ALIGNMENT:-not attempted}"
    log "docker cli: $(docker_cli_report)"
    log "PATH as root: [${PATH}]"
    # shellcheck disable=SC2016  # single quotes are the POINT: $PATH must expand
    # in the shell gosu starts AS RAILS, not in this one. Expanding it here would
    # print root's PATH twice and hide the difference this line exists to show.
    log "PATH as rails: [$(gosu rails sh -c 'printf %s "$PATH"' 2>/dev/null || echo 'could not be read')]"
    log "docker said: ${docker_error:-(it printed nothing)}"
    # The remedy must follow the evidence above it. A socket problem and a
    # missing CLI need opposite answers, and printing the socket advice for
    # both is how the previous version sent somebody to check permissions that
    # were already correct.
    log ""
    if ! command -v docker >/dev/null 2>&1; then
      log "This is not a permissions problem: the docker CLI could not be found"
      log "at all. The image is built with a check that uid 1000 can run it"
      log "(deploy/Dockerfile, 'gosu rails docker --version'), so an image that"
      log "shipped cannot be missing it — something is overriding the"
      log "environment this container was built with. Compare the two PATHs"
      log "above, and check whether deploy/.env or the compose 'environment:'"
      log "block sets PATH."
    elif [[ "${DOCKER_SOCKET_ALIGNMENT:-}" == "ungroupable" ]]; then
      log "That mode gives the socket's group no access, so NO group membership"
      log "can open it — only its owner (uid ${DOCKER_SOCKET_UID:-unknown}) can. This app"
      log "deliberately does not run as root, so the fix is on the host:"
      log "  - Docker Desktop: Settings > Advanced > 'Allow the default Docker"
      log "    socket to be used', then recreate this stack."
      log "  - Otherwise: expose a socket the group can open, or put a Docker"
      log "    socket proxy in front of it and point DOCKER_HOST at that."
      log "See public-docs/self-hosting-lazy-teams.md, 'Your Docker socket stays on your host'."
    else
      log "The CLI is present and the socket's group is open, so this is what"
      log "docker itself reported above — a daemon that is not running or not"
      log "reachable is the usual cause, not this container's permissions."
    fi
    exit 1
  fi
fi

# THE BOOT GUARD, and it runs UNCONDITIONALLY — that is the whole point of it.
#
# Asking lazy for its own source identity is the cheapest proof that the lazy
# sources this image ships are present and can actually execute. A published
# image whose `/lazy` is incomplete, or whose entry point throws at import,
# answers nothing here — and every project it later provisions dies minutes in,
# as a daemon that never comes up. The operator sees a project stuck in
# provisioning and no reason for it.
#
# It was briefly moved inside `build_lazy_runner` when that build went behind a
# flag, which disarmed it for every default install — exactly the ones that
# ship. The build NEEDS the id, but the guard is not the build's: it belongs to
# boot, so it runs here and the build reads the result.
#
# `LAZY_SOURCE_ID` rather than a local: the value is computed once at boot and
# read later, and a second `lazy_source_id` call is a second chance for the two
# to disagree.
if ! LAZY_SOURCE_ID="$(lazy_source_id)" || [[ -z "${LAZY_SOURCE_ID}" ]]; then
  log "could not read the lazy source identity from /lazy — the image is incomplete"
  log "(expected 'bun run /lazy/src/index.ts system source-id' to print an id)"
  exit 1
fi

# The lazy-runner agent image, built on the HOST daemon — OFF BY DEFAULT.
#
# It exists for one consumer: a task container. This image cannot launch one
# (docs/design/self-host-task-containers.md — the mounts and the callback
# address do not translate out of this container), so building it was the
# slowest part of a fresh install, took well over half an hour on a cold host,
# and produced an image nothing here would ever run.
#
# Kept behind a flag rather than deleted: the day the packaged image does
# launch task containers, this is the step that has to come back, and a
# commented-out build is a step nobody can run. Set LAZY_TEAMS_BUILD_RUNNER=1
# to arm it.
build_lazy_runner() {
  local id marker
  # Read from the boot guard above, never asked for again — see the note there.
  id="${LAZY_SOURCE_ID}"
  marker="${LAZY_FLEET_ROOT}/.lazy-runner-built-${id}"
  [[ -f "${marker}" ]] && return 0

  log "================================================================"
  log "FIRST BOOT: building lazy-runner on the host Docker daemon."
  log "This is normal on a fresh install or after an upgrade — it may"
  log "take several minutes. Leave the container running; restarting"
  log "now will restart the build from scratch."
  log "================================================================"
  # NO `--timeout`, DELIBERATELY. Image builds are unbounded by default
  # (`resolveBuildTimeoutMs` returns 0 when the flag is absent, and
  # `runDockerBuild` arms its kill timer only when that is above zero), and this
  # build is the thing `bin/self-host-accept` waits out with its own first-boot
  # ceiling. A bound here would be a SECOND deadline competing with that one,
  # and on a cold host it is the likelier of the two to fire.
  #
  # `--yes` used to be here and was never a real flag: `system build` registers
  # only `--no-cache` and `--timeout`, has no confirmation prompt, and rejected
  # the whole invocation with "Unknown flag: --yes". Nothing in the repository
  # ran this line, so it shipped broken from the day it was written.
  if ! gosu rails env LAZY_MANAGED= LAZY_MANAGED_STORAGE_PATH= \
      bun run /lazy/src/index.ts system build lazy-runner; then
    log "lazy-runner build failed — task containers will not start until this succeeds"
    exit 1
  fi
  # Drop markers from older lazy versions so the fleet volume does not accumulate.
  find "${LAZY_FLEET_ROOT}" -maxdepth 1 -name '.lazy-runner-built-*' ! -name "$(basename "${marker}")" -delete 2>/dev/null || true
  touch "${marker}"
  chown rails:rails "${marker}"
  log "lazy-runner image ready for lazy checkout ${id}"
}

if [[ "${LAZY_TEAMS_BUILD_RUNNER:-}" == "1" ]]; then
  build_lazy_runner
else
  log "skipping the lazy-runner build: this image does not launch task containers"
  log "(see the 'Task turns' section of public-docs/self-hosting-lazy-teams.md)"
fi

if [[ "${1:-}" == "./bin/thrust" && "${2:-}" == "./bin/rails" && "${3:-}" == "server" ]]; then
  log "preparing database"
  gosu rails ./bin/rails db:prepare
fi

exec gosu rails "$@"
