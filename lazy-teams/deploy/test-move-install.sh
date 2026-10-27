#!/usr/bin/env bash
# Tests for lazy-teams/bin/move-install.
#
#   lazy-teams/deploy/test-move-install.sh
#
# No box, no Docker, no Mac install here, so every outside command is a fake
# that records its argv (and stdin): ssh, rsync, bin/kamal, bin/native-rails,
# sqlite3, curl. That drives the real argument handling, refusals, step order,
# report and secret masking.
#
# NOT covered, and not claimed to be: anything that needs the real box, a real
# Kamal deploy, Docker builds, ngrok, or a real Mac install.
#
# shellcheck disable=SC2015
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../bin/move-install"
PASS=0
FAIL=0
ok()  { PASS=$(( PASS + 1 )); echo "  ok   $*"; }
bad() { FAIL=$(( FAIL + 1 )); echo "  FAIL $*"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/move-install-test.XXXXXX")"
# macOS TMPDIR ends in "/": take the spelling `cd && pwd` gives, as the script does.
WORK="$(cd "${WORK}" && pwd)"
trap 'rm -rf "${WORK}"' EXIT
LOG="${WORK}/calls.log"
mkdir -p "${WORK}/bin"

# One fake for every command: logs "<name> <argv>" and its stdin, answers per
# FAKE_<NAME>_OUT, fails when its argv contains FAKE_FAIL_ON.
fake() {
  cat > "${WORK}/bin/$1" <<FAKE
#!/usr/bin/env bash
name="$1"
{ printf '%s' "\${name}"; for a in "\$@"; do printf ' %s' "\$a"; done; echo; } >> "${LOG}"
case "\${name} \$*" in
  ssh*"cat /srv/lazy-teams/secrets/deploy.env"*) cat "\${FAKE_DEPLOY_ENV}"; exit 0 ;;
  ssh*"docker inspect"*"lazy_teams-ngrok"*) [ -n "\${FAKE_BOX_NGROK_ENV:-}" ] && cat "\${FAKE_BOX_NGROK_ENV}"; exit 0 ;;
  ssh*"cat /srv/lazy-teams/ngrok/ngrok.yml") [ -n "\${FAKE_BOX_NGROK_YML:-}" ] && cat "\${FAKE_BOX_NGROK_YML}"; exit 0 ;;
  ssh*"cat /srv/lazy-teams/secrets/cli-jwt.pem"*) printf '%s\n' "-----BEGIN PRIVATE KEY-----" "private-key-body-0123456789abcdef" "-----END PRIVATE KEY-----"; exit 0 ;;
esac
if [ "\${name}" = kamal ]; then
  echo "\${LAZY_TEAMS_BOX_USER:-unset}" >> "${LOG}.users"
  for v in AR_ENCRYPTION_PRIMARY_KEY AR_ENCRYPTION_DETERMINISTIC_KEY TRUSTED_PROXY_SECRET UNRELATED_BOX_KEY; do
    printf '%s=%s\n' "\${v}" "\${!v-<unset>}" >> "${LOG}.kamal-env"
  done
fi
# Check while the deploy process is still running, before its EXIT cleanup.
if [ -n "\${FAKE_DEPLOY_TMP:-}" ]; then
  echo checked >> "${LOG}.memory-checks"
  for secret in "\${SECRET_KEY_BASE:-}" "\${TRUSTED_PROXY_SECRET:-}" "\${CLI_JWT_PRIVATE_KEY:-}"; do
    [ -n "\${secret}" ] || continue
    if grep -rlF -- "\${secret}" "\${FAKE_DEPLOY_TMP}" >/dev/null; then
      echo "secret persisted locally" >> "${LOG}.persisted"
    fi
  done
fi
# This file represents the remote ngrok destination, outside deploy scratch.
case "\${name} \$*" in
  ssh*"cat > /srv/lazy-teams/ngrok/ngrok.yml.part"*)
    case "\$*" in *"\${FAKE_FAIL_ON:-@@never@@}"*) echo "fake upload failure"; exit 7 ;; esac
    cat > "${WORK}/shipped-ngrok.yml"; exit 0 ;;
esac
# A box whose fleet is a copy of FAKE_BOX_FLEET answers the fingerprint script.
if [ "\${name}" = ssh ] && [ -n "\${FAKE_BOX_FLEET:-}" ]; then
  case "\$*" in *"bash -s"*) cd "\${FAKE_BOX_FLEET}" && exec bash -s ;; esac
fi
[ -t 0 ] || { [ "\${name}" = ssh ] && cat >> "${LOG}.stdin"; }
case "\$*" in *"\${FAKE_FAIL_ON:-@@never@@}"*) echo "fake \${name} failing as asked"; exit 7 ;; esac
var="FAKE_\$(echo "\${name}" | tr 'a-z-' 'A-Z_')_OUT"
[ -n "\${!var:-}" ] && printf '%s\n' "\${!var}"
# Keep the ngrok config rsync would ship, so the suite can read it. Refuse
# --chmod the way macOS's rsync (openrsync) does, and record each shipped
# secret's mode.
if [ "\${name}" = rsync ]; then
  for a in "\$@"; do case "\$a" in --chmod*) echo "rsync: \$a: invalid argument"; exit 1 ;; esac; done
  for a in "\$@"; do case "\$a" in /*/ngrok.yml) cp "\$a" "${WORK}/shipped-ngrok.yml" ;; esac; done
  for a in "\$@"; do case "\$a" in /*/ship/deploy.env) cp "\$a" "${WORK}/shipped-deploy.env" ;; esac; done
  for a in "\$@"; do case "\$a" in /*/ship/*) echo "\$(basename "\$a") \$(stat -c %a "\$a" 2>/dev/null || stat -f %Lp "\$a")" >> "${LOG}.modes" ;; esac; done
fi
case "\${name} \$*" in
  *"lazy:move:inventory"*) echo '{"users":2,"teams":1,"projects":3,"fleet_root":"/x","project_list":[]}' ;;
  *"lazy:move:adopted_stores"*) echo "\${FAKE_ADOPTED:-[]}" ;;
  *"teams:proxy_policy"*) echo "INFO kamal says hi"; cat "${WORK}/teams-policy.yml" ;;
  curl*) echo "\${FAKE_CURL_CODE:-302 https://accounts.google.com/o/oauth2}" ;;
  ssh*X-Lazy-Auth-Email*) echo "\${FAKE_PROXY_CODE:-403 }" ;;
  *"echo leak"*) echo "leaking \${SECRET_KEY_BASE:-}" ;;
esac
exit 0
FAKE
  chmod +x "${WORK}/bin/$1"
}
for c in ssh rsync kamal native-rails sqlite3 curl; do fake "$c"; done
# The shape of `teams:proxy_policy`: CLI tokens are checked by ngrok, every
# other request signs in, and the identity is handed on with the secret.
cat > "${WORK}/teams-policy.yml" <<'YML'
on_http_request:
  - expressions: ["req.url.path.startsWith('/api/') && 'authorization' in req.headers"]
    actions: [{ type: jwt-validation, config: { issuer: { allow_list: [{ value: "https://x" }] } } }]
  - expressions: ["!(req.url.path.startsWith('/api/') && 'authorization' in req.headers)"]
    actions: [{ type: oauth, config: { provider: google } }]
  - actions:
      - type: add-headers
        config: { headers: { X-Lazy-Proxy-Secret: "the value of TRUSTED_PROXY_SECRET" } }
YML

ENV_FILE="${WORK}/mac/deploy.env"
mkdir -p "${WORK}/mac/fleet/projects/p1/store" "${WORK}/mac/storage"
echo data > "${WORK}/mac/fleet/projects/p1/store/t.json"
: > "${WORK}/mac/storage/production.sqlite3"
echo "-----BEGIN PRIVATE KEY-----" > "${WORK}/mac/cli-jwt.pem"
SKB="skb-$(printf 'a%.0s' $(seq 1 40))"
cat > "${ENV_FILE}" <<EOF
SECRET_KEY_BASE=${SKB}
AR_ENCRYPTION_PRIMARY_KEY=arp-0123456789abcdef
AR_ENCRYPTION_DETERMINISTIC_KEY=ard-0123456789abcdef
AR_ENCRYPTION_KEY_DERIVATION_SALT=ars-0123456789abcdef
TRUSTED_PROXY_SECRET=tps-0123456789abcdef
LAZY_FLEET_ROOT=${WORK}/mac/fleet
LAZY_TEAMS_STORAGE_DIR=${WORK}/mac/storage
TEAMS_ALLOWED_EMAILS=me@example.com
TEAMS_JWKS_URL=https://keys.example.com/.well-known/lazy-cli-jwks.json
CLI_JWT_PRIVATE_KEY_FILE=cli-jwt.pem
APP_HOST=r.getlazy.dev
EOF

run() {
  : > "${LOG}"; : > "${LOG}.stdin"
  PATH="${WORK}/bin:${PATH}" NGROK_AUTHTOKEN="ngk-0123456789abcdef" \
    LAZY_MOVE_CARRY_DIR="${WORK}/carry" LAZY_MOVE_KAMAL="${WORK}/bin/kamal" LAZY_MOVE_NATIVE_RAILS="${WORK}/bin/native-rails" \
    "${SCRIPT}" root@box.test --env-file "${ENV_FILE}" --report "${WORK}/report.md" "$@" > "${WORK}/out" 2>&1
}
secrets_absent() {
  local f s
  [ -s "${WORK}/report.md" ] || { bad "$1: no report written"; return; }
  for f in "${WORK}/out" "${WORK}/report.md"; do
    for s in "${SKB}" arp-0123456789abcdef tps-0123456789abcdef ngk-0123456789abcdef; do
      grep -qF -- "$s" "$f" && { bad "$1: a secret appears in $(basename "$f")"; return; }
    done
  done
  ok "$1: no secret in the output or the report"
}

echo "the Kamal destination loads"
# INVARIANT: config/deploy.hetzner.yml is valid for the Kamal this app pins,
# with ngrok under `accessories:`. Every fake below stands in for kamal, so
# without this a broken config is first seen on the real box.
if (cd "${HERE}/.." && command -v bundle >/dev/null && bundle exec kamal version >/dev/null 2>&1); then
  kamal_out="$(cd "${HERE}/.." && LAZY_TEAMS_BOX_HOST=192.0.2.1 LAZY_TEAMS_APP_HOST=teams.r.getlazy.dev \
    LAZY_TEAMS_SERVICES_HOST=r.getlazy.dev LAZY_TEAMS_BUILD_TAG=abc bin/kamal config -d hetzner 2>&1)"
  printf '%s\n' "${kamal_out}" | grep -q '^:accessories:' && printf '%s\n' "${kamal_out}" | grep -q '^  ngrok:' &&
    ok "kamal config -d hetzner loads, ngrok an accessory" || bad "kamal config -d hetzner: $(printf '%s\n' "${kamal_out}" | tail -3)"
  # INVARIANT: Kamal and direct SSH use the same requested account; an update
  # must not switch to root after preflight succeeded as another user.
  ssh_user="$(cd "${HERE}/.." && LAZY_TEAMS_BOX_HOST=192.0.2.1 LAZY_TEAMS_BOX_USER=deployer \
    LAZY_TEAMS_APP_HOST=teams.example.com LAZY_TEAMS_SERVICES_HOST=example.com LAZY_TEAMS_BUILD_TAG=abc \
    bundle exec ruby -rkamal -e 'config = Kamal::Configuration.create_from(config_file: Pathname.new("config/deploy.yml"), destination: "hetzner"); puts config.ssh.user')"
  [ "${ssh_user}" = deployer ] && ok "real Kamal configuration uses the requested SSH user" || bad "Kamal SSH user: ${ssh_user}"
  # INVARIANT: smolvm's registry and machine disks are host binds. In the
  # container they go with it on every deploy, and with them every worktree.
  printf '%s\n' "${kamal_out}" | grep -q '/srv/lazy-teams/home/local:/home/rails/.local' &&
    printf '%s\n' "${kamal_out}" | grep -q '/srv/lazy-teams/home/cache:/home/rails/.cache' &&
    ok "smolvm's registry and machine disks outlive the container" || bad "smolvm binds missing"
else
  echo "  skip kamal config check: no bundle with kamal here (run bundle install in lazy-teams/)"
fi

echo "arguments"
"${SCRIPT}" > /dev/null 2>&1; [ $? -eq 2 ] && ok "no box is a usage error" || bad "no box"
"${SCRIPT}" box.test > /dev/null 2>&1; [ $? -eq 2 ] && ok "a box without user@ is refused" || bad "user@"
"${SCRIPT}" root@b --only nope > /dev/null 2>&1; [ $? -eq 2 ] && ok "an unknown step is refused" || bad "unknown step"

echo "preflight refuses a Mac env file missing a key"
cp "${ENV_FILE}" "${ENV_FILE}.full"
grep -v AR_ENCRYPTION_PRIMARY_KEY "${ENV_FILE}.full" > "${ENV_FILE}"
run; rc=$?
[ "${rc}" -ne 0 ] && grep -q "has no AR_ENCRYPTION_PRIMARY_KEY" "${WORK}/out" && ok "named the missing key" || bad "missing key: $(tail -5 "${WORK}/out")"
grep -q "^rsync" "${LOG}" && bad "copied after a failed preflight" || ok "nothing copied after a failed preflight"
grep -q "| preflight | FAIL" "${WORK}/report.md" && ok "the report records the failure" || bad "report"
cp "${ENV_FILE}.full" "${ENV_FILE}"

echo "dry run"
run --dry-run; rc=$?
[ "${rc}" -eq 0 ] && ok "a dry run passes" || bad "dry run rc=${rc}: $(tail -5 "${WORK}/out")"
grep -qE "^(rsync|kamal|sqlite3)" "${LOG}" && bad "dry run executed a command: $(grep -E '^(rsync|kamal|sqlite3)' "${LOG}" | head -2)" || ok "dry run executed no copy, kamal or sqlite"
for s in preflight build copy deploy settle ngrok verify; do
  grep -q "| ${s} | PASS" "${WORK}/report.md" || bad "dry run: no ${s} in the summary"
done
ok "dry run: every step in the summary"
secrets_absent "dry run"

echo "copy (fakes)"
run --only copy; rc=$?
[ "${rc}" -eq 0 ] && ok "copy passes" || bad "copy rc=${rc}: $(tail -8 "${WORK}/out")"
grep -q "^sqlite3 ${WORK}/mac/storage/production.sqlite3 .backup" "${LOG}" && ok "databases read with sqlite3 .backup" || bad "no .backup"
grep -q "^rsync .*--exclude /deploy.env .*${WORK}/mac/fleet/ root@box.test:/srv/lazy-teams/fleet/" "${LOG}" && ok "fleet root copied, env file excluded" || bad "fleet rsync: $(grep ^rsync "${LOG}")"
grep -q "^rsync -a .*/ship/deploy.env root@box.test:/srv/lazy-teams/secrets/deploy.env" "${LOG}" && grep -qx "deploy.env 600" "${LOG}.modes" && ok "env file lands in the secrets root, mode 600" || bad "secrets rsync: $(grep secrets/deploy.env "${LOG}") $(cat "${LOG}.modes" 2>/dev/null)"
grep -q "chown -R 1000:1000" "${LOG}" && ok "ownership handed to the app's uid" || bad "chown"
grep -q "^kamal app stop -d hetzner" "${LOG}" && ok "the box app is stopped before its database is replaced" || bad "app stop"
[ "$(cat "${WORK}/mac/fleet/projects/p1/store/t.json")" = data ] && ok "the Mac's files are untouched" || bad "Mac modified"
grep -q "export_clones" "${LOG}" && bad "a non-final copy stopped the Mac's daemons" || ok "a non-final copy stops nothing on the Mac"

echo "adopted stores go into the fleet layout"
FAKE_ADOPTED='[{"id":4,"fleet_project_id":"p4","store_path":"/Users/me/adopted"}]' run --only copy
grep -q "^rsync -a --delete /Users/me/adopted/ root@box.test:/srv/lazy-teams/fleet/projects/p4/store/" "${LOG}" && ok "adopted store copied to projects/<id>/store" || bad "adopted: $(grep ^rsync "${LOG}")"

echo "the box's deploy.env carries what deploy needs"
mkdir -p "${WORK}/ngrok-home/.config/ngrok"
printf 'version: 2\nauthtoken: ngk-0123456789abcdef\n' > "${WORK}/ngrok-home/.config/ngrok/ngrok.yml"
{ grep -v '^TEAMS_JWKS_URL=' "${ENV_FILE}"; echo "NGROK_AUTHTOKEN="; } > "${WORK}/mac/deploy-nokeys.env"
: > "${LOG}"; rm -f "${WORK}/shipped-deploy.env" "${LOG}.modes"
PATH="${WORK}/bin:${PATH}" HOME="${WORK}/ngrok-home" NGROK_AUTHTOKEN= \
  LAZY_MOVE_CARRY_DIR="${WORK}/carry" LAZY_MOVE_KAMAL="${WORK}/bin/kamal" LAZY_MOVE_NATIVE_RAILS="${WORK}/bin/native-rails" \
  "${SCRIPT}" root@box.test --env-file "${WORK}/mac/deploy-nokeys.env" --jwks-url https://keys.example.com/jwks.json \
  --report "${WORK}/report.md" --only copy > "${WORK}/out" 2>&1; rc=$?
[ "${rc}" -eq 0 ] && grep -qxF "NGROK_AUTHTOKEN='ngk-0123456789abcdef'" "${WORK}/shipped-deploy.env" &&
  grep -qxF "TEAMS_JWKS_URL='https://keys.example.com/jwks.json'" "${WORK}/shipped-deploy.env" &&
  [ "$(grep -c '^TEAMS_ALLOWED_EMAILS=' "${WORK}/shipped-deploy.env")" = 1 ] &&
  grep -qx "deploy.env 600" "${LOG}.modes" &&
  ok "a token from the ngrok config and a flag-given JWKS URL ship in deploy.env, mode 600" || bad "shipped env: rc=${rc} $(tail -5 "${WORK}/out")"
grep -q "added NGROK_AUTHTOKEN" "${WORK}/out" && ok "the added key is named" || bad "not named"
secrets_absent "staged deploy.env"
grep -q "NGROK_AUTHTOKEN=." "${WORK}/mac/deploy-nokeys.env" && bad "the Mac env file was modified" || ok "the Mac env file is untouched"

echo "final copy asks before stopping anything"
echo "no" | run --only copy --final; rc=$?
[ "${rc}" -ne 0 ] && ! grep -q "export_clones\|^rsync" "${LOG}" && ok "unconfirmed: nothing exported or copied" || bad "final unconfirmed"
echo "STOP" | FAKE_BOX_FLEET="${WORK}/mac/fleet" run --only copy,settle --final; rc=$?
[ "${rc}" -eq 0 ] && ok "final copy: identical stores pass" || bad "final rc=${rc}: $(tail -5 "${WORK}/out")"
grep -q "store projects/p1/store files=1 tasks=0" "${WORK}/report.md" && ok "store fingerprints in the report" || bad "fingerprint"
grep -q "^rsync .*--exclude .storage-lock .*--exclude /move-carry" "${LOG}" && ok "store locks and the carry are not swept by the fleet copy" || bad "excludes"
grep -q "^rsync -a --delete ${WORK}/carry/ root@box.test:/srv/lazy-teams/fleet/move-carry/" "${LOG}" && ok "the carry travels separately" || bad "carry rsync"
grep -q "lazy:move:hold_projects" "${LOG}" && bad "final run held projects" || ok "a final run does not hold projects"
grep -q "lazy:move:export_clones DIR=${WORK}/carry" "${LOG}" && ok "confirmed: clones exported" || bad "export"
grep -q "lazy:move:import_clones" "${LOG}" && ok "settle imports the clones on a final run" || bad "import"

echo "final copy refuses differing stores"
echo "STOP" | run --only copy --final; rc=$?
[ "${rc}" -ne 0 ] && grep -q "DIFFER after the final copy" "${WORK}/out" && ok "a final copy that differs fails" || bad "differ"

echo "settle and verify"
run --only settle,verify; rc=$?
grep -q "^kamal app exec --version=[0-9a-f]* bin/rails lazy:move:settle_stores -d hetzner" "${LOG}" && ok "settle_stores runs in a fresh container of this build" || bad "settle: $(grep settle "${LOG}")"
grep -- "--reuse" "${LOG}" | grep -q -e settle_stores -e refresh_hosted -e hold_projects -e import_clones -e db:prepare && bad "a write ran through docker exec (--reuse)" || ok "nothing writes through --reuse"
grep -q "lazy:move:hold_projects" "${LOG}" && ok "a rehearsal holds the box projects stopped" || bad "hold"
# INVARIANT: settle ships Kamal's role env file before its first `app exec`.
# Only `kamal app boot` uploads it, and settle runs before the first deploy.
first_exec="$(grep -n "^kamal app exec" "${LOG}" | head -1 | cut -d: -f1)"
env_ship="$(grep -n "^rsync -a .*/ship/web.env root@box.test:.kamal/apps/lazy_teams-hetzner/env/roles/web.env" "${LOG}" | head -1 | cut -d: -f1)"
[ -n "${env_ship}" ] && [ "${env_ship}" -lt "${first_exec:-0}" ] && grep -qx "web.env 600" "${LOG}.modes" &&
  ok "the app env file is on the box, mode 600, before the first exec" || bad "env file: $(grep web.env "${LOG}")"
net="$(grep -n "docker network create kamal" "${LOG}" | head -1 | cut -d: -f1)"
[ -n "${net}" ] && [ "${net}" -lt "${first_exec:-0}" ] && ok "the kamal network exists before the first exec" || bad "network: $(grep -n network "${LOG}")"
own="$(grep -n "chown -R 1000:1000 /srv/lazy-teams/home" "${LOG}" | head -1 | cut -d: -f1)"
[ -n "${own}" ] && [ "${own}" -lt "${first_exec:-0}" ] && ok "the app home binds exist, owned by rails, before the first exec" || bad "smolvm dirs: $(grep -n smolvm "${LOG}")"
grep -q "users: 2 on both" "${WORK}/out" && ok "counts compared" || bad "counts: $(tail -5 "${WORK}/out")"
grep -q "ngrok gates https://teams.r.getlazy.dev" "${WORK}/out" && ok "ngrok re-test: Teams gated" || bad "ngrok teams"
grep -q "Manual checks" "${WORK}/report.md" && ok "the browser checks are in the report" || bad "manual"
grep -q "| proxy secret | PASS | refused (403) |" "${WORK}/report.md" && ok "a request that skipped ngrok is refused" || bad "proxy: $(grep "proxy secret" "${WORK}/report.md")"
FAKE_PROXY_CODE="200 " run --only verify; rc=$?
[ "${rc}" -ne 0 ] && grep -q "expected Teams to refuse it" "${WORK}/out" && ok "a forged identity that is let in fails verify" || bad "forged identity"
FAKE_CURL_CODE="200 " run --only verify; rc=$?
[ "${rc}" -ne 0 ] && grep -q "expected a redirect to Google" "${WORK}/out" && ok "an ungated endpoint fails verify" || bad "ungated"

echo "ngrok config is rendered with the secret, but never shown"
FAKE_FAIL_ON="grep -qx lazy_teams-ngrok" run --only ngrok; rc=$?
[ "${rc}" -eq 0 ] && ok "ngrok step passes" || bad "ngrok rc=${rc}: $(tail -5 "${WORK}/out")"
grep -q "cat > /srv/lazy-teams/ngrok/ngrok.yml.part" "${LOG}" &&
  grep -q "chmod 600 /srv/lazy-teams/ngrok/ngrok.yml.part" "${LOG}" &&
  grep -q "mv /srv/lazy-teams/ngrok/ngrok.yml.part /srv/lazy-teams/ngrok/ngrok.yml" "${LOG}" &&
  ok "ngrok.yml streamed to a mode 600 file and atomically installed on the box" || bad "ngrok stream"
# INVARIANT: one wildcard endpoint serves Teams and every service, and every
# rule is scoped by host — Teams' rules to Teams' name, the services' (every
# path signs in) to every other name. An unscoped rule would apply Teams'
# exemptions to a task's app, or a service's rules to Teams. The sign-in is
# the one shared rule, because ngrok refuses a second auth action on an
# endpoint (ERR_NGROK_2239): its expression must still carry Teams' CLI
# exemption on Teams' name only, and sign every other name in unconditionally.
cat > "${WORK}/check-ngrok.rb" <<'RB'
require "yaml"
c = YAML.safe_load_file(ARGV[0])
e = c.fetch("endpoints")
abort "endpoints: #{e.inspect}" unless e.size == 1 && e[0]["url"] == "https://*.r.getlazy.dev"
rules = e[0].dig("traffic_policy", "on_http_request")
oauth = rules.select { |r| Array(r["actions"]).any? { |a| a["type"] == "oauth" } }
abort "ngrok takes one auth action per endpoint, got #{oauth.size} oauth rules" unless oauth.size == 1
sign_in = oauth[0]["expressions"]
abort "the sign-in is not one expression: #{sign_in.inspect}" unless sign_in.size == 1
abort "the sign-in does not cover both: #{sign_in[0]}" unless sign_in[0].include?('(req.host == "teams.r.getlazy.dev") && (!(req.url.path') &&
  sign_in[0].include?('|| (req.host != "teams.r.getlazy.dev")')
rest = rules - oauth
teams = rest.select { |r| r["expressions"].first == 'req.host == "teams.r.getlazy.dev"' }
other = rest.select { |r| r["expressions"].first == 'req.host != "teams.r.getlazy.dev"' }
abort "a rule is not scoped by host" unless teams.size + other.size == rest.size && teams.any? && other.any?
abort "the services lost their allowlist" unless other.any? { |r| Array(r["actions"]).any? { |a| a["type"] == "deny" } }
abort "the sign-in comes after a services rule" unless rules.index(oauth[0]) < rules.index(other[0])
RB
ruby "${WORK}/check-ngrok.rb" "${WORK}/shipped-ngrok.yml" 2>"${WORK}/ngrok-check.err" &&
  ok "one wildcard endpoint, one sign-in for both, every other rule scoped to Teams or to the services" || bad "ngrok config: $(cat "${WORK}/ngrok-check.err")"
grep -q "^kamal accessory boot ngrok -d hetzner" "${LOG}" && ok "the ngrok accessory booted" || bad "boot"
secrets_absent "ngrok"

echo "build"
# INVARIANT: the daemon image tar is readable by the app. docker save writes
# it 600 as root, and smolvm (as rails) loads it into every new machine; a
# root-only tar fails every project's first start and stalls the fleet roll.
run --only build; rc=$?
# shellcheck disable=SC2016 # literal remote-shell variables
grep -q 'chmod 644 "$tar" "$tar.source-id"' "${LOG}" && ok "the daemon image tar is made readable, built now or before" || bad "build: rc=${rc} $(grep -c chmod "${LOG}") $(tail -3 "${WORK}/out")"

echo "masking"
FAKE_KAMAL_OUT="echo leak ${SKB}" run --only deploy
grep -q '\*\*\*' "${WORK}/report.md" && ok "a secret in remote output is masked" || bad "mask"
secrets_absent "deploy"

echo "deploy updates only the existing box"
# INVARIANT: updates never load migration operations or depend on the retired
# workstation install. Only the one-time move may copy or settle data.
deploy_run() {
  : > "${LOG}"; : > "${LOG}.stdin"; : > "${LOG}.persisted"; : > "${LOG}.memory-checks"; : > "${LOG}.users"
  mkdir -p "${WORK}/deploy-tmp"
  TMPDIR="${WORK}/deploy-tmp" FAKE_DEPLOY_TMP="${WORK}/deploy-tmp" \
  PATH="${WORK}/bin:${PATH}" HOME="${WORK}/empty-home" FAKE_DEPLOY_ENV="${WORK}/box.env" \
    LAZY_MOVE_KAMAL="${WORK}/bin/kamal" \
    "${HERE}/../bin/deploy" "${DEPLOY_TEST_TARGET:-root@box.test}" --report "${WORK}/report.md" "$@" > "${WORK}/out" 2>&1
}
cp "${ENV_FILE}" "${WORK}/box.env"
echo NGROK_AUTHTOKEN=ngk-0123456789abcdef >> "${WORK}/box.env"
mkdir -p "${WORK}/empty-home"
mv "${WORK}/mac" "${WORK}/retired-mac"
deploy_run; rc=$?
[ "${rc}" -eq 0 ] && ok "deploy works with no Mac env file" || bad "deploy rc=${rc}: $(tail -8 "${WORK}/out")"
steps="$(sed -n 's/^| \([a-z]*\) | PASS |.*/\1/p' "${WORK}/report.md" | tr '\n' ' ')"
[ "${steps}" = "preflight build deploy ngrok " ] && ok "exactly four update steps" || bad "steps: ${steps}"
grep -q '^kamal deploy --skip-push' "${LOG}" && ok "update deploys" || bad "no deploy"
grep -qE '^sqlite3|--delete|lazy:move:|native-rails|kamal app stop' "${LOG}" && bad "update ran migration operations" || ok "no migration operations"
grep -q 'cat /srv/lazy-teams/secrets/deploy.env' "${LOG}" && grep -q 'cat /srv/lazy-teams/secrets/cli-jwt.pem' "${LOG}" &&
  ok "settings and signing key read from the box" || bad "box secrets not read"
secrets_absent "box deploy"
# INVARIANT: fetched secrets stay in memory; scanning before EXIT must find
# none in deployment scratch, including rendered policies and upload staging.
[ -s "${LOG}.memory-checks" ] && [ ! -s "${LOG}.persisted" ] &&
  ok "no local secret files while deployment is running" || bad "secrets persisted locally"
FAKE_FAIL_ON="cat > /srv/lazy-teams/ngrok/ngrok.yml.part" deploy_run; rc=$?
[ "${rc}" -ne 0 ] && [ ! -s "${LOG}.persisted" ] &&
  ! grep -q "^kamal accessory" "${LOG}" &&
  ok "failed streaming upload leaves no local secret and does not restart ngrok" || bad "failed upload"
FAKE_KAMAL_OUT="leak ${SKB} private-key-body-0123456789abcdef" deploy_run
secrets_absent "leaky command"
grep -q 'private-key-body-0123456789abcdef' "${WORK}/out" "${WORK}/report.md" && bad "signing key leaked" || ok "signing key masked"
FAKE_FAIL_ON='test -d /srv/lazy-teams/storage' deploy_run; rc=$?
[ "${rc}" -ne 0 ] && ! grep -q '^kamal deploy\|docker build' "${LOG}" && ok "missing install refuses before building" || bad "missing install"
FAKE_FAIL_ON='test -d /srv/lazy-teams/storage' deploy_run --dry-run; rc=$?
[ "${rc}" -ne 0 ] && grep -q "move-install for the first move" "${WORK}/out" && ok "dry-run refuses a missing install with the move command" || bad "dry-run missing install"
deploy_run --dry-run; rc=$?
[ "${rc}" -eq 0 ] && ! grep -q "^kamal deploy" "${LOG}" && ok "dry-run never deploys" || bad "dry-run updated the box"
cp "${WORK}/box.env" "${WORK}/box.env.full"
grep -v AR_ENCRYPTION_PRIMARY_KEY "${WORK}/box.env.full" > "${WORK}/box.env"
AR_ENCRYPTION_PRIMARY_KEY=stale-workstation-value deploy_run; rc=$?
[ "${rc}" -ne 0 ] && grep -q "have no AR_ENCRYPTION_PRIMARY_KEY" "${WORK}/out" && ok "missing box secret cannot inherit a workstation value" || bad "inherited secret"
cp "${WORK}/box.env.full" "${WORK}/box.env"
deploy_run --only copy >/dev/null; rc=$?
[ "${rc}" -eq 2 ] && ok "migration step selection unavailable" || bad "deploy accepted --only"
deploy_run --env-file "${WORK}/box.env"; rc=$?
[ "${rc}" -eq 0 ] && ! grep -q 'cat /srv/lazy-teams/secrets/deploy.env' "${LOG}" && ok "explicit env override" || bad "env override"
# INVARIANT: the box's deploy.env is DATA, never shell. It comes from the server and
# deploy runs on the engineer's workstation, so a command substitution in a value must
# not run there, and only the named deployment keys are exported to Kamal. A taken
# value whose shell meaning differs from its literal text is refused, not reinterpreted.
MARK="${WORK}/env-executed"; rm -f "${MARK}" "${MARK}-bt"
{
  grep -vE '^(AR_ENCRYPTION_PRIMARY_KEY|AR_ENCRYPTION_DETERMINISTIC_KEY|TRUSTED_PROXY_SECRET)=' "${WORK}/box.env.full"
  echo "# a comment"
  echo ""
  echo "export AR_ENCRYPTION_PRIMARY_KEY='sq \$(touch ${MARK}) value'"
  echo "AR_ENCRYPTION_DETERMINISTIC_KEY=\"dq-plain-value\""
  echo "TRUSTED_PROXY_SECRET=plain=with=equals"
  echo "UNRELATED_BOX_KEY=\$(touch ${MARK})"
} > "${WORK}/box.env"
: > "${LOG}.kamal-env"
deploy_run; rc=$?
[ "${rc}" -eq 0 ] && [ ! -e "${MARK}" ] &&
  ok "deploy.env values are never executed" || bad "deploy.env executed: rc=${rc} $(ls "${WORK}" | grep env-executed) $(tail -3 "${WORK}/out")"
grep -qxF "AR_ENCRYPTION_PRIMARY_KEY=sq \$(touch ${MARK}) value" "${LOG}.kamal-env" &&
  grep -qxF "AR_ENCRYPTION_DETERMINISTIC_KEY=dq-plain-value" "${LOG}.kamal-env" &&
  grep -qxF "TRUSTED_PROXY_SECRET=plain=with=equals" "${LOG}.kamal-env" &&
  ok "quoted, export-prefixed and = values reach kamal exactly" || bad "values: $(sort -u "${LOG}.kamal-env")"
grep -q "^UNRELATED_BOX_KEY=" "${LOG}.kamal-env" && ! grep -qvxF "UNRELATED_BOX_KEY=<unset>" <(grep "^UNRELATED_BOX_KEY=" "${LOG}.kamal-env") &&
  ok "unrelated deploy.env keys are not exported to kamal" || bad "unrelated key: $(grep UNRELATED "${LOG}.kamal-env" | sort -u)"
refused_case() {
  local label="$1" line="$2"
  rm -f "${MARK}-bt"
  { grep -v '^AR_ENCRYPTION_DETERMINISTIC_KEY=' "${WORK}/box.env.full"; printf '%s\n' "${line}"; } > "${WORK}/box.env"
  deploy_run; rc=$?
  [ "${rc}" -ne 0 ] && [ ! -e "${MARK}-bt" ] && grep -q "AR_ENCRYPTION_DETERMINISTIC_KEY has a value" "${WORK}/out" &&
    grep -q "single quotes" "${WORK}/out" && ! grep -q '^kamal deploy\|docker build' "${LOG}" &&
    ! grep -qF "ard-0123456789abcdef" "${WORK}/out" &&
    ok "${label}: refused and not executed" || bad "${label}: rc=${rc} $(tail -3 "${WORK}/out")"
}
refused_case "double-quoted backtick" "AR_ENCRYPTION_DETERMINISTIC_KEY=\"dq \`touch ${MARK}-bt\` value\""
refused_case "inline comment" "AR_ENCRYPTION_DETERMINISTIC_KEY=ard-0123456789abcdef  # note"
refused_case "trailing whitespace" "AR_ENCRYPTION_DETERMINISTIC_KEY=ard-0123456789abcdef "
refused_case "unquoted & or ;" "AR_ENCRYPTION_DETERMINISTIC_KEY=ard-0123&456;789"
# A server moved before deploy.env carried every key: refuse once, naming each.
grep -vE '^(NGROK_AUTHTOKEN|TEAMS_ALLOWED_EMAILS)=' "${WORK}/box.env.full" > "${WORK}/box.env"
deploy_run; rc=$?
[ "${rc}" -ne 0 ] && grep -q "have no NGROK_AUTHTOKEN TEAMS_ALLOWED_EMAILS" "${WORK}/out" &&
  grep -q "/srv/lazy-teams/secrets/deploy.env on the server" "${WORK}/out" &&
  ! grep -q '^kamal deploy\|docker build' "${LOG}" &&
  ok "a box deploy.env without NGROK_AUTHTOKEN refuses at preflight, naming every missing key" || bad "missing keys: rc=${rc} $(tail -3 "${WORK}/out")"
# INVARIANT: a box moved by the OLD move-install (deploy.env = the Mac's copy,
# without the token, allowlist or key endpoint) deploys with no hand edit: the
# values are read, in memory, from where that move put them — the ngrok
# accessory's env and the rendered ngrok config — and never shown.
grep -vE '^(NGROK_AUTHTOKEN|TEAMS_ALLOWED_EMAILS|TEAMS_JWKS_URL)=' "${WORK}/box.env.full" > "${WORK}/box.env"
printf '%s\n' PATH=/bin NGROK_AUTHTOKEN=ngk-0123456789abcdef > "${WORK}/box-ngrok.env"
cat > "${WORK}/box-ngrok.yml" <<'YML'
version: 3
endpoints:
  - name: lazy-teams
    url: https://*.getlazy.dev
    traffic_policy:
      on_http_request:
        - expressions: ["req.host == \"teams.r.getlazy.dev\""]
          actions:
            - type: jwt-validation
              config:
                jws:
                  keys:
                    sources:
                      additional_jkus: ["https://keys.example.com/.well-known/lazy-cli-jwks.json"]
        - expressions: ["(req.host == \"teams.r.getlazy.dev\") && (!(actions.ngrok.oauth.identity.email in ['me@example.com', 'you@example.com']))"]
          actions: [{ type: deny, config: { status_code: 403 } }]
        - actions:
            - type: add-headers
              config: { headers: { X-Lazy-Proxy-Secret: "tps-0123456789abcdef" } }
YML
FAKE_BOX_NGROK_ENV="${WORK}/box-ngrok.env" FAKE_BOX_NGROK_YML="${WORK}/box-ngrok.yml" deploy_run; rc=$?
[ "${rc}" -eq 0 ] && grep -q '^kamal deploy --skip-push' "${LOG}" &&
  grep -q "no NGROK_AUTHTOKEN; using the one the box's ngrok accessory runs with" "${WORK}/out" &&
  grep -q "no TEAMS_ALLOWED_EMAILS; using the allowlist" "${WORK}/out" &&
  grep -q "no TEAMS_JWKS_URL; using the key endpoint" "${WORK}/out" &&
  grep -q "EMAILS=me@example.com,you@example.com JWKS_URL=https://keys.example.com/.well-known/lazy-cli-jwks.json bin/rails teams:proxy_policy" "${LOG}" &&
  ok "an old-move box deploys with the token, allowlist and key endpoint read from the box" || bad "old-move box: rc=${rc} $(tail -5 "${WORK}/out")"
secrets_absent "old-move box"
[ ! -s "${LOG}.persisted" ] && ok "old-move box: no local secret files" || bad "old-move box persisted secrets"
cp "${WORK}/box.env.full" "${WORK}/box.env"
DEPLOY_TEST_TARGET=deployer@box.test deploy_run; rc=$?
[ "${rc}" -eq 0 ] && grep -q "^ssh -o BatchMode=yes deployer@box.test" "${LOG}" &&
  grep -qx deployer "${LOG}.users" && ! grep -qvx deployer "${LOG}.users" &&
  ok "non-root target is used by direct SSH and every Kamal invocation" || bad "non-root target"
grep -q '"teams:deploy": "lazy-teams/bin/deploy"' "${HERE}/../../package.json" && ok "package runs deploy" || bad "package command"
mv "${WORK}/retired-mac" "${WORK}/mac"
# INVARIANT: bin/deploy never evals (deploy.env is data, see above), and
# deploy's scripts run on macOS's bash 3.2, whose `.` loads nothing from a
# pipe and whose here-strings write a temp file (secrets on disk). No bash 3.2
# here to run them, so this is a static guard.
grep -nE '(^|[^<])(\.|source) <\(|<<<' "${HERE}/../bin/deploy" "${HERE}/install-common.sh" >/dev/null &&
  bad "bash 3.2: deploy scripts use . <(, source <( or <<<" || ok "bash 3.2: no sourcing a pipe or here-strings"
grep -nwE "eval" "${HERE}/../bin/deploy" >/dev/null && bad "bin/deploy uses eval" || ok "bin/deploy never evals"

echo "reset"
echo "nope" | run --reset; rc=$?
[ "${rc}" -ne 0 ] && ! grep -q "rm -rf" "${LOG}" && ok "unconfirmed reset removes nothing" || bad "reset unconfirmed"
echo "reset box.test" | run --reset; rc=$?
grep -q "rm -rf /srv/lazy-teams" "${LOG}" && grep -q "^kamal remove -y -d hetzner" "${LOG}" && ok "confirmed reset wipes the box install" || bad "reset: $(cat "${LOG}")"
[ -f "${WORK}/mac/fleet/projects/p1/store/t.json" ] && ok "reset leaves the Mac untouched" || bad "reset touched the Mac"

echo
echo "test-move-install: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
