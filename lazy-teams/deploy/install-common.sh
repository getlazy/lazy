#!/usr/bin/env bash
# Shared update operations only. Sourced after each command parses its options.
# shellcheck disable=SC2317
SECRET_VALUES=()
add_secret() { [ -n "${1:-}" ] && [ "${#1}" -ge 8 ] && SECRET_VALUES+=("$1"); return 0; }
mask() {
  local line s
  while IFS= read -r line || [ -n "${line}" ]; do
    for s in ${SECRET_VALUES[@]+"${SECRET_VALUES[@]}"}; do line="${line//"$s"/***}"; done
    printf '%s\n' "${line}"
  done
}
# Every announcement goes to the report too: a failure reason seen only in the
# terminal leaves the report saying FAIL with nothing to say why.
say()  { if [ -f "${REPORT}" ]; then printf '%s: %s\n' "${COMMAND_NAME}" "$*" | mask | tee -a "${REPORT}"; else printf '%s: %s\n' "${COMMAND_NAME}" "$*" | mask; fi; }
RESULTS=""
record() { RESULTS="${RESULTS}| $1 | $2 | $3 |"$'\n'; }
{
  echo "# Lazy Teams ${REPORT_TITLE} — ${STAMP}"
  echo
  echo "- box: ${TARGET}"
  echo "- Teams: https://${APP_HOST}  services: *.${DOMAIN}"
  echo "- mode: ${MODE}$([ "${DRY_RUN}" = 1 ] && echo ' (dry run)')$([ "${FINAL}" = 1 ] && echo ', final')"
  echo "- commit: $(git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo
} > "${REPORT}"
section() { printf '\n## %s\n\n' "$1" >> "${REPORT}"; }
# Run a command, tee its masked output to the terminal and the report.
logged() {
  local out="${WORK}/out" rc
  if [ "${DRY_RUN}" = 1 ]; then
    printf '  [dry-run] %s\n' "$*" | mask | tee -a "${REPORT}"
    return 0
  fi
  # Streamed as it arrives (a build or a big rsync runs for minutes), masked.
  "$@" 2>&1 | mask | tee "${out}" | sed 's/^/  | /'
  rc=${PIPESTATUS[0]}
  { echo '```'; tail -n 80 "${out}"; echo '```'; } >> "${REPORT}"
  return "${rc}"
}
remote() { logged "${SSH}" -o BatchMode=yes "${TARGET}" "$@"; }
# A remote read whose output the script itself parses (also used by update preflight).
remote_read() { "${SSH}" -o BatchMode=yes "${TARGET}" "$@"; }
# Ship a secret file to the box mode 600. Stages a private copy and lets
# `rsync -a` carry its mode over, because macOS's own rsync (openrsync) has no
# --chmod; the box's secrets and ngrok directories are 700 besides.
ship_secret() {
  local staged
  staged="${WORK}/ship/$(basename "$2")"
  mkdir -p "${WORK}/ship" && chmod 700 "${WORK}/ship"
  cp "$1" "${staged}" && chmod 600 "${staged}" || return 1
  logged "${RSYNC}" -a "${staged}" "${TARGET}:$2"
}
kamal() { (cd "${APP_DIR}" && logged "${KAMAL}" "$@" -d hetzner); }

step_build() {
  local ctx="${BOX_ROOT}/build/${BUILD_TAG}"
  remote "set -e; mkdir -p ${ctx} ${BOX_ROOT}/images ${BOX_ROOT}/registry; command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh" || return 1
  say "sending the committed tree at ${BUILD_TAG} to ${ctx}"
  if [ "${DRY_RUN}" = 1 ]; then
    logged git archive "${BUILD_TAG}" "|" ssh "${TARGET}" tar -x -C "${ctx}"
  else
    git -C "${REPO_DIR}" archive "${BUILD_TAG}" | "${SSH}" -o BatchMode=yes "${TARGET}" "tar -x -C ${ctx}" || { say "could not send the tree"; return 1; }
  fi
  # The registry first: the app image is pushed to it below. A plain container,
  # not a Kamal accessory — booting an accessory logs in to the app's registry
  # first, which is this very container.
  remote "set -e
    if docker ps -a --format '{{.Names}}' | grep -qx lazy-teams-registry; then docker start lazy-teams-registry >/dev/null
    else docker run -d --restart unless-stopped --name lazy-teams-registry -p 127.0.0.1:5555:5000 \
      -v ${BOX_ROOT}/registry:/var/lib/registry registry:2 >/dev/null; fi
    echo 'registry: running on 127.0.0.1:5555'" || return 1
  # The daemon image as a tar plus its `.source-id` sidecar: the fleet rolls
  # projects onto a new lazy only when it can read that id (lazy_source_id).
  remote "set -e; cd ${ctx}
    tar=${BOX_ROOT}/images/lazy-daemon-${BUILD_TAG}.tar
    if [ -s \"\$tar\" ] && [ -s \"\$tar.source-id\" ]; then echo \"daemon image already built: \$tar\"; else
      docker build ${STAMP_ARGS} -f lazy-teams/deploy/daemon-image/Dockerfile -t lazy-daemon:${BUILD_TAG} .
      docker save lazy-daemon:${BUILD_TAG} -o \"\$tar.part\" && mv \"\$tar.part\" \"\$tar\"
      cid=\$(docker create lazy-daemon:${BUILD_TAG})
      docker cp \"\$cid:/opt/lazy/.source-fingerprint\" \"\$tar.source-id.part\"; docker rm \"\$cid\" >/dev/null
      test -s \"\$tar.source-id.part\" && mv \"\$tar.source-id.part\" \"\$tar.source-id\"
    fi
    # docker save writes 600 as root; smolvm reads the tar as rails (uid 1000).
    # It holds the daemon image only, no secret.
    chmod 644 \"\$tar\" \"\$tar.source-id\"
    docker build -f lazy-teams/deploy/Dockerfile --build-arg LAZY_DAEMON_IMAGE=lazy-daemon:${BUILD_TAG} \
      ${STAMP_ARGS} -t 127.0.0.1:5555/lazy-teams:${BUILD_TAG} .
    docker push 127.0.0.1:5555/lazy-teams:${BUILD_TAG}"
}

# Kamal's boot skips a name that exists in ANY state, so a crashed accessory
# is rebooted (replaced), never left as it is.
boot_accessory() {
  local name="$1"
  if [ "${DRY_RUN}" = 0 ] && remote_read "docker ps -a --format '{{.Names}}' | grep -qx lazy_teams-${name}" 2>/dev/null; then
    kamal accessory reboot "${name}"
  else
    kamal accessory boot "${name}"
  fi
}

step_deploy() {
  kamal deploy --skip-push --version="${BUILD_TAG}"
}

step_ngrok() {
  local policy services conf quoted
  if [ "${DRY_RUN}" = 1 ]; then
    logged "${KAMAL}" app exec "EMAILS=… JWKS_URL=… bin/rails teams:proxy_policy" -d hetzner
    remote "umask 077; stream ngrok configuration to ${BOX_ROOT}/ngrok/ngrok.yml"
    logged "${KAMAL}" accessory reboot ngrok -d hetzner
    return 0
  fi
  say "rendering the Traffic Policy (Teams' rules from the app itself, the services' from config/ngrok/services-policy.yml)"
  policy="$(cd "${APP_DIR}" && "${KAMAL}" app exec --reuse -q "env EMAILS=${EMAILS} JWKS_URL=${JWKS_URL} bin/rails teams:proxy_policy" -d hetzner 2> >(mask >&2))" ||
    { say "could not print the Teams policy"; return 1; }
  # Kamal prefixes its own lines; the policy is the YAML from its first key on.
  policy="$(printf '%s\n' "${policy}" | sed -n '/^on_http_request:/,$p')"
  [ -n "${policy}" ] || { say "the Teams policy came back empty"; return 1; }
  quoted="$(printf '%s' "${EMAILS}" | sed "s/[[:space:]]//g; s/,/', '/g; s/^/'/; s/\$/'/")"
  services="$(sed "s/@@EMAILS@@/${quoted}/" "${APP_DIR}/config/ngrok/services-policy.yml")" || return 1
  # ONE endpoint, the wildcard *.<domain>, which covers Teams' own name too
  # (ngrok bills per endpoint). Its policy is both policies, every rule scoped
  # by host: Teams' rules apply only to APP_HOST, the services' rules (every
  # path signs in, no exemptions) to every other name. The exception is the
  # sign-in itself: ngrok allows ONE auth action per endpoint (ERR_NGROK_2239),
  # so the two oauth rules become one, at Teams' position, whose expression is
  # Teams' condition on Teams' name OR the services' on every other name. That
  # only means the same thing if both sign in the same way, so they must.
  case "${APP_HOST}" in
    *."${DOMAIN}") ;;
    *) say "Teams' name ${APP_HOST} is not under *.${DOMAIN}, so the one wildcard endpoint cannot serve it"; return 1 ;;
  esac
  # shellcheck disable=SC2016 # Ruby source, not shell
  conf="$(TEAMS_POLICY="${policy}" SERVICES_POLICY="${services}" ruby -ryaml -e '
    app_host, domain = ARGV
    is_app = "req.host == \"#{app_host}\""
    on = ->(policy) { YAML.safe_load(policy).fetch("on_http_request") }
    scope = ->(rule, expr) { rule.merge("expressions" => [ expr ] + Array(rule["expressions"])) }
    signs_in = ->(rule) { Array(rule["actions"]).any? { |a| a["type"] == "oauth" } }
    cond = ->(head, rule) { ([ head ] + Array(rule["expressions"])).map { |e| "(#{e})" }.join(" && ") }
    t = on.(ENV.fetch("TEAMS_POLICY").gsub("the value of TRUSTED_PROXY_SECRET", ENV.fetch("TRUSTED_PROXY_SECRET")))
    s = on.(ENV.fetch("SERVICES_POLICY").gsub("@@TRUSTED_PROXY_SECRET@@", ENV.fetch("TRUSTED_PROXY_SECRET")))
    to, so = t.select(&signs_in), s.select(&signs_in)
    abort "expected one sign-in rule in each policy, got #{to.size} and #{so.size}" unless to.size == 1 && so.size == 1
    abort "a sign-in rule does more than sign in" unless to[0]["actions"].size == 1 && so[0]["actions"].size == 1
    abort "Teams and the services sign in differently; one endpoint takes one sign-in" unless to[0]["actions"] == so[0]["actions"]
    sign_in = to[0].merge("expressions" => [ "#{cond.("req.host == \"#{app_host}\"", to[0])} || #{cond.("req.host != \"#{app_host}\"", so[0])}" ])
    rules = t.map { |r| r.equal?(to[0]) ? sign_in : scope.(r, is_app) } +
      s.reject { |r| r.equal?(so[0]) }.map { |r| scope.(r, "req.host != \"#{app_host}\"") }
    puts YAML.dump("version" => 3, "endpoints" => [ {
      "name" => "lazy-teams", "url" => "https://*.#{domain}",
      "upstream" => { "url" => "http://kamal-proxy:80" },
      "traffic_policy" => { "on_http_request" => rules } } ])
  ' "${APP_HOST}" "${DOMAIN}" 2> >(mask >&2))" || { say "could not combine the two policies"; return 1; }
  # Keep fetched secrets and rendered configuration in memory until SSH writes
  # them on the box. A failed upload leaves the existing configuration intact.
  printf '%s\n' "${conf}" | remote "set -e; umask 077; mkdir -p ${BOX_ROOT}/ngrok
    cat > ${BOX_ROOT}/ngrok/ngrok.yml.part
    chmod 600 ${BOX_ROOT}/ngrok/ngrok.yml.part
    mv ${BOX_ROOT}/ngrok/ngrok.yml.part ${BOX_ROOT}/ngrok/ngrok.yml" || return 1
  # The ngrok image runs as a non-root user: hand it the directory and file
  # (asked of the image, never assumed).
  remote "set -e; u=\$(docker run --rm --entrypoint id ngrok/ngrok:3 -u); g=\$(docker run --rm --entrypoint id ngrok/ngrok:3 -g)
    chown -R \"\$u:\$g\" ${BOX_ROOT}/ngrok; echo \"ngrok config owned by \$u:\$g\"" || return 1
  boot_accessory ngrok
}

run_step() {
  local name="$1" fn="step_$1"
  section "${name}"
  say "── ${name} ──"
  if "${fn}"; then record "${name}" PASS "" ; return 0; fi
  record "${name}" FAIL "see the section above"
  say "${name} FAILED — the report has the output: ${REPORT}"
  return 1
}

finish() {
  { echo; echo "## Summary"; echo; echo "| step | result | note |"; echo "|---|---|---|"; printf '%s' "${RESULTS}"; } >> "${REPORT}"
  say "report: ${REPORT}"
}

configure_deploy() {
  # Not a secret: the box-local registry has no authentication.
  export KAMAL_REGISTRY_PASSWORD="box-local-registry"
  export LAZY_TEAMS_BOX_USER="${TARGET%%@*}"
  export LAZY_TEAMS_BOX_HOST="${BOX_HOST}" LAZY_TEAMS_APP_HOST="${APP_HOST}" LAZY_TEAMS_SERVICES_HOST="${DOMAIN}"
  BUILD_TAG="$(git -C "${REPO_DIR}" rev-parse --short=12 HEAD)"
  export LAZY_TEAMS_BUILD_TAG="${BUILD_TAG}"
  # The source identity of the commit being built, computed HERE: the box
  # builds from a git-archive tree with no .git.
  STAMP_ARGS=""
  if [ -f "${REPO_DIR}/scripts/source-stamp-build-args.sh" ]; then
    # shellcheck disable=SC1091,SC2034 # GIT_REF is read by the sourced script
    STAMP_ARGS="$(cd "${REPO_DIR}" && GIT_REF="${BUILD_TAG}" && . scripts/source-stamp-build-args.sh >/dev/null && printf '%q ' "${SOURCE_STAMP_ARGS[@]}")"
  fi
}
