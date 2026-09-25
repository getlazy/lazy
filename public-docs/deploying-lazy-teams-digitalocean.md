# Deploying Lazy Teams on DigitalOcean with Kamal

This guide puts Lazy Teams on a **cloud VPS** — a DigitalOcean droplet or any similar Linux server — with [Kamal](https://kamal-deploy.org/). Kamal pulls (or builds) a container image, SSHes into your server, and runs the app behind **kamal-proxy**.

For a **local or single-box install** without SSH keys or a registry account, use the [docker compose bundle](./self-hosting-lazy-teams.md) instead. That path is pull-and-go; this path is for cloud deploy and Kamal-style upgrades.

The default in this repository is a **private install**: the droplet is not exposed on the public internet, and you reach the UI over an SSH tunnel (or Tailscale). Public HTTPS with Let's Encrypt is an optional later step.

## Which path is for you

| | Compose (local path) | Kamal (this guide) |
|--|---------------------|-------------------|
| Best for | Homelab, LAN, quick trial on one machine | Cloud VPS you control over SSH |
| Needs | Docker Compose on the server | SSH access, a container registry login, Kamal on your laptop |
| Default reachability | Loopback on the server | Private (SSH tunnel / Tailscale); public HTTPS optional |
| Upgrades | `docker compose pull && up -d` | `kamal deploy` from your machine |

Both paths use the **same** published image (`ghcr.io/getlazy/lazy-teams`) and the **same** two data volumes. Neither gives the application container your host's Docker socket — see [your Docker socket stays on your host](./self-hosting-lazy-teams.md#your-docker-socket-stays-on-your-host). Slack uses **outbound** Socket Mode only — nothing on this box needs an inbound Slack URL.

> **This install does not run agent turns.** Agent turns run in one microVM per project, which needs hardware virtualization, and a droplet has none: DigitalOcean does not offer nested virtualization. Both paths therefore run without microVMs — the Kamal config sets `LAZY_FLEET_BACKEND=local`, and `bootstrap.sh` selects the same for compose when it finds no `/dev/kvm` — and starting a task is refused with the reason. See [task turns](./self-hosting-lazy-teams.md#task-turns) for what does run them: a server with KVM, such as a bare-metal one.

## What you need

- A **DigitalOcean droplet** (or any amd64 Linux VPS) with **4 GB RAM** and **40 GB disk** recommended — fleet data grows with projects
- On your **laptop**: Ruby (for Kamal), SSH access to the droplet as `root` (or another user you configure in `config/deploy.yml`), and a **GitHub personal access token** with `read:packages` (and `write:packages` if you build and push images yourself)
- For **public HTTPS only**: a domain name with an A record pointing at the droplet, and ports **80** and **443** open

You do **not** need Ruby, Bun, or lazy installed on the droplet itself. You do **not** need a public DNS name for the private posture.

## 1. Prepare the droplet

Create an Ubuntu 24.04 droplet on DigitalOcean. The one-click **Docker** image works; otherwise install Docker Engine:

```bash
ssh root@YOUR_DROPLET_IP

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${VERSION_CODENAME}) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Confirm Docker runs:

```bash
docker info
```

### Firewall for a private install

Keep the app off the public internet. Allow SSH from your IP (or VPN) only; leave **80** and **443** closed until you deliberately choose public HTTPS:

```bash
# Example with ufw — adjust to your cloud firewall if you prefer that
ufw default deny incoming
ufw allow from YOUR_LAPTOP_IP to any port 22
ufw enable
ufw status
```

DigitalOcean Cloud Firewalls work the same way: inbound **22** from your IP, no public **80**/**443**.

## 2. Prepare your laptop

Clone the [lazy repository](https://github.com/getlazy/lazy) (or use a release tarball) and install Ruby for the Lazy Teams app:

```bash
cd lazy-teams
gem install bundler
bundle install
```

Log in to GitHub Container Registry (same registry the compose bundle uses):

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Generate application secrets once — **save them somewhere safe**; losing them loses encrypted credentials in the database:

```bash
export SECRET_KEY_BASE="$(openssl rand -hex 64)"
bin/rails db:encryption:init   # prints three AR_ENCRYPTION_* lines — export each
export KAMAL_REGISTRY_PASSWORD="$GITHUB_TOKEN"
```

Add those exports to your shell profile or a password manager. They are the same variables `bootstrap.sh` writes for compose.

### Verify secrets before deploy

Kamal reads `.kamal/secrets` with a **dotenv** parser — not a bash shell. Do **not** put `${VAR:?…}` or `${VAR:-…}` expansions in that file; they corrupt the stored value. After exporting, print what Kamal will inject:

```bash
bin/kamal secrets print
```

Check each line: the value must be exactly what you exported (a long hex string for `SECRET_KEY_BASE`, and so on). If you see a `:?` or `:-` suffix glued onto the value, stop and fix `.kamal/secrets` before deploying — encrypting under a wrong key makes existing rows unreadable later.

## 3. Configure Kamal

Edit `lazy-teams/config/deploy.yml`:

| Placeholder | Set to |
|-------------|--------|
| `servers.web` | Droplet public IP |
| `registry.username` | Your GitHub username |

The shipped defaults already match a **private** install (`proxy.ssl: false`, `APP_HOST: localhost`, `FORCE_SSL: false`). Pick an access method below before you deploy — only Option C needs DNS and open HTTP(S) ports.

Optional mail: add `SMTP_PASSWORD` and the `SMTP_*` / `MAILER_FROM` values under `env.clear` in `deploy.yml`, matching [self-hosting environment reference](./self-hosting-lazy-teams.md#environment-reference).

### Building from source (maintainers)

By default the config **pulls** the pre-built image from `ghcr.io/getlazy/lazy-teams`. To build from your checkout instead, uncomment `builder.context` and `builder.dockerfile` in `deploy.yml`.

On an **Apple Silicon Mac** targeting amd64 droplets, also uncomment `builder.remote` and point it at an amd64 machine with Docker (a second small droplet works):

```yaml
builder:
  arch: amd64
  context: ..
  dockerfile: lazy-teams/deploy/Dockerfile
  remote: ssh://root@YOUR_AMD64_BUILDER_IP
```

Kamal builds on the remote host and pushes to ghcr — your laptop does not need amd64 emulation.

## 4. Choose an access method

### Option A: SSH tunnel (default — not exposed)

Use this when you want to kick the tires on a cloud box without putting Lazy Teams on the public internet.

1. Leave `proxy.ssl: false`, `APP_HOST: localhost`, and `FORCE_SSL: false` as shipped.
2. Keep ports **80** and **443** closed in the firewall.
3. Deploy (section 5).
4. On your laptop, forward the proxy port:

```bash
ssh -L 3000:127.0.0.1:80 root@YOUR_DROPLET_IP
```

5. Open `http://localhost:3000/` and complete the in-browser setup.

Plain HTTP over the tunnel is intentional: `FORCE_SSL=false` keeps the session cookie working. Do not open the droplet's port 80 to `0.0.0.0` for this option.

### Option B: Tailscale

Use this when the droplet joins your Tailscale network and you want HTTPS without a public DNS name.

1. Install Tailscale on the droplet and your laptop; note the MagicDNS name (e.g. `teams-droplet.tailnet-name.ts.net`).
2. In `deploy.yml` set:

```yaml
proxy:
  ssl: false
  # …healthcheck unchanged…

env:
  clear:
    APP_HOST: teams-droplet.tailnet-name.ts.net
    FORCE_SSL: true
    ASSUME_SSL: true
```

`ASSUME_SSL` is required when Tailscale Serve (or a Cloudflare Tunnel) terminates TLS **without** sending `X-Forwarded-Proto` — otherwise the app redirect-loops. Leave the cloud firewall closed on 80/443; reach the install over the tailnet (or Tailscale Serve on the droplet).

3. Deploy, then open `https://teams-droplet.tailnet-name.ts.net/` (or your Serve URL).

### Option C: Public HTTPS with Let's Encrypt

Use this only when you intentionally want a public hostname.

1. Point an A record at the droplet. Open ports **80** and **443** (and keep **22** restricted).
2. In `deploy.yml`:

```yaml
proxy:
  ssl: true
  host: teams.example.com
  app_port: 80
  healthcheck:
    path: /up
    interval: 3
    timeout: 5

env:
  clear:
    APP_HOST: teams.example.com
    # FORCE_SSL defaults to true when unset — omit FORCE_SSL: false
```

`proxy.host` and `APP_HOST` must match. Deploy, then open `https://teams.example.com/`.

## 5. Deploy

From `lazy-teams/` on your laptop:

```bash
bin/kamal secrets print   # confirm values look right — no garbage suffixes
bin/kamal config          # config renders without error
bin/kamal setup           # once: Docker network, kamal-proxy, registry login on the server
bin/kamal deploy --skip-push --version=<release-tag>   # the release tag you are deploying, e.g. v0.23.1234
```

Use `--skip-push` when deploying the **pre-built** image from ghcr without rebuilding on your laptop. Images built from `lazy-teams/deploy/Dockerfile` include a `service=lazy_teams` label so Kamal can prune old images cleanly; older published tags without that label still deploy, but pruning may leave unused images behind.

**First boot takes a minute or two** while the database is prepared and Rails boots. Watch logs:

```bash
bin/kamal logs
```

When deploy finishes, open the URL for your access method (section 4) and complete the in-browser setup (first administrator, team name, invitations) — same as the compose path.

## 6. Smoke checks

After deploy, verify:

```bash
# Option A — with the SSH tunnel up:
curl -fsS "http://localhost:3000/up" && echo OK

# Option C — public HTTPS:
# curl -fsS "https://teams.example.com/up" && echo OK

# Both named volumes exist on the droplet
ssh root@YOUR_DROPLET_IP docker volume ls | grep lazy_teams
```

The app container is deliberately not given your Docker socket, so there is
nothing to check there — `docker info` inside it is expected to fail, and that
is the install behaving correctly.

Sign in and create a project — that proves provisioning, hosted git and the project daemon are working. Starting a task is refused on purpose; see [task turns](./self-hosting-lazy-teams.md#task-turns).

## Upgrading

```bash
bin/kamal deploy --skip-push --version=NEW_TAG
```

Project data in the two volumes survives container replacement. Your projects restart on the new version automatically, within a minute or so of the app coming up.

If your install predates the image-layout change, update the repository checkout along with the image tag. The storage volume's mount point inside the image moved from `/rails/storage` to `/lazy/lazy-teams/storage` — the `lazy_teams_storage` volume and your data are unchanged — and deploying the new image under the old `deploy.yml` would mount the volume where the app no longer looks, so the app would come up against an empty database. Deploying from an up-to-date checkout is all it takes.

## Backing up and moving off the box

All durable state lives in two Docker volumes on the droplet:

| Volume | Contents |
|--------|----------|
| `lazy_teams_storage` | Rails SQLite databases (teams, users, encrypted credentials, Solid Queue/Cache/Cable DBs) |
| `lazy_teams_fleet` | Per-project task stores, git clones, daemon state, hosted bare repos |

Back up both before major changes or migration:

```bash
# From your laptop — stop the app so SQLite files are quiesced
cd lazy-teams
bin/kamal app stop

ssh root@YOUR_DROPLET_IP 'mkdir -p /root/lazy-teams-backup && docker run --rm \
  -v lazy_teams_storage:/from/storage:ro \
  -v lazy_teams_fleet:/from/fleet:ro \
  -v /root/lazy-teams-backup:/backup \
  alpine sh -c "tar czf /backup/lazy-teams-\$(date +%Y%m%d).tgz -C /from storage fleet" && \
  ls -lh /root/lazy-teams-backup/'
```

Copy the tarball off the droplet with `scp`. Restart with `bin/kamal deploy` (or `bin/kamal app boot` if you only stopped). To restore on a new server, recreate the volumes and extract before your first `kamal deploy`.

DigitalOcean **Volumes** (block storage) can hold tarball backups off-droplet; the running install uses Docker named volumes on the droplet disk by default, which is enough for a single-box deployment.

## What this guide cannot verify for you

The steps above were written and validated against the Kamal configuration and production boot requirements in the repository. A full end-to-end deploy needs **your** DigitalOcean account and registry credentials. Run these yourself and treat the output as the source of truth:

```bash
cd lazy-teams
bin/kamal secrets print
bin/kamal config
bin/kamal setup
bin/kamal deploy --skip-push --version=YOUR_TAG
bin/kamal logs -f
```

If something fails, use **God mode → Troubleshooting** in the web UI (site administrator).

## Getting help

- [Self-hosting Lazy Teams (compose path)](./self-hosting-lazy-teams.md) — environment variables, task isolation, hosted git
- [Agents in Lazy Teams](./lazy-teams-agents.md) — Claude/Cursor credentials after install
- [Slack rooms](./slack-rooms.md) — Socket Mode setup (no public URL required for Slack)
