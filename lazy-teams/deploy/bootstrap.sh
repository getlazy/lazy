#!/usr/bin/env bash
# One-command bootstrap for a single-box Lazy Teams install.
#
# Run from the deploy directory inside a git checkout or release tarball:
#
#   cd lazy-teams/deploy
#   ./bootstrap.sh
#
# Creates `.env` with generated secrets, checks Docker, and prints the exact
# `docker compose` command to start. The browser setup flow (first admin account)
# takes over once the app is healthy — this script does not create users.
#
# `--env-only` stops after writing `.env`: no Docker checks, no compose
# instructions. That is what the NATIVE install (macOS, no image — see
# public-docs/self-hosting-lazy-teams.md) uses, and it is why secret generation
# lives here rather than being spelled a second time in a native script. The
# four values are the same four either way; only what starts the app differs.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"

fail() { echo "bootstrap: $*" >&2; exit 1; }

ENV_ONLY=0
for arg in "$@"; do
  case "${arg}" in
    --env-only) ENV_ONLY=1 ;;
    *) fail "unknown option ${arg} (only --env-only is understood)" ;;
  esac
done

if [[ "${ENV_ONLY}" == "0" ]]; then
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Engine first."
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    fail "Docker Compose v2 is required (install the docker compose plugin or docker-compose)."
  fi

  [[ -S /var/run/docker.sock ]] || fail "/var/run/docker.sock is missing — is the Docker daemon running?"
fi

rand_hex() { openssl rand -hex "${1}"; }

if [[ -f .env ]]; then
  echo "bootstrap: .env already exists — leaving it in place"
else
  echo "bootstrap: writing .env (edit APP_HOST before enabling TLS)"
  APP_HOST="${APP_HOST:-localhost}"
  SECRET_KEY_BASE="$(rand_hex 64)"
  AR_PRIMARY="$(rand_hex 32)"
  AR_DETERMINISTIC="$(rand_hex 32)"
  AR_SALT="$(rand_hex 32)"

  # TLS is on by default, and the generated file states which posture it picked
  # rather than leaving it implicit. An install reachable only over loopback has
  # no HTTPS to redirect to — and forcing it there would pin HSTS on `localhost`
  # for every other app on the machine. Anything with a real hostname gets the
  # secure default and keeps the admin session cookie off the wire.
  case "${APP_HOST}" in
    localhost | 127.0.0.1) FORCE_SSL="false" ;;
    *) FORCE_SSL="true" ;;
  esac

  # Created empty and locked to the owner BEFORE any secret goes into it — not
  # chmod'ed afterwards, which leaves a window where the file is readable at
  # whatever the process umask happens to be (022 on a stock macOS shell, so
  # world-readable). This file holds SECRET_KEY_BASE and the three encryption
  # keys, and on a native install it is the operator's permanent key store on a
  # personal machine, not a throwaway inside a server's deploy directory.
  : > .env
  chmod 600 .env

  cat > .env <<EOF
APP_HOST=${APP_HOST}
# The image already sets this, so it changes nothing for a compose install. It
# is written here for the NATIVE one, where \`.env\` is the whole of what an
# operator loads into their shell: the runbook's start command passes RAILS_ENV
# inline, which does NOT export it, so anything else run against that install —
# \`bin/native-accept --attach\`, a \`bin/rails runner\` by hand — would default to
# development and read a different sqlite database than the app is serving from.
RAILS_ENV=production
SECRET_KEY_BASE=${SECRET_KEY_BASE}
AR_ENCRYPTION_PRIMARY_KEY=${AR_PRIMARY}
AR_ENCRYPTION_DETERMINISTIC_KEY=${AR_DETERMINISTIC}
AR_ENCRYPTION_KEY_DERIVATION_SALT=${AR_SALT}
APP_DIRECT_PORT=${APP_DIRECT_PORT:-3000}

# TLS posture: true wherever this install is reached over a network, false only
# for a plain-HTTP loopback install. See .env.example.
FORCE_SSL=${FORCE_SSL}

# Put the fleet root — every project's task store, clone and daemon state — in a
# directory on THIS machine instead of inside a Docker volume. Uncomment and
# point it at an absolute path you have created. Needed to hand an existing lazy
# store to this install; see "Adopting an existing store" in the runbook.
# LAZY_FLEET_HOST_PATH=/absolute/path/on/this/host/lazy-fleet
EOF
fi

# shellcheck disable=SC1091
set -a && source .env && set +a

# A STRING, not a bash array. This script runs under `set -u`, and macOS ships
# bash 3.2, where expanding an empty array is an unbound-variable error rather
# than nothing — `bin/native-accept` aborted before its first check on exactly
# that. This file used `missing=()`, `${#missing[@]}` and `${missing[*]}`, and
# the native runbook now makes `./bootstrap.sh --env-only` an operator's FIRST
# step on a Mac, so it is the same hazard in the worst possible place.
#
# Converted rather than investigated: whether bash 3.2 tolerates `${#a[@]}`
# specifically is a question this code no longer has to be right about, and a
# string costs nothing here. `test/config/native_boot_test.rb` covers this file
# alongside the three native scripts.
missing=""
for key in SECRET_KEY_BASE AR_ENCRYPTION_PRIMARY_KEY AR_ENCRYPTION_DETERMINISTIC_KEY AR_ENCRYPTION_KEY_DERIVATION_SALT; do
  [[ -n "${!key:-}" ]] || missing="${missing}${missing:+ }${key}"
done
[[ -z "${missing}" ]] || fail "missing in .env: ${missing} — delete .env and re-run bootstrap"

if [[ "${ENV_ONLY}" == "1" ]]; then
  echo ""
  echo "Secrets written to ${DEPLOY_DIR}/.env."
  echo ""
  echo "  1. Set APP_HOST to the hostname this install is reached at, and"
  echo "     FORCE_SSL=true once there is HTTPS in front of it."
  echo "  2. Load them and start the app natively:"
  echo "       set -a && source ${DEPLOY_DIR}/.env && set +a"
  echo "       cd ${DEPLOY_DIR}/.. && RAILS_ENV=production bin/native-start"
  echo ""
  echo "  KEEP THIS FILE. The three AR_ENCRYPTION_* values decrypt every stored"
  echo "  credential; regenerating them makes the existing ones unreadable."
  echo ""
  exit 0
fi

# AGENT TURNS NEED /dev/kvm. Each project runs in its own microVM, and
# docker-compose.yml passes the device into the app container — which compose
# refuses to start on a host that has none. Decided here, once, and written to
# .env as COMPOSE_FILE so every later `docker compose` command agrees: with no
# device the install runs on the `local` backend (docker-compose.local-backend.yml),
# which is the whole product except agent turns. An operator who adds KVM later
# deletes that line.
#
# Both directions are checked against what .env ALREADY says, because .env is
# never rewritten: a COMPOSE_FILE line left from a host that had no KVM keeps
# pinning `local` after KVM is added, and saying "turns will run" over it
# would be false.
#
# BACKEND_FILES is what an explicit `-f` command must carry too: `-f` replaces
# COMPOSE_FILE outright, so the build command below would otherwise bring the
# /dev/kvm device back on a host that has none, and compose would refuse it.
KVM_NOTE=""
BACKEND_FILES=""
if grep -q '^COMPOSE_FILE=.*docker-compose\.local-backend\.yml' .env; then
  BACKEND_FILES=" -f docker-compose.local-backend.yml"
fi
if [[ -c /dev/kvm && -n "${BACKEND_FILES}" ]]; then
  KVM_NOTE="  /dev/kvm is present, but .env still selects docker-compose.local-backend.yml
  (its COMPOSE_FILE line), so projects run WITHOUT microVMs and agent turns do
  not run. Delete that COMPOSE_FILE line from .env and run this again."
elif [[ -c /dev/kvm ]]; then
  KVM_NOTE="  /dev/kvm found: each project runs in its own microVM, and agent turns run."
elif grep -q '^COMPOSE_FILE=' .env; then
  KVM_NOTE="  No /dev/kvm on this host; .env already sets COMPOSE_FILE (left as it is)."
else
  cat >> .env <<'ENVEOF'

# No /dev/kvm on this host when bootstrap.sh ran: run without microVMs. Agent
# turns need KVM — enable hardware virtualization, delete this line, and
# `docker compose up -d` again. See "Task turns" in the self-hosting guide.
COMPOSE_FILE=docker-compose.yml:docker-compose.local-backend.yml
ENVEOF
  BACKEND_FILES=" -f docker-compose.local-backend.yml"
  KVM_NOTE="  No /dev/kvm on this host: .env now selects docker-compose.local-backend.yml.
  Everything works except agent turns, which need hardware virtualization (KVM)."
fi

echo ""
echo "Lazy Teams bootstrap is ready."
echo ""
echo "  1. Review ${DEPLOY_DIR}/.env — set APP_HOST to your public hostname before TLS,"
echo "     and FORCE_SSL=true once the install is served over HTTPS."
echo "  2. Pull and start the stack:"
echo "       cd ${DEPLOY_DIR}"
echo "       ${COMPOSE_CMD} pull"
echo "       ${COMPOSE_CMD} up -d"
echo ""
echo "     Building from a source checkout instead (developers):"
echo "       ${COMPOSE_CMD} -f docker-compose.yml${BACKEND_FILES} -f docker-compose.build.yml up -d --build"
echo ""
echo "     For automatic HTTPS with Let's Encrypt (ports 80 and 443 on this host):"
echo "       ${COMPOSE_CMD} --profile tls up -d"
echo ""
echo "     The direct port is published on the loopback interface only. Reach it from"
echo "     another machine with: ssh -L ${APP_DIRECT_PORT:-3000}:127.0.0.1:${APP_DIRECT_PORT:-3000} you@this-host"
echo ""
echo "  3. Open http://localhost:${APP_DIRECT_PORT:-3000}/ (or https://\${APP_HOST}/ with TLS)"
echo "     and complete the in-browser setup — first account, team, invitations."
echo ""
echo "  Optional SMTP settings live in .env.example. The install boots without them."
echo ""
echo "${KVM_NOTE}"
echo ""
