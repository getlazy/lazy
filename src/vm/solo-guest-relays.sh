#!/bin/sh
#
# solo-guest-relays.sh — the in-guest half of solo lazy's smolvm routes
# (src/vm/solo-routes.ts, docs/design/ic-mode-smolvm-shape.md). The host runs
# it in the project's machine with `smolvm machine exec -- sh -c <this> ...`
# after every bring-up; it is idempotent, and changes only what differs.
#
# Two kinds of relay, each a socat listener with one child per connection:
#
#   CALLBACKS — task containers reaching lazy on the host. A container dials
#     host.docker.internal:<port>, which `--add-host …:host-gateway` makes the
#     guest's default-bridge gateway. A relay per route listens there on the
#     port the container dials, and hands each connection to smolvm's ONE
#     guest-to-host mapping (<gateway>:<host-service guest port>) prefixed with
#     a single line naming the route (`LAZY-ROUTE daemon`). The host's route mux
#     reads that line and connects to the daemon or the proxy — nothing else.
#
#   SERVICES — the host reaching task services. smolvm publishes one fixed
#     host port to <link address>:<services guest port> (its relay dials the
#     guest's LINK address, not loopback — lazy-guest-init's forwarder notes the
#     measurement). The router there reads one line, `LAZY-PORT <n>`, and
#     connects to 127.0.0.1:<n>, where docker published the task's port.
#
# Listeners bind one address each, never 0.0.0.0. Pid and spec files live in
# the run dir (tmpfs, empty on every boot), so a relay started with other
# options — another daemon port, a proxy on a new port — is replaced.
#
# THE SERVICES ROUTER IS REACHABLE FROM EVERY CONTAINER in the machine (the link
# address is the guest's own), so a route line alone would let a task or run
# container reach another's published ports. The line therefore carries a
# per-machine secret the host generated: `LAZY-PORT <secret> <n>`. It is kept
# here in the run dir, 0600 and root-owned, which no container mounts; a line
# without it reaches nothing. The callback relays need no secret: what they
# reach is the host's route mux, which serves only the daemon and its proxy —
# exactly what a container is meant to reach.
#
# Usage: solo-guest-relays.sh <run dir> <gateway> <host-service guest port> <services guest port> <services secret> [<route> <port>]...
# Prints key=value lines; exits non-zero (with relay_error=…) when a relay is not up.

set -u
RUN="$1"; GATEWAY="$2"; HS_PORT="$3"; SVC_PORT="$4"; SECRET="$5"
shift 5
VERSION=3

emit() { printf '%s=%s\n' "$1" "$2"; }
fail() { emit relay_error "$1"; exit 1; }

case "$HS_PORT$SVC_PORT" in *[!0-9]*|'') fail "bad ports: $HS_PORT $SVC_PORT" ;; esac
command -v socat >/dev/null 2>&1 || fail "socat is not installed in the machine's image"
# The callback route script opens its upstream with bash's /dev/tcp.
command -v bash >/dev/null 2>&1 || fail "bash is not installed in the machine's image"
case "$SECRET" in *[!0-9a-f]*|'') fail "bad services secret" ;; esac
[ ${#SECRET} -ge 32 ] || fail "services secret too short"
mkdir -p "$RUN" || fail "cannot create $RUN"
chmod 0700 "$RUN" || fail "cannot restrict $RUN"
( umask 077; printf '%s\n' "$SECRET" >"$RUN/service-secret.tmp" ) && mv -f "$RUN/service-secret.tmp" "$RUN/service-secret" \
  || fail "cannot write the services secret"

# The link address smolvm's published-port relay dials: the first global IPv4
# address on an interface that is not loopback and not one of docker's.
link_address() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print a[1]; exit }'
}

# What `host-gateway` resolves to for a container: the default bridge's gateway.
bridge_gateway() {
  gw=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
  [ -n "$gw" ] || gw=$(ip -4 -o addr show dev docker0 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')
  printf '%s' "$gw"
}

alive() {
  [ -f "$1.pid" ] || return 1
  pid=$(cat "$1.pid" 2>/dev/null)
  [ -n "$pid" ] && [ "$(cat /proc/"$pid"/comm 2>/dev/null)" = socat ]
}

listening() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -Hltn 2>/dev/null | grep -q "[[:space:]]$1:$2[[:space:]]"
}

# ensure <name> <bind> <port> <socat target address> — start or replace one listener.
ensure() {
  name="$1"; bind="$2"; port="$3"; target="$4"
  base="$RUN/$name"
  spec="v$VERSION TCP4-LISTEN:$port,bind=$bind $target"
  if alive "$base" && [ "$(cat "$base.spec" 2>/dev/null)" = "$spec" ]; then
    emit "relay_$name" "alive $bind:$port"
    return 0
  fi
  if alive "$base"; then
    # Only the listener: connections it already forked keep running to the end.
    kill "$(cat "$base.pid")" 2>/dev/null
    n=0; while alive "$base" && [ "$n" -lt 10 ]; do sleep 0.2; n=$((n + 1)); done
  fi
  rm -f "$base.pid" "$base.spec"
  # backlog=1024: socat's default of 5 resets connections arriving faster than
  # it forks (a dev server's page load); same reasoning as lazy-guest-init.
  setsid socat -d "TCP4-LISTEN:$port,bind=$bind,reuseaddr,fork,backlog=1024" "$target" >>"$base.log" 2>&1 </dev/null &
  echo $! >"$base.pid"
  printf '%s\n' "$spec" >"$base.spec"
  n=0
  while [ "$n" -lt 25 ]; do
    if alive "$base" && listening "$bind" "$port"; then emit "relay_$name" "started $bind:$port"; return 0; fi
    alive "$base" || break
    sleep 0.2; n=$((n + 1))
  done
  fail "$name did not come up on $bind:$port: $(tail -n 3 "$base.log" 2>/dev/null | tr '\n' ' ')"
}

# The per-connection scripts. Rewritten every run (they are this version's).
cat >"$RUN/callback-route.sh" <<'EOF'
#!/bin/bash
# One container connection: open the mapping, name the route on it, then hand
# BOTH sides to one socat. A single process owning the connection is what
# makes a host-first close (a Connection: close response, an idle keep-alive
# the daemon drops) reach the container at once; a pipeline with a separate
# writer kept the container's socket open after the host had gone.
exec 3<>"/dev/tcp/$2/$3" || exit 1
printf 'LAZY-ROUTE %s\n' "$1" >&3
exec socat STDIO FD:3,shut-down
EOF
cat >"$RUN/service-route.sh" <<'EOF'
#!/bin/sh
# One host connection: read `LAZY-PORT <secret> <n>` (sh's read takes one byte
# at a time from a socket, so nothing after the line is consumed), refuse it
# unless the secret is this machine's, then splice to the guest-loopback port
# docker published. Every container can reach this router; only the host
# knows the secret.
dir=$(dirname "$0")
want=$(cat "$dir/service-secret" 2>/dev/null)
[ -n "$want" ] || { echo "lazy: no services secret" >&2; exit 1; }
IFS= read -r line || exit 0
case "$line" in "LAZY-PORT "*) rest=${line#LAZY-PORT } ;; *) echo "lazy: bad route line" >&2; exit 1 ;; esac
got=${rest%% *}
port=${rest#* }
[ "$got" = "$want" ] && [ "$port" != "$rest" ] || { echo "lazy: route line refused" >&2; exit 1; }
case "$port" in ''|*[!0-9]*) exit 1 ;; esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || exit 1
exec socat STDIO "TCP4:127.0.0.1:$port"
EOF
chmod 0755 "$RUN/callback-route.sh" "$RUN/service-route.sh"

link=$(link_address)
[ -n "$link" ] || fail "the machine has no link address for the published services port"
ensure services "$link" "$SVC_PORT" "EXEC:$RUN/service-route.sh"

if [ $# -gt 0 ]; then
  gw=$(bridge_gateway)
  [ -n "$gw" ] || fail "cannot find the Docker bridge's gateway (is dockerd up?)"
  emit bridge_gateway "$gw"
  while [ $# -ge 2 ]; do
    route="$1"; port="$2"; shift 2
    case "$route" in *[!a-z]*|'') fail "bad route name: $route" ;; esac
    case "$port" in *[!0-9]*|'') fail "bad port for $route: $port" ;; esac
    ensure "callback-$route" "$gw" "$port" "EXEC:$RUN/callback-route.sh $route $GATEWAY $HS_PORT"
  done
fi
emit relays ok
