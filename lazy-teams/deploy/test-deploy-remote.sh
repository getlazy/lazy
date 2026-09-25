#!/usr/bin/env bash
# Tests for lazy-teams/bin/deploy-remote.
#
#   lazy-teams/deploy/test-deploy-remote.sh
#
# The box is unreachable from here and there is no Docker daemon, so the suite
# covers what can be covered honestly:
#
#   * argument handling and every refusal path
#   * a fake `ssh` on PATH that records the exact argv and the exact script each
#     step would send, and can be told to fail at a chosen step — this drives
#     the real reporting, the real failure output, and the real log dump
#   * the remote helper functions (.env editing, secret masking) executed for
#     real, by sourcing the shipped helper text rather than a copy of it
#
# NOT covered, and not claimed to be: anything that needs a real Docker daemon
# or a real remote host — the apt install, the compose build, the first-boot
# lazy-runner wait, and the acceptance turn.
#
# `cond && ok "x" || bad "x"` is the assertion idiom throughout, and `ok` never
# fails, so the ternary caveat SC2015 warns about cannot bite here.
# shellcheck disable=SC2015
set -uo pipefail

SUITE="test-deploy-remote"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../bin/deploy-remote"

PASS=0
FAIL=0
WORK=""

log()  { echo "${SUITE}: $*"; }
ok()   { PASS=$(( PASS + 1 )); echo "  ok   $*"; }
bad()  { FAIL=$(( FAIL + 1 )); echo "  FAIL $*"; }

cleanup() { [ -n "${WORK}" ] && [ -d "${WORK}" ] && rm -rf "${WORK}"; }
trap cleanup EXIT

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-remote-test.XXXXXX")"

# ─────────────────────────────────────────────────────────────────────────────
# Fake ssh
#
# Records one block per invocation into $LAZY_FAKE_SSH_LOG:
#   ARGV<TAB>...
#   --- script
#   <the heredoc the step sent>
#   --- end
# Fails (exit 7) when the script it receives contains $LAZY_FAKE_SSH_FAIL_ON.
# ─────────────────────────────────────────────────────────────────────────────
FAKE_SSH="${WORK}/bin/ssh"
mkdir -p "${WORK}/bin"
cat > "${FAKE_SSH}" <<'FAKE'
#!/usr/bin/env bash
set -uo pipefail
log="${LAZY_FAKE_SSH_LOG:-/dev/null}"
{
  printf 'ARGV'
  for a in "$@"; do printf '\t%s' "$a"; done
  printf '\n'
} >> "${log}"
script=""
if [ ! -t 0 ]; then script="$(cat || true)"; fi
{
  printf -- '--- script\n%s\n--- end\n' "${script}"
} >> "${log}"

if [ -n "${LAZY_FAKE_SSH_FAIL_ON:-}" ] && printf '%s' "${script}" | grep -q -- "${LAZY_FAKE_SSH_FAIL_ON}"; then
  echo "fake-ssh: simulated remote failure"
  echo "fake-ssh: stderr line" >&2
  exit 7
fi
[ -n "${LAZY_FAKE_SSH_STDOUT:-}" ] && printf '%s\n' "${LAZY_FAKE_SSH_STDOUT}"
exit 0
FAKE
chmod +x "${FAKE_SSH}"

# run_deploy <logfile> [args...]  → stdout+stderr on stdout, exit code in RC
RC=0
run_deploy() {
  local logfile="$1"; shift
  : > "${logfile}"
  local out rc
  out="$(LAZY_FAKE_SSH_LOG="${logfile}" "${SCRIPT}" "$@" 2>&1)"
  rc=$?
  printf '%s' "${out}"
  # run_deploy is always called inside a command substitution, so RC set here
  # would be lost with the subshell — the exit code rides back as our own.
  return "${rc}"
}

assert_contains() {
  local haystack="$1" needle="$2" what="$3"
  if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
    ok "${what}"
  else
    bad "${what}"
    printf '%s\n' "${haystack}" | sed 's/^/       | /' | head -40
  fi
}

assert_missing() {
  local haystack="$1" needle="$2" what="$3"
  if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
    bad "${what}"
    printf '%s\n' "${haystack}" | grep -nF -- "${needle}" | sed 's/^/       | /' | head -10
  else
    ok "${what}"
  fi
}

assert_rc() {
  local want="$1" what="$2"
  if [ "${RC}" = "${want}" ]; then ok "${what}"; else bad "${what} (exit ${RC}, wanted ${want})"; fi
}

# ─────────────────────────────────────────────────────────────────────────────
log "1. argument handling"
# ─────────────────────────────────────────────────────────────────────────────

out="$(run_deploy "${WORK}/l" --help)"; RC=$?
assert_rc 0 "--help exits 0"
assert_contains "${out}" "--diagnose" "--help lists --diagnose"
assert_contains "${out}" "--teardown" "--help lists --teardown"
assert_contains "${out}" "LAZY_DEPLOY_TIMEOUT" "--help documents the timeout env var"

out="$(run_deploy "${WORK}/l")"; RC=$?
assert_rc 1 "no target fails"
assert_contains "${out}" "no target given" "no target names the problem"

out="$(run_deploy "${WORK}/l" root@box --source nfs)"; RC=$?
assert_rc 1 "bogus --source fails"
assert_contains "${out}" "--source must be" "bogus --source explains the allowed values"

out="$(run_deploy "${WORK}/l" root@box --port http)"; RC=$?
assert_rc 1 "non-numeric --port fails"

out="$(run_deploy "${WORK}/l" root@box --frobnicate)"; RC=$?
assert_rc 1 "unknown flag fails"
assert_contains "${out}" "unknown option" "unknown flag is named"

out="$(run_deploy "${WORK}/l" root@box --diagnose --accept-only)"; RC=$?
assert_rc 1 "--accept-only refuses to combine with --diagnose"

out="$(run_deploy "${WORK}/l" root@a root@b)"; RC=$?
assert_rc 1 "two targets are refused"

# ─────────────────────────────────────────────────────────────────────────────
log "2. --dry-run prints the plan and contacts nothing"
# ─────────────────────────────────────────────────────────────────────────────

export PATH="${WORK}/bin:${PATH}"
out="$(run_deploy "${WORK}/dry.log" root@box.example --dry-run --repo git@example.invalid:x/y.git)"; RC=$?
assert_rc 0 "--dry-run exits 0"
assert_contains "${out}" "preflight-remote" "dry run shows the remote preflight step"
assert_contains "${out}" "ship-source" "dry run shows the source step"
assert_contains "${out}" "configure-env" "dry run shows the env step"
assert_contains "${out}" "compose-up" "dry run shows the compose step"
assert_contains "${out}" "wait-healthy" "dry run shows the health wait"
assert_contains "${out}" "accept-task-turn" "dry run shows the acceptance turn"
assert_contains "${out}" "up -d --build" "dry run shows the actual compose command"
assert_contains "${out}" "download.docker.com" "dry run shows the official apt repo, not curl|sh"
assert_missing  "${out}" "curl -fsSL https://get.docker.com" "dry run never pipes get.docker.com to a shell"
if [ -s "${WORK}/dry.log" ]; then
  bad "--dry-run made no ssh calls"
else
  ok "--dry-run made no ssh calls"
fi

out="$(run_deploy "${WORK}/dry2.log" root@box.example --dry-run --diagnose)"; RC=$?
assert_rc 0 "--diagnose --dry-run exits 0"
assert_contains "${out}" "mask_env_file" "diagnose plan masks .env values"
assert_missing  "${out}" "up -d" "diagnose plan starts nothing"
assert_missing  "${out}" "down -v" "diagnose plan removes nothing"

# ─────────────────────────────────────────────────────────────────────────────
log "3. local preflight"
# ─────────────────────────────────────────────────────────────────────────────

# ssh that refuses the reachability probe
cat > "${WORK}/bin/ssh-dead" <<'DEAD'
#!/usr/bin/env bash
exit 255
DEAD
chmod +x "${WORK}/bin/ssh-dead"
out="$(LAZY_DEPLOY_SSH="${WORK}/bin/ssh-dead" "${SCRIPT}" root@box --repo git@x:y.git 2>&1)"; RC=$?
assert_rc 1 "unreachable box fails at local preflight"
assert_contains "${out}" "cannot ssh to root@box" "unreachable box names the target"
assert_contains "${out}" "ssh-add -l" "unreachable box gives an actionable remedy"

out="$(LAZY_DEPLOY_SSH="${WORK}/bin/definitely-not-here" "${SCRIPT}" root@box 2>&1)"; RC=$?
assert_rc 1 "a missing ssh binary fails loudly"
assert_contains "${out}" "ssh not found" "missing ssh is named"

# ─────────────────────────────────────────────────────────────────────────────
log "4. ssh invocation contract"
# ─────────────────────────────────────────────────────────────────────────────

out="$(run_deploy "${WORK}/ok.log" root@box.example --repo git@example.invalid:x/y.git)"; RC=$?
sshlog="$(cat "${WORK}/ok.log")"
assert_rc 0 "a fully-succeeding run exits 0"
assert_contains "${sshlog}" "BatchMode=yes" "every ssh call is non-interactive"
assert_contains "${sshlog}" "StrictHostKeyChecking=accept-new" "host key policy is set explicitly"

# Agent forwarding is used for the source fetch and nowhere else: it is the
# user's live agent, and no other step has any business holding it.
forward_lines="$(printf '%s' "${sshlog}" | grep -c $'ARGV.*\t-A\t' || true)"
if [ "${forward_lines}" = "1" ]; then
  ok "agent forwarding is used by exactly one step"
else
  bad "agent forwarding used by ${forward_lines} step(s), expected 1"
fi
# ...and that one step is the source fetch.
if printf '%s' "${sshlog}" | sed -n "/$(printf '\t')-A$(printf '\t')/,/^--- end$/p" | grep -q 'git clone'; then
  ok "the forwarded-agent step is the source fetch"
else
  bad "the forwarded-agent step is not the source fetch"
fi

assert_contains "${out}" "PASS" "a successful run reports passes"
assert_contains "${out}" "ssh -L 3000:127.0.0.1:3000" "a successful run tells the engineer how to reach it"

# ─────────────────────────────────────────────────────────────────────────────
log "5. failure reporting"
# ─────────────────────────────────────────────────────────────────────────────

out="$(LAZY_FAKE_SSH_FAIL_ON='up -d --build' run_deploy "${WORK}/fail.log" root@box.example --repo git@x:y.git)"; RC=$?
assert_rc 1 "a failing compose-up exits non-zero"
assert_contains "${out}" "step failed: compose-up" "the failing step is named"
assert_contains "${out}" "fake-ssh: simulated remote failure" "the remote output is shown"
assert_contains "${out}" "stderr line" "remote stderr is captured too"
assert_contains "${out}" "Container logs from the box" "container logs are pulled after a post-up failure"
assert_contains "${out}" "FAIL" "the report marks the step failed"
if printf '%s' "$(cat "${WORK}/fail.log")" | grep -q 'logs --tail 200'; then
  ok "the log dump asks for 200 lines"
else
  bad "the log dump asks for 200 lines"
fi

out="$(LAZY_FAKE_SSH_FAIL_ON='os-release' run_deploy "${WORK}/fail2.log" root@box.example --repo git@x:y.git)"; RC=$?
assert_rc 1 "a failing remote preflight exits non-zero"
assert_contains "${out}" "step failed: preflight-remote" "the failing preflight is named"
assert_missing  "${out}" "Container logs from the box" "no log dump before anything was started"

out="$(LAZY_FAKE_SSH_FAIL_ON='git clone' run_deploy "${WORK}/fail3.log" root@box.example --repo git@x:y.git)"; RC=$?
assert_rc 1 "a failing source fetch exits non-zero"
assert_contains "${out}" "--source rsync" "a failed fetch suggests the credential-free fallback"

out="$(LAZY_FAKE_SSH_FAIL_ON='waiting for /up' run_deploy "${WORK}/fail4.log" root@box.example --repo git@x:y.git)"; RC=$?
assert_rc 1 "a failing health wait exits non-zero"
assert_contains "${out}" "do not restart the stack" "a health-wait failure warns against restarting mid-build"

# ─────────────────────────────────────────────────────────────────────────────
log "6. teardown is guarded"
# ─────────────────────────────────────────────────────────────────────────────

out="$(printf 'yes\n' | LAZY_FAKE_SSH_LOG="${WORK}/td1.log" "${SCRIPT}" root@box.example --teardown 2>&1)"; RC=$?
assert_rc 1 "teardown refuses anything but the confirmation word"
assert_contains "${out}" "not confirmed" "a refused teardown says so"
assert_contains "${out}" "Nothing was changed" "a refused teardown states nothing changed"
if grep -q 'down -v' "${WORK}/td1.log" 2>/dev/null; then
  bad "a refused teardown sent no destructive command"
else
  ok "a refused teardown sent no destructive command"
fi

out="$(printf 'destroy\n' | LAZY_FAKE_SSH_LOG="${WORK}/td2.log" "${SCRIPT}" root@box.example --teardown 2>&1)"; RC=$?
assert_rc 0 "teardown proceeds on the confirmation word"
if grep -q 'down -v --remove-orphans' "${WORK}/td2.log"; then
  ok "confirmed teardown removes containers and volumes"
else
  bad "confirmed teardown removes containers and volumes"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "7. remote helpers, executed for real"
# ─────────────────────────────────────────────────────────────────────────────

# Source the script (its main() is guarded) and eval the shipped helper text, so
# these tests exercise the bytes that are actually sent to the box.
# shellcheck source=/dev/null
. "${SCRIPT}"
eval "${REMOTE_HELPERS}"

envfile="${WORK}/.env"
cat > "${envfile}" <<'ENV'
# generated by bootstrap.sh
APP_HOST=localhost
SECRET_KEY_BASE=b1946ac92492d2347c6235b4d2611184deadbeefdeadbeefdeadbeefdeadbeef
AR_ENCRYPTION_PRIMARY_KEY=supersecretprimarykey
APP_DIRECT_PORT=3000
FORCE_SSL=false

# trailing comment
ENV
chmod 600 "${envfile}"
before_secret="$(env_get "${envfile}" SECRET_KEY_BASE)"

env_set "${envfile}" APP_HOST "teams.example.com"
env_set "${envfile}" APP_DIRECT_BIND "127.0.0.1"

[ "$(env_get "${envfile}" APP_HOST)" = "teams.example.com" ] \
  && ok "env_set replaces an existing key" || bad "env_set replaces an existing key"
[ "$(env_get "${envfile}" APP_DIRECT_BIND)" = "127.0.0.1" ] \
  && ok "env_set appends a new key" || bad "env_set appends a new key"
[ "$(env_get "${envfile}" SECRET_KEY_BASE)" = "${before_secret}" ] \
  && ok "env_set leaves other keys untouched" || bad "env_set leaves other keys untouched"
grep -q '^# generated by bootstrap.sh$' "${envfile}" \
  && ok "env_set preserves comments" || bad "env_set preserves comments"
[ "$(grep -c '^APP_HOST=' "${envfile}")" = "1" ] \
  && ok "env_set never duplicates a key" || bad "env_set never duplicates a key"
mode="$(stat -c '%a' "${envfile}" 2>/dev/null || stat -f '%Lp' "${envfile}")"
[ "${mode}" = "600" ] \
  && ok "env_set keeps .env owner-only" || bad "env_set keeps .env owner-only (mode ${mode})"

masked="$(mask_env_file "${envfile}")"
assert_missing "${masked}" "${before_secret}" "masking never prints SECRET_KEY_BASE"
assert_missing "${masked}" "supersecretprimarykey" "masking never prints the encryption key"
assert_contains "${masked}" "SECRET_KEY_BASE=(set, 64 chars)" "masking reports a secret as present"
assert_contains "${masked}" "APP_HOST=teams.example.com" "masking keeps non-secret values readable"
assert_contains "${masked}" "FORCE_SSL=false" "masking keeps FORCE_SSL readable"

env_public_key APP_HOST && ok "APP_HOST is public" || bad "APP_HOST is public"
env_public_key SECRET_KEY_BASE && bad "SECRET_KEY_BASE must not be public" || ok "SECRET_KEY_BASE is not public"
env_public_key SMTP_PASSWORD && bad "SMTP_PASSWORD must not be public" || ok "SMTP_PASSWORD is not public"
env_public_key SOME_FUTURE_TOKEN && bad "unknown keys must default to masked" || ok "unknown keys default to masked"

missing="$(mask_env_file "${WORK}/nope.env")"
assert_contains "${missing}" "no .env" "masking a missing file says so instead of failing"

# env_set on a file that does not exist creates it owner-only.
fresh="${WORK}/fresh.env"
env_set "${fresh}" APP_HOST box.local
mode="$(stat -c '%a' "${fresh}" 2>/dev/null || stat -f '%Lp' "${fresh}")"
[ "${mode}" = "600" ] && ok "a created .env is owner-only" || bad "a created .env is owner-only (mode ${mode})"

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${FAIL}" -gt 0 ]; then
  log "FAILED — ${PASS} passed, ${FAIL} failed"
  exit 1
fi
log "OK — ${PASS} passed"
