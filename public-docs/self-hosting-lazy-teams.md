# Self-hosting Lazy Teams

Lazy Teams is a web application your team runs on a server you control. This guide takes you from a fresh Linux machine to a running install where every project, and every agent turn it runs, gets its own microVM.

## What you need

- A Linux server with **Docker Engine** and **Docker Compose v2** (v2.24 or later) installed
- **Hardware virtualization (KVM)**: a `/dev/kvm` device on the server. Bare-metal servers have it; many cloud VMs do not, because they do not offer nested virtualization. Without it the install still runs everything except agent turns — see [Task turns](#task-turns)
- At least **4 GB RAM** and **20 GB disk** (more if many projects or large repositories)
- For automatic HTTPS: a **public DNS name** pointing at the server, with ports **80** and **443** open

You do **not** need Ruby, Bun, lazy, or a git checkout on the host — pull the published image and go.

Running on a **Mac** instead? The published image cannot run agent turns there, because Docker Desktop does not pass hardware virtualization into containers. A route that runs Lazy Teams directly on the Mac, without Docker, exists but is not published yet.

## Quick install (pull-and-go)

Copy the deploy bundle from a [lazy release](https://github.com/getlazy/lazy/releases) (the `lazy-teams/deploy/` directory) onto your server, or clone the repository if you prefer.

```bash
cd lazy-teams/deploy
./bootstrap.sh
docker compose pull
docker compose up -d
```

`bootstrap.sh` writes a `.env` file with generated secrets. Edit `.env` and set `APP_HOST` to the hostname people will use in the browser before enabling TLS.

`bootstrap.sh` also checks for `/dev/kvm`. If the server has none, it adds a `COMPOSE_FILE` line to `.env` so that `docker compose` starts the install without microVMs, and says so. See [Task turns](#task-turns) for what that means and how to undo it once the server has KVM.

Use `docker-compose` instead of `docker compose` if your host has the standalone binary but not the Compose plugin — `bootstrap.sh` accepts either.

The default image is `ghcr.io/getlazy/lazy-teams:latest`. Pin a specific release in `.env`, replacing `<release-tag>` with the tag of the release you are installing (for example `v0.23.1234`, as listed on the [releases page](https://github.com/getlazy/lazy/releases)):

```
LAZY_TEAMS_TAG=<release-tag>
```

The same image, with the same tags, is also published on Docker Hub as `docker.io/getlazy/lazy-teams`. To pull from there instead, set `LAZY_TEAMS_IMAGE=docker.io/getlazy/lazy-teams:<release-tag>` in `.env`. `LAZY_TEAMS_IMAGE` replaces the whole image reference, so put the tag in that value; `LAZY_TEAMS_TAG` has no effect once it is set.

Open `http://localhost:3000/` (or the port in `APP_DIRECT_PORT`). The in-browser setup flow walks you through creating the first administrator account, naming your installation, and inviting teammates. **This guide stops where the browser takes over** — you do not need a shell account to finish onboarding. Registering, cloning and starting a project need no model credential. To run tasks, every person — you and each teammate you invite — connects their own model credential (for example their Claude account), because each task bills the account of whoever starts it; setup and the project page link straight to that settings page.

### First boot takes a minute or two

The container prepares its database and starts the web app. Watch progress with:

```bash
docker compose logs -f app
```

## The direct port is local-only

The port in `APP_DIRECT_PORT` is published on the loopback interface, so it is reachable from the server itself and nowhere else. It carries plain HTTP: the session cookie that identifies an administrator crosses it in the clear, and published on every interface it would put the whole application, unencrypted, on whatever network the server sits on.

To use it from your laptop, forward it over SSH rather than opening it up:

```bash
ssh -L 3000:127.0.0.1:3000 you@your-server
```

For a permanent install, put HTTPS in front instead — either option below. If you have your own edge that already terminates TLS and needs to reach the container directly, set `APP_DIRECT_BIND=0.0.0.0` in `.env` deliberately, and firewall the port.

## Automatic HTTPS

When your server has a real public hostname:

1. Set `APP_HOST=teams.example.com` in `.env`
2. Set `FORCE_SSL=true` in `.env` (`bootstrap.sh` writes `false` for a `localhost` install)
3. Optionally set `ACME_EMAIL` for Let's Encrypt expiry notices
4. Start with the TLS profile:

```bash
docker compose --profile tls up -d
```

Caddy obtains a certificate and proxies HTTPS to the application. Caddy reaches the app over the internal compose network, so the direct port stays local-only and needs no change.

## Behind your own reverse proxy

If you already terminate TLS elsewhere (nginx, Traefik, Caddy of your own, a cloud load balancer, Tailscale serve, a Cloudflare Tunnel):

1. Run without the `tls` profile: `docker compose up -d`
2. Proxy HTTPS to `http://127.0.0.1:3000` (or your `APP_DIRECT_PORT`) on the server
3. Set `APP_HOST` to the public hostname, so links in emails are correct and the app answers to that name
4. Leave `FORCE_SSL` at its default of `true`

Step 4 works whether or not your proxy sends an `X-Forwarded-Proto` header. Some terminators — Tailscale serve and Cloudflare Tunnel among them — do not, and an app that judged the scheme from that header alone would redirect such a request to HTTPS forever. This install treats traffic arriving on the direct port as already-encrypted, which is true when the only thing that can reach that port is your own proxy.

## Serving over plain HTTP

An install on a trusted internal network with no TLS anywhere needs `FORCE_SSL=false` in `.env`. Without it, cookies are marked `secure` and browsers will not send them back over plain HTTP, so sign-in appears to silently fail.

This also switches emailed links to `http://`. It is the right setting for a loopback quick start and for a lab network; it is the wrong setting for anything reachable from the internet, where it puts the administrator's session cookie on the wire in the clear.

## Which hostnames the install answers to

The app answers requests for `APP_HOST`, `localhost` and `127.0.0.1`, and refuses everything else with **Blocked host**. This is what stops a request carrying a forged `Host` header from turning a password-reset email into a link to somebody else's server.

Two consequences worth knowing before they surprise you:

- Change `APP_HOST` when you move the install to a new name, or it will refuse the new one.
- A second name, or a health check that arrives with an internal `Host` header, goes in `ALLOWED_HOSTS` as a comma-separated list. The health check at `/up` is exempt, so an uptime monitor hitting it by IP works without any configuration.

## Sign-in and git rate limits

Repeated failed sign-ins from one address are refused for a few minutes, and so are repeated password-reset requests. The same applies to the git endpoints when you host repositories on the install — but there the count is of **failed** authentications, not requests, so ordinary `git clone`, `fetch` and `push` traffic is never throttled no matter how much of it there is. Git failures are counted per token, so one broken token does not block any other token — not even another of the same member's; a pause is shown on that member's project page and on the administrator's project diagnostics page.

Nothing is configurable here, and nothing needs to be turned on.

## Outgoing email (optional)

The install **boots without SMTP**. Password resets and invitations are created, but nothing is sent until you configure mail.

Add to `.env` (see `.env.example` for the full list):

```
SMTP_ADDRESS=smtp.example.com
SMTP_PORT=587
SMTP_USER_NAME=lazy-teams@example.com
SMTP_PASSWORD=…
MAILER_FROM=no-reply@example.com
```

After restarting, an administrator can verify delivery from **Settings → Email** in god mode.

## Private repositories and forge connections

Each member brings their own GitHub or GitLab connection (**Account settings → Forge connections**, from your avatar menu), the same way each member brings their own Claude credential. Your connection clones and pushes as you:

- **Cloning.** A project clones with the connection of the member who registered or started it — never another member's. When the fleet retries a project by itself (for example after you connect an account), it clones as the member who registered the project. The token reaches git as a credential only: it is never put in the repository URL, the clone's configuration, logs or error messages.
- **Registering.** If you register a GitHub or GitLab URL and have no connection for that forge, Lazy Teams says so before cloning anything: connect one, or confirm the repository is public — public repositories need no connection.
- **Pushing and pull requests.** Pushes, pull and merge requests (`lazy submit`) and review reads use the connection of whoever last set the project up or started it. Projects that run on their own machine (the default) include the `gh` and `glab` command-line tools, which use that connection directly — there is nothing to log in to.
- **Use the HTTPS URL.** A token authenticates only over HTTPS, so SSH addresses (`git@github.com:owner/repo.git`) are refused with the HTTPS address to use instead.

## If a repository cannot be cloned

When a project's repository cannot be cloned, its page says so: the project shows as **failed**, with the cause in plain words and the next step.

- **"This repository needs a GitHub (or GitLab) connection with access to it"** — the repository is private, or the connected token cannot read it. Follow **Connect GitHub →**, connect an account whose token can read the repository, and press **Retry setup** — the Forge connections page offers it too.
- **"The repository URL could not be reached"** — the URL is wrong or points at nothing. A team admin corrects it on the project's **Settings → General** page and presses **Retry setup** there.

Team admins also see what git said, with any credential removed. Retry setup is available to team admins and to whoever registered the project. You do not need to read the server's logs for either case.

## Where data lives

Two Docker volumes hold everything that must survive an upgrade. **Back up both** — losing either loses the install:

| Volume | Contents |
|--------|----------|
| `lazy_teams_storage` | Rails database (teams, users, encrypted credentials) |
| `lazy_teams_fleet` | Per-project task stores, git clones, daemon state, and install-hosted bare repositories |

Project task history lives in the fleet volume; team membership lives in the storage volume.

### Keeping the fleet on your own filesystem

The fleet volume is a Docker named volume. On Docker Desktop that lives inside
Docker's Linux VM: you cannot `ls` it, point a backup tool at it, or open a file
in it without going through a container.

Set `LAZY_FLEET_HOST_PATH` in `deploy/.env` to an absolute path on this machine
and the whole fleet root lives there instead:

```
LAZY_FLEET_HOST_PATH=/Users/you/lazy-fleet
```

Create the directory first, then start the stack as usual. Everything the fleet
owns — every project's task store, its clone, its daemon state — appears under
that path. This is what makes the stores ordinary files you can back up, and it
is required if you want to hand an existing store to the install (below).

Unset, nothing changes: the install keeps using the named volume.

**Do not move or re-create that directory while the install is running.** A bind
mount follows the *path*, not the directory that was there at startup, so
replacing it swaps what the running containers see. Stop the stack, move the
directory, point `LAZY_FLEET_HOST_PATH` at the new location, and start again.

## Adopting an existing store

If you have been running lazy locally on a project — a daemon on your own
machine, with its task history in a store directory — you can hand that history
to a Lazy Teams install instead of starting over. Hundreds of tasks, their
turns, their commits and their reviews come across intact.

**This is a one-way move, done once.** Afterwards Lazy Teams owns the daemon and
the store. There is no syncing back, and no way to run both.

### Before you start

- The fleet root must be on this machine's filesystem —
  `LAZY_FLEET_HOST_PATH`, above. The adoption names a directory, and the install
  has to be able to reach it.
- Know where your store is. It is the directory named by `external_path` under
  `[storage]` in the project's `lazy.toml`; if there is no such key the store is
  `.lazy/` inside the checkout.
- Upgrade the install first if it is behind the lazy that wrote the store.
  Adoption refuses a store whose **storage format** is newer than the install
  understands, but that format changes rarely — so this check will not catch
  every version difference, and running the newer lazy is on you.

### 1. Stop the local daemon

On the machine that owns the store, in the project checkout:

```
lazy daemon stop
```

Then check nothing is holding it any more:

```
lazy system store-check ~/.lazy/my-project
```

That prints the store's task count, its schema version, whether anything holds
its lock, and which people its rows name. `Lock: none` is what you are waiting
for. It writes nothing and is safe to run against a store that is still in use —
if a daemon is up it will say so, with the process id.

### 2. Adopt it

On the machine running Lazy Teams, from the deploy directory:

```
docker compose exec app bin/rails lazy:adopt_store \
  TEAM=your-team NAME="My Project" \
  REPO_URL=https://github.com/you/my-project.git \
  STORE=/var/lib/lazy-fleet/incoming/my-project \
  AS=you@example.com DRY_RUN=1
```

`STORE` is the path **as the app container sees it**. With
`LAZY_FLEET_HOST_PATH=/Users/you/lazy-fleet`, a store you put at
`/Users/you/lazy-fleet/incoming/my-project` on your Mac is
`/var/lib/lazy-fleet/incoming/my-project` in the container. Copy or move your
store under the fleet root first — it does not have to be there permanently, but
the container can only see paths that are mounted into it.

`TEAM` is the team's slug or its name as shown on the page; a name shared by two teams is refused, so use the slug then.

`AS` is the email of the team member the adoption acts for, exactly as if
they had added the project themselves: the repository is cloned with **their**
GitHub or GitLab connection, their Claude credential is the one the project
starts with, and they are recorded as the project's registrant, so any later
automatic restart clones as them too. A **private repository needs it**. The
member must belong to `TEAM` and must have connected the repository's forge in
their settings, or the adoption refuses before creating anything. Without
`AS`, the clone runs with no member's forge credential, which a private
repository refuses unless the team has a shared GitHub integration. If it fails,
the message says so; a team admin who has connected the forge (or the member
named in `AS`) can press **Retry setup** on the project's page, which clones with
their own connection. To re-run the adoption instead, delete the failed project
first.

`DRY_RUN=1` runs every check and changes nothing. Drop it to do the adoption:

```
docker compose exec app bin/rails lazy:adopt_store \
  TEAM=your-team NAME="My Project" \
  REPO_URL=https://github.com/you/my-project.git \
  STORE=/var/lib/lazy-fleet/incoming/my-project \
  AS=you@example.com
```

The store is always **copied** into the fleet's own layout. Your original
directory is only read, never written — not even to clear a stale lock. A
`COPY=1` left over from an older script is ignored, with a note saying so.

Because it is a copy, do the adoption with the local daemon stopped (step 1).
A copy of a store that a daemon is still writing can catch a task mid-write, and
tasks that were `working` in it may be resumed by the new project. The command
prints a warning about this before it copies, and refuses if the store's lock
shows something is serving it.

A project adopted by an older version of this command may still be serving your
original directory in place. It keeps working, and it does not stop you adopting
the same store again as a copy: the command prints a warning naming that project,
because its daemon still writes the directory being copied. Pick a different
`NAME`, or remove the old project first with `bin/native-rails
lazy:reset_projects` (your original is not deleted). Both commands name the
environment and database they use before doing anything; run from a checkout's
own database, `lazy:reset_projects` refuses to delete unless you add
`ALLOW_DEV_DB=1`.

The adoption then starts the project, and prints each step as it happens —
creating the machine and pulling its image, restoring or cloning the repository
(and whose forge connection it clones with), `lazy init`, starting the daemon —
with how long each took. If a step fails, its own output is printed under it.
The project page shows the same steps.

### What it refuses, and why

| Refusal | What to do |
|---|---|
| `AS` is not a member of the team, or has no connection for the repository's forge | Name a member of `TEAM`, and have them connect GitHub or GitLab in their settings first. The clone runs as them. |
| The store's lock is still held | Something is serving that store right now. Stop the daemon on the machine that owns it (step 1); a copy taken now would be a snapshot in the middle of a write. |
| The store's format is newer than this install understands | Upgrade this install first. Older code reading a newer store drops what it does not understand, silently. |
| The store still names people by old account numbers | It was written before Lazy named people by email. Back it up, run the attribution rewrite the error prints, then adopt again. |
| The store names people this install cannot identify | Its rows were written by a different Lazy Teams install, whose account numbering is not this one's. Adopting would show one person's work under another person's name. Create the matching accounts first, or adopt into the install that wrote it. |

A store from a personal, single-person install names nobody and passes the last
check without anything to do.

### 3. Verify in Teams

Open the project in the web UI. The task list is your history: the same tasks,
the same turns, the same reviews. While it starts, the project page lists each
step as it happens; if a start fails, it names the step that failed and what to
do about it.

### 4. Never run a local daemon against the original again

Your original store is untouched, but from now on Lazy Teams owns the project's
history. A local daemon that keeps writing the original would fork it, and
anything it did there never reaches the install. On the machine you copied it
from:

- **before running any other `lazy` command in that checkout**, move or rename
  the store directory the old `lazy.toml` points at. `lazy login` and
  `lazy logout` never start a local daemon, but until the checkout is bound,
  any other `lazy` command in it can start one against that path;
- only then bind the checkout with `lazy login` (below). A bound checkout never
  starts a local daemon.

### Working on the project afterwards

Your checkout keeps working — it talks to Lazy Teams instead of a daemon on
your machine. Bind it once, inside the checkout, and pick the adopted project
when asked:

```
lazy login https://teams.example.com
```

The whole flow is in [logging a machine in](teams-login.md). From a bound
clone:

- **The ordinary commands work** — `lazy list`, `lazy show`, `lazy diff`,
  `lazy create`, `lazy start`, `lazy unblock`, `lazy accept` and the rest — run
  through the install, as you, exactly as if you had used the browser.
- **`lazy builder` attaches to your builder on the server**, next to the
  project. It is the same session the **Builders** page opens, and its
  conversation stays with the project.
- **A Claude Code you run yourself** can use the project's `lazy_*` tools
  through the install, with fewer capabilities than the server-side builder —
  see [Claude Code against a Lazy Teams project](teams-bound-clone-agents.md).

Some things are refused. Each refusal says why, and what to use instead where
there is an alternative:

- commands that manage a local daemon — `lazy daemon start` / `stop` /
  `status`, `lazy init`, `lazy doctor`, `lazy dashboard` — because a bound
  clone has none. These refusals suggest `lazy logout` as the way back to
  working locally; **in an adopted checkout, do not follow that suggestion**;
- options that go beyond what the browser can do, or skip a check it enforces;
- `lazy pair` and `lazy shell`: a task's container runs on the account of
  whoever started the task, so entering it in your name is not offered on a
  Teams install;
- a few tools only a server-side builder or the web UI can use.

What does not change is the warning above: **never run a local daemon against
the adopted store.** A bound clone never starts one. `lazy logout` returns a
checkout to working locally — never do that in a checkout whose store you
handed over.

## Renaming a project or a team

A team admin or owner can rename a project from its **Settings → Rename**, and a
team from the **Rename** button on the team page. Site admins can do both in
god mode. Both the name and the slug — the part of the address in URLs and in
`lazy login --project team/project` — can change, under the same rules as when
it was created. You confirm by typing the new slug.

- **The running project is untouched.** Its data, machine, repository and
  credentials stay where they are; nothing restarts.
- **The old name is free at once.** A new project, or an [adoption](#adopting-an-existing-store),
  can take it. It gets a fresh project with nothing carried over from the
  renamed one. This is how you move a project aside and bring a new one in
  under its name:

  ```
  # 1. Settings → Rename: lazy-dev → lazy-dev-old
  # 2. adopt the new store under the old name
  bin/rails lazy:adopt_store TEAM=acme NAME="lazy-dev" REPO_URL=… STORE=…
  ```

- **Old addresses stop working.** Pages at the old address answer "not found".
  There is no redirect, because it would send people to whichever project takes
  the name next. Clones bound with `lazy login` keep reaching the renamed project
  (see [logging a machine in](teams-login.md#when-the-project-or-team-is-renamed)).
- **A hosted repository keeps its clone URL.** The project's own copy of the
  repository fetches and pushes that URL, so it stays the same after a rename
  and keeps reaching the renamed project. A new project that takes the old name
  gets a URL of its own (`…/git/acme/lazy-dev-2.git`), never the renamed
  project's repository.
- **A Slack room keeps its channel.** Rooms are tied to the project, not its
  name, so the channel keeps its old name and keeps working. A new project that
  takes the old name gets a room under the next free channel name.

## Hosting repositories on the install

When you add a project, choose **Host on this install** instead of pasting a GitHub or GitLab URL. The install keeps a bare repository for that project and serves `git clone`, `fetch`, and `push` over HTTPS (smart HTTP) at a URL under your `APP_HOST`.

Git prompts for credentials over HTTP Basic. Use any username git accepts and an
**Git & CLI token that includes git access** as the password. Tokens are scoped: git
smart HTTP accepts only git-capable tokens, so a token minted for CLI or MCP
access alone is refused even if it is otherwise valid.

When you choose **Host on this install**, Lazy Teams provisions or reuses a
git-scoped token for clone/push operations automatically. For manual
`git clone`, `fetch`, or `push` from your own machine, create a token with git
access from **Account settings → Git & CLI tokens** (from your avatar menu) in the web UI. Pick a label, enable
**Git**, and copy the value when it is shown — it cannot be displayed again.
Tokens created before scoping was introduced still include both git and CLI
access until you rotate them.

Every team member can clone and fetch; only team admins and owners can push.

The URL shown on the project page is the public one under `APP_HOST`. Inside a project's microVM that address is usually unreachable (on a single machine it is `localhost`, which inside the VM is the VM itself), so the project's own copy of the repository uses the install's internal git address instead — see [`smolvm`](#smolvm-default-one-project-per-microvm). You do not configure anything for this.

To connect a machine's command line to the install instead, use
[`lazy login`](teams-login.md) — it mints a CLI-scoped token for you through a
browser approval, so nothing is pasted.

This path is for teams that want Lazy Teams to be the only shared server — no external forge required. External remotes (GitHub, GitLab, and so on) still work the same way when you register a project with their URL instead.

## Task turns

**With hardware virtualization, each project gets its own microVM,** and its agent turns run inside it. What has been confirmed on real hardware so far: a project provisioned and ran an agent turn in a microVM on an Apple Silicon Mac, and the microVM runtime passed its hardware checks on a Linux server with KVM, both with Lazy Teams running directly on the machine. **Running it from inside the published container, as the compose install does, has not yet been confirmed on real hardware** — [Confirming it on your server](#confirming-it-on-your-server) below is how to check yours before you rely on it.

Each project gets its own microVM, and its agent turns run inside it. A project's repository is cloned inside its VM and never touches your server's filesystem. The server shares only that project's task store with it. The VM carries its own Docker engine, so a task's agent container runs next to the project process that launched it, and no Docker socket is shared with anything.

The compose install passes one device into the application container: `/dev/kvm`, which lets it create virtual machines and nothing more. It is not the Docker socket, no capability is added, and the container stays unprivileged. The application runs the microVM runtime as an ordinary user (uid 1000) in the device's group, which the container joins by itself unless that group id is already used by another group inside the image (see [below](#run-it-as-an-unprivileged-user-in-the-kvm-group-never-as-root)). The runtime ships inside the image, fetched at build time from a pinned release and checked against a recorded checksum. The image each project boots defaults to `ghcr.io/getlazy/lazy-daemon` at the **same version tag as the Lazy Teams image you run**, so an application and its projects are always the same version of lazy.

Everything else that runs an agent — generating a report, asking a question about a stored conversation, compacting memory, resolving a sync's merge conflicts — runs in the project's microVM too.

### Confirming it on your server

Run these on the server, in the deploy directory, once setup's readiness step shows **MicroVM host**, **MicroVM runtime** and **Project image** passing.

**1. The runtime's own checks, inside the application container, as the user the application runs as.** This starts short-lived test microVMs, checks that a port inside one can be reached, that the project folder is shared into it correctly, and that the project image boots, then removes everything it created:

```bash
docker compose exec --user rails app sh -c 'LAZY_DAEMON_IMAGE="${LAZY_DAEMON_IMAGE:-ghcr.io/getlazy/lazy-daemon:$LAZY_TEAMS_VERSION}" bin/smolvm-hardware-probe --stage 1,2,3'
```

It takes a few minutes and ends with a summary of `RESULT <name> PASS|FAIL|INFO|SKIP -- <detail>` lines, plus the path of a report directory with a log per step. **Every line should read `PASS`** (`INFO` and `SKIP` are informational). A `FAIL` names the step; keep the report directory, which says what it saw. Do not run it as root: the runtime refuses to work that way (see below).

**2. A real task.** Create a project, start a task on it, and let the agent finish a turn. The first start of a project boots its microVM and pulls the project image, and its first task builds a task-container image inside the VM, so allow several minutes. The turn finishing, with its commits on the task, is the confirmation that matters.

If either fails and the logs point at the container rather than your server — the microVM refusing to start although the same server runs it outside a container — please report it with the report directory. Do not widen what the container is given (privileged mode, extra capabilities) to get past it.

### A server without KVM

Without `/dev/kvm` the install runs **everything except agent turns**: accounts, teams, projects, hosted repositories, the task list, reviewing and accepting work. Starting a task reports that agent containers cannot be launched, and the task does not run. The same goes for anything else that needs an agent. A sync with no merge conflicts works, because it needs no agent.

Compose cannot start a service whose device does not exist, so on such a server the install has to be started without it. `bootstrap.sh` does that for you when it finds no `/dev/kvm`, by writing this line to `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.local-backend.yml
```

`docker-compose.local-backend.yml` drops the device and sets `LAZY_FLEET_BACKEND=local`, so every project's process runs inside the application container instead of in a microVM. If you pass compose files with `-f`, add it yourself:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-backend.yml up -d
```

Once the server has KVM, delete the `COMPOSE_FILE` line from `.env` and run `docker compose up -d` again. Until you do, the install keeps running without microVMs; re-running `bootstrap.sh` points out a line left behind like that.

If `LAZY_FLEET_BACKEND` is left at its default on a server that cannot run microVMs, nothing fails silently. The readiness step in setup, and the Installation page in god mode, show which of **MicroVM host**, **MicroVM runtime** and **Project image** failed, with the fix for each and this escape hatch. Setup does not continue until they pass or the backend is set to `local`.

Most cloud VMs cannot run microVMs, because their provider does not offer nested virtualization. Bare-metal servers can.

### Why the `local` backend cannot run turns in the container

On the `local` backend, every project's process runs *inside* the application container. An agent turn runs in its own container created by your host's Docker, and the project process that asks for it would be describing files and network addresses that exist only inside the application container. The project checkout, the task's working copy and the agent binary would all name paths the host does not have, and the agent would have no route back to the process that launched it. Rather than start a container that cannot work, the project refuses and says so.

Giving the application your host's Docker would not change that — the problem is the paths, not permission — and the install does not ask for that access at all; see [below](#your-docker-socket-stays-on-your-host).

### Reaching a task's running services

A task that declares services to run (a web server, say) is reached through its project's process, and in the compose install that process listens on the application container's own loopback interface. The addresses the project page shows for those services therefore do not answer from a browser on the server or elsewhere. Running agent turns does not depend on this.

## How the pieces fit together

The application container runs:

- **Rails + Solid Queue** — the product UI and background jobs
- **the microVM runtime** (`smolvm`), which starts one microVM per project, with the project's lazy process inside it

The application image is laid out the way the lazy repository is — the lazy
sources at `/lazy` with the web app at `/lazy/lazy-teams` — so the app finds
lazy without any path configuration, and the same layout works everywhere.

Where a project's process lives is what `LAZY_FLEET_BACKEND` selects.

### `smolvm` (default, one project per microVM)

Each project gets its own microVM. Its repository is cloned inside the VM and never touches your host's filesystem; the host mounts only that project's store directory. No Docker socket is shared with anything, and a project's process is reachable from the application only through a port published on the loopback interface. The VM carries its own Docker engine, so a task's agent container runs inside the VM next to the process that launched it.

Outbound network access from a VM is open to the public internet and closed to everything else: the VM cannot reach your host's loopback, your LAN (RFC 1918 ranges), link-local and cloud-metadata addresses, or other VMs. There is nothing to configure — a project's first turn builds its task-runner image from `Dockerfile.lazy`, which reaches package mirrors, container registries and language toolchains, and you should not have to enumerate those. The rule is enforced on destination IP addresses after name resolution, so a hostname that resolves to an internal address is refused just as the bare address would be.

There is one exception, and it is a single port. So that a repository hosted on the install can be cloned, fetched and pushed from inside a project's VM, each VM can reach one listener on the host's loopback, under the name `git.lazy.internal`. That listener serves the install's hosted repositories and nothing else — the same git access, with the same tokens, as the public address — and refuses any other request. Nothing else on the host becomes reachable. The listener binds `127.0.0.1` on the port one above the application's own (3001 beside 3000); set `LAZY_GIT_LISTENER_PORT` to choose another, or to `off` to run without it, in which case hosted repositories cannot be used from a VM.

It runs on a Linux host with KVM (x86_64 or arm64) and on an Apple Silicon Mac. It needs three settings, and the published image sets all three for you:

```
LAZY_FLEET_BACKEND=smolvm        # the default
LAZY_SMOLVM_BINARY=/opt/smolvm/smolvm
LAZY_DAEMON_IMAGE=ghcr.io/getlazy/lazy-daemon:<the Lazy Teams image's version>
```

The binary must be an absolute path to a copy whose checksum was recorded when it was obtained. A bare command name is refused, and so is a binary that no longer matches what was recorded.

`LAZY_DAEMON_IMAGE` names the image each project's microVM boots. The published Lazy Teams image defaults it to `ghcr.io/getlazy/lazy-daemon` at its own version tag. Anywhere else — an image you built yourself, for instance — there is no default, and a project refuses to start until it is set. The image is published for `linux/arm64` and `linux/amd64` as `ghcr.io/getlazy/lazy-daemon` and `docker.io/getlazy/lazy-daemon`, tagged with each exact build `v<major>.<minor>.<n>`. Pin that exact tag, the one matching your Lazy Teams version, and not `latest`: the application and its projects must run the same version of lazy. You can also build the image yourself from a lazy checkout with `scripts/publish-lazy-daemon-image.sh`. Its `--save <path>` writes a tar you can point `LAZY_DAEMON_IMAGE` at directly, which is also how you run with no registry access. A plain build leaves a local image tag you can name instead.

An unknown `LAZY_FLEET_BACKEND` refuses to start rather than falling back, so a typo cannot silently put you on a weaker boundary than you asked for.

#### Run it as an unprivileged user in the `kvm` group, never as root

The process running Lazy Teams — and so running smolvm — must be an ordinary user that can open `/dev/kvm`. **Running as root does not work.** As root, smolvm runs each microVM under its own separate unprivileged user id, and that id cannot read the project files Lazy Teams writes for it (they are private to the account that wrote them), so no project can start. Lazy Teams checks this before touching smolvm and refuses with the steps below. The readiness checks in setup, and the Installation page in god mode, show a **MicroVM host** row saying the same.

**The compose install already does this**: the application runs as uid 1000 and, at start, joins the group id your server gave `/dev/kvm` — unless that id already belongs to a group inside the image other than `kvm` (joining it would grant whatever that group can open there, not just the device), in which case it refuses and says so in the container log. The steps below are for a native install on Linux.

On a fresh server, as root:

```
useradd --create-home --groups kvm lazy
chown -R lazy: /path/to/fleet-root /path/to/vendored/smolvm /path/to/lazy-teams/storage
```

For an existing account, use `usermod -aG kvm <user>` instead and log in again so the new group applies. The user must own the fleet root (`LAZY_FLEET_ROOT`), the vendored smolvm directory, and the application's own database folder (`LAZY_TEAMS_STORAGE_DIR`, by default `storage/` beside the application), and Lazy Teams is then started as that user. If Lazy Teams was ever started as root, everything it created in those folders is owned by root, which is why the `chown` above is recursive.

The same check confirms that user can open `/dev/kvm`. If the device does not exist, enable hardware virtualization on the host; if Lazy Teams runs in a container, pass the device in (`--device /dev/kvm`, or `devices: ["/dev/kvm"]` in compose). If it exists but cannot be opened, the user is not in the device's group. In the compose install the container joins that group by itself, unless `/dev/kvm` belongs to group 0 (root) or to a group id the image already uses for something else, which it will not join: give the device its own dedicated group on the host (a `kvm` group, mode `0660`).

Do not work around this by turning off smolvm's per-VM user isolation. It is what keeps each microVM from running as root on your host.

#### Services on the host's public address are reachable from projects

A microVM may reach any public internet address, and that includes your server's **own** public address if its network card carries one (common on rented bare-metal servers). A service on the host that listens on all interfaces and is hidden only by a firewall in front of the server — your provider's edge firewall, say — is therefore reachable from every project. Bind host services to `127.0.0.1` where they do not need outside access, or firewall them on the host itself (for example with `nftables` or `ufw`), not only at the edge.

This includes Lazy Teams itself: the compose file publishes the application on `127.0.0.1` by default for this reason as well as the one in [The direct port is local-only](#the-direct-port-is-local-only). If you set `APP_DIRECT_BIND=0.0.0.0` or publish Caddy's ports, projects can reach them through your public address like anything else on the internet can.

### `local` (no microVMs)

Every project's process runs beside the application — in the compose install, inside the application container. That is the arrangement [A server without KVM](#a-server-without-kvm) describes: the product surface works, and agent turns do not run from it. Nothing is shared with your host's Docker in the compose install; see [below](#your-docker-socket-stays-on-your-host).

### Your Docker socket stays on your host

The application container is **not** given access to your host's Docker. It
used to be, so that it could start agent containers alongside itself — which,
as [Task turns](#task-turns) explains, it was never actually able to do. Agent
turns run in each project's microVM instead, on that VM's own Docker engine. Handing
a container your Docker socket is equivalent to giving root on the machine to
anything that can run code inside it, so it is no longer mounted.

You do not need to do anything about this, and nothing about running the
product needs it back: no part of the application opens the socket, and on the
`local` backend the per-project processes refuse to start agent work before
ever reaching for it.

Two optional things do want it, and both are opt-in:

- **The acceptance script**, which asks your Docker what it created in order to
  prove that a refused task really started nothing. It adds the socket itself
  for the throwaway stack it runs, and removes it afterwards.
- **`LAZY_TEAMS_BUILD_RUNNER=1`**, which builds the agent image on your host.
  Nothing in this install runs agents from that image: agent turns run inside
  each project's microVM.

If you are doing one of those, start the stack with the socket override merged:

```bash
docker compose -f docker-compose.yml -f docker-compose.docker-socket.yml up -d
```

Take it away again when you are finished. While it is in place, anyone who can
execute code inside the application container can control Docker on your host:
run only trusted administrators, and keep the host patched.

If the container then reports that it cannot use Docker, it prints what it saw —
the socket's owner, its permissions, whether it could join the socket's group,
and Docker's own error. Read that first; it tells a permissions problem apart
from a Docker daemon that is not running, which need different fixes. Two host-
side ones are common:

- **Docker Desktop (macOS or Windows)** — turn on **Settings → Advanced →
  "Allow the default Docker socket to be used"**, then recreate the stack.
  Without it, `/var/run/docker.sock` may not be the socket your Docker is
  actually listening on.
- **Do not** loosen the socket with `chmod 666`. That gives every process on
  the machine full control of Docker, which is equivalent to giving them root.

Running the application as root to get past this is not supported and is not a
workaround — it removes the boundary the rest of this page depends on.

## Environment reference

| Variable | Required | Purpose |
|----------|----------|---------|
| `APP_HOST` | yes | Public hostname for links, TLS, and the hosts the app answers to |
| `SECRET_KEY_BASE` | yes | Session signing (`bootstrap.sh` generates) |
| `AR_ENCRYPTION_*` | yes | Encrypts stored credentials (`bootstrap.sh` generates) |
| `LAZY_TEAMS_TAG` | no | Pin a published image tag (default: `latest`) |
| `LAZY_TEAMS_IMAGE` | no | Full image reference override (Docker Hub or a private registry); `LAZY_TEAMS_TAG` is ignored when set |
| `APP_DIRECT_PORT` | no | Direct HTTP port (default 3000) |
| `APP_DIRECT_BIND` | no | Interface the direct port publishes on (default `127.0.0.1`) |
| `FORCE_SSL` | no | HTTPS redirect, `secure` cookies, HSTS (default on) |
| `ASSUME_SSL` | no | Treat incoming traffic as encrypted (defaults to `FORCE_SSL`) |
| `APP_PROTOCOL` | no | Scheme in emailed links (defaults from `FORCE_SSL`) |
| `ALLOWED_HOSTS` | no | Extra hostnames the install answers to, comma-separated |
| `SMTP_*`, `MAILER_FROM` | no | Outgoing email |
| `ACME_EMAIL` | no | Let's Encrypt contact when using the `tls` profile |
| `LAZY_FLEET_BACKEND` | no | Where projects run: `smolvm`, one microVM per project (default), or `local`, the escape hatch for a host without hardware virtualization (no agent turns in the compose install) |
| `LAZY_SMOLVM_BINARY` | no | Absolute path to the verified smolvm binary. The published image sets it |
| `LAZY_DAEMON_IMAGE` | no | The image each project's microVM boots — the published `getlazy/lazy-daemon` at the exact version tag matching your Lazy Teams, a local image tag, or the path to a saved image tar. The published Lazy Teams image defaults it to its own version tag; never use `latest` |
| `COMPOSE_FILE` | no | Written by `bootstrap.sh` on a server without `/dev/kvm` to start the install without microVMs; delete it once the server has KVM |
| `LAZY_SMOLVM_CPUS`, `LAZY_SMOLVM_MEMORY_MIB`, `LAZY_SMOLVM_STORAGE_GIB` | no | Per-project VM size (defaults: 2 CPUs, 4096 MiB, 32 GiB) |
| `LAZY_SMOLVM_CREATE_TIMEOUT` | no | Seconds allowed for creating a project's VM, which includes the first download of the project image (default: 600). Raise it on a slow connection |
| `LAZY_GIT_LISTENER_PORT` | no | Loopback port of the listener project VMs reach hosted repositories through (default: one above the application's port, e.g. 3001). `off` disables it. Set it explicitly if background jobs run in a separate process from the web server |
| `LAZY_FLEET_HOST_PATH` | no | Absolute path on this machine to keep the fleet root in, instead of the `lazy_teams_fleet` Docker volume. Compose installs only |
| `LAZY_FLEET_ROOT` | no | Folder holding project data. Set in `docker-compose.yml` for the container install and normally not changed there |
| `LAZY_TEAMS_STORAGE_DIR` | no | Where the application's own database files go (default: `storage/` beside the application). |

## What an upgrade does

Pull the new image and bring the stack back up as usual. On the `local`
backend, your projects are restarted on the new version automatically, within a
minute or so of the app coming back — there is nothing to run and nothing to
wait for. Work that was in progress resumes on its own, keeping its
conversation and its uncommitted changes.

**On the microVM backend, existing projects move to the new version too**,
automatically and within a few minutes. A project's version there is the project
image its microVM was created from, so each project whose image differs from the
one the install is now configured with is listed as out of date on the
Installation page in god mode. Lazy Teams then replaces its microVM with one
built from the new image. Nothing is lost that belongs to you:

- The project's task history lives outside the microVM and is not touched.
- The project's clone is carried across byte-for-byte. That includes every
  task's worktree, uncommitted changes, unpushed task branches and each agent's
  conversation.
- A turn that was running is interrupted and resumes by itself on the new
  version, as it does on the `local` backend.

What does not carry over is anything else inside the old microVM: tools an agent
installed outside its worktree, and the container images and task containers it
had built. Each open task's next turn opens with a note saying its environment
was replaced, so the agent knows to reinstall what it needs. The first turn
afterwards also rebuilds the task container image, which takes a few minutes.

Carrying the clone needs free disk on this machine roughly the size of the
project's clone and worktrees, for the length of the replacement. If a microVM
cannot be replaced, for example because the clone could not be saved, the old
microVM is left exactly as it was and keeps running the old version. The project
is then retried and named on the Installation page, as below. If no project image
is configured, or the configured image file is missing, no project is replaced:
the Installation page says the version could not be read.

Before it replaces any project, Lazy Teams first boots the new project image in a throwaway machine. If that fails, or if replacing one project fails, it stops there: the projects it had not reached keep running on their old version, the Installation page in god mode says why in red, and the automatic restart waits 30 minutes before trying again. Fix the cause, then use **Restart all project daemons** to go ahead at once.

If your install predates the image-layout change, also refresh the deploy bundle from the release along with the image — see [Upgrading](#upgrading) below.

If a project cannot be brought back — its data folder is unreadable, say, or
something is holding it open — Lazy Teams retries it a few times, waiting longer
between attempts, and then stops trying and leaves it alone rather than
restarting it every minute. While a project is being retried, the Installation page in god mode shows what
the last attempt said and when the next one is due. It also says if the
automatic restart is not running at all. The Installation page names any project
in the given-up state too, and the project's own page says what went wrong. Deal with the
cause, then use **Restart all project daemons** to pick it up again.

## Building from source (development)

When you are developing lazy or Lazy Teams itself, build the application image from the repository checkout instead of pulling:

```bash
cd lazy-teams/deploy
./bootstrap.sh
docker build $(../../scripts/source-stamp-build-args.sh) -f daemon-image/Dockerfile -t lazy-daemon:local ../..
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

This path requires the full lazy source tree (the compose build context is the repository root). The application image takes lazy itself from the lazy daemon image, so that is built first; set `LAZY_DAEMON_BUILD_IMAGE` to build against a different one (not `LAZY_DAEMON_IMAGE`, which chooses the image project machines boot). Operators on a production server should use the pull-and-go flow above.

**Naming compose files with `-f` replaces the `COMPOSE_FILE` line in `.env`.** On a server without `/dev/kvm`, add `-f docker-compose.local-backend.yml` after `docker-compose.yml` in every such command — here and for the socket override below — or compose brings the device back and refuses to start. `bootstrap.sh` prints its commands with it already included when it chose it.

The published `ghcr.io/getlazy/lazy-teams` image (also on Docker Hub as `docker.io/getlazy/lazy-teams`) is multi-architecture (`linux/arm64` and `linux/amd64`); `scripts/publish-lazy-teams-image.sh --platform linux/arm64,linux/amd64 --push` builds the same thing from a checkout.

## Which build is running

Every Lazy Teams page shows its build in the footer — version, branch, commit and
whether it was built from a clean tree, e.g. `Lazy Teams v0.90.4100 (main@1a2b3c4, clean)`.
The same answer is available without signing in:

```bash
curl -s https://teams.example.com/version
```

In god mode, each project's page lists the build its daemon runs next to the app's.

## Verifying the install

From the source tree, an acceptance script checks the packaged topology end to end on the `local` backend, so it runs on any Docker host: health check, web UI, hosted git, project provisioning, and that starting a task reports the documented [task turns](#task-turns) limitation rather than hanging or failing obscurely:

```bash
bin/self-host-accept
```

The first run builds images and may take several minutes.

## Deploy from your workstation

If you have SSH access to the server, one command from a source checkout does the whole install — no shell session on the box, no copy-and-paste:

```bash
lazy-teams/bin/deploy-remote root@your-server
```

It runs over your own SSH agent (no credentials are stored on the server, and no secret from the server is ever printed) and announces each step before it runs: it records what the box is, installs Docker Engine and the Compose plugin from Docker's official apt repository if they are missing, puts the source on the box, writes only the `.env` keys the flags below name, brings the stack up, waits for it to become healthy, and then runs acceptance checks. A failure names the step, the command, the remote output, and the last 200 lines of container logs. The run ends with a pass/fail report and exits non-zero if anything failed.

The install it produces is reachable on the loopback interface only — the report tells you the `ssh -L` command to open it in your browser. Add HTTPS with one of the options above when you want it permanently reachable.

Useful flags:

| Flag | Effect |
|------|--------|
| `--diagnose` | Report the box as it is and change nothing: OS, Docker versions, containers, listening ports, volumes, disk and memory, `.env` keys with secret values masked, and recent container logs |
| `--dry-run` | Print every remote command that would run, in order, and contact nothing |
| `--teardown` | Stop and remove the containers **and their volumes**, after you type a confirmation word |
| `--branch <ref>` | Deploy a specific branch or tag |
| `--image <ref>` | Deploy a published image instead of building from source |
| `--app-host <name>` | `APP_HOST` for the install (default: the server's hostname) |
| `--source rsync` | Push the source from your workstation instead of having the box clone it — for a server with no git access of its own |
| `--accept-only` | Re-run the acceptance checks against what is already deployed |

The acceptance checks run in a throwaway compose project of their own, on a separate port, and remove it afterwards, so they never write into the install they are checking.

Re-running the command is safe at any point: every step is idempotent, and an interrupted deploy is resumed by running it again.

## Upgrading

Pull the new image tag and restart:

```bash
docker compose pull
docker compose up -d
```

If your install already has projects that were set up without microVMs, set `LAZY_FLEET_BACKEND=local` in `.env` before upgrading: an install never hands a project to a different backend than the one that set it up, and setup and the Installation page say so until the backend matches. A project set up before Lazy Teams recorded which backend made it, on a microVM backend, is refused too rather than guessed at; the refusal gives the one command that records its backend.

Project data in the two volumes above is preserved. On the `local` backend your projects restart on the new version automatically, within a minute or so of the app coming up; on the microVM backend each project's microVM is replaced on the new image shortly after — see [What an upgrade does](#what-an-upgrade-does).

Your existing `.env` is never rewritten, so two of the defaults above change under an install that predates them:

- The direct port moves to the loopback interface. If you were reaching it across a network, set `APP_DIRECT_BIND=0.0.0.0` to keep that working — or better, put HTTPS in front and leave it local.
- HTTPS is assumed. An install genuinely served over plain HTTP needs `FORCE_SSL=false`, or browsers will hold back the `secure` session cookie and sign-in will appear to fail.

An install that predates the image-layout change also needs the **deploy bundle refreshed, not just the image**: the storage volume's mount point inside the image moved from `/rails/storage` to `/lazy/lazy-teams/storage` (the `lazy_teams_storage` volume and your data are unchanged). Pulling the new image under a bundle that still mounts the old path would leave the app writing its database inside the container instead of the volume — a later container replacement would lose it. Copy the new `lazy-teams/deploy/` bundle from the release and run `docker compose up -d` again.

## Kamal and cloud deployment

For a **cloud VPS** (DigitalOcean droplet or similar) with Kamal — private by default (SSH tunnel / Tailscale), optional public HTTPS — see [Deploying Lazy Teams on DigitalOcean with Kamal](./deploying-lazy-teams-digitalocean.md).

The lazy-teams repository ships `config/deploy.yml` and `.kamal/secrets` for that path. For **local or single-box** self-hosting without SSH keys or a registry account, the docker-compose bundle above remains the supported path.

## Getting help

If a project is stuck after install, sign in as a site administrator and use **God mode**: each project's **Logs** page shows its most recent setup attempt, the setup commands and their output, the app's log lines about it and its daemon log, with credentials redacted; **App log** on the God mode dashboard searches the whole installation's — the app's lines and every project daemon's own log, filterable by project and by source. See the operator troubleshooting guide shipped with lazy-teams (`/admin/troubleshooting` when signed in as an administrator).

On the microVM backend, a project's god-mode page also has **Shell**: a terminal inside that project's microVM, opened in its repository with its daemon's environment, so `lazy` commands there talk to the project's running daemon. It is for site administrators only (not operators), it carries the daemon's credentials, leaving the page hangs up the connection, and every open is recorded in the project's logs. On the `local` backend there is no machine, and the page says so.

Lazy Teams also runs `lazy doctor` against every running project once an hour. What it finds is handled one of three ways:

- **Safe housekeeping is fixed automatically**: finished-task worktrees, orphaned containers, leftover upstream tracking on task branches, and conversations missing from the store. Every fix is logged. Removing stale runner images is left to an administrator, because projects on one machine share its images.
- **Problems that affect people's work** (for example a model credential that is refused, an unreachable repository host, or low disk) are shown to the project's members as a short notice on the project page and under the project's **Settings → Doctor**, which also says when the checks last ran (or that a recent result is not available). The notice says what is affected, not how to fix it, and when it was last checked. A project's admins also see which check failed and can press **Report this to support**, which sends the full finding to the installation's administrator. The notice then tells the admin who received it, whether support has seen it yet, and that it clears itself once the problem is fixed. In god mode, waiting reports are announced on the landing page and listed under **Support reports**, each linking to the project's doctor; **Mark as seen** lets the reporting admin know somebody looked. Reports also appear on the project's god-mode pages and in the app log. Viewed in god mode, the same notice shows the full finding, what can be done about it from Lazy Teams as a button — **Restart this project's daemon**, **Apply** for a remedy doctor can perform, or **Download support bundle** when Lazy Teams cannot fix it — plus **Check again** and an **Open doctor** link.
- **Everything else is shown only in god mode.** Open the project and choose **Doctor** to see the full report: every check with its detail, its remedy and since when it has been reported, what Lazy Teams has already fixed and who started it, a **Run doctor** button, and an **Apply** button for each remedy that doctor can perform itself. Apply first lists exactly what the remedy would touch, and acts only when you confirm. Doctor findings are not written to the app log; the project's **Logs** page links to Doctor. Starting, restarting or retrying setup of a project runs doctor again as soon as its daemon answers, so a fixed problem disappears from the project page within a minute. The support bundle is one JSON file — the doctor report, the installed lazy version, what admins reported and the project's recent log lines — with every credential the installation holds removed; send it to the lazy team.

## Agents and credentials

Once your team is running tasks, see [Agents in Lazy Teams](./lazy-teams-agents.md) for choosing an agent, setting a project default agent, and connecting your own credential for each agent a project offers.

## Diagnosing a builder that is slow to start or fails

Pressing **Start your builder** opens a page that follows the start: it says the builder is starting, moves to the builder's terminal once it is running, or shows why it could not start. The first start after an update can take a few minutes while the project prepares its container image; later starts are quick.

As a site administrator in god mode you have four places to look, all keyed by the **run id** — the id in the builder's address (`…/builders/runs/<run id>`):

- **The run's page** shows its latest **Start timeline**: every step with how long it took, and, for a start that failed, the step it stopped at and the error.
- **The project's Doctor page** lists **Builder runs** — each run's state and how its last start or run ended — with **Download run report** for each.
- **The project's Logs page**: search the run id. `Builder start: …` lines are the web app's half, `builder start [run …]` lines the project's. A start that failed before it had a run id is found by searching `builder start`.
- **`bin/builder-run-report <run id>`**, run on the machine that runs Lazy Teams from its `lazy-teams` directory. It reads the install `bin/native-start` runs (the environment file in `~/lazy-fleet` by default; name another with `--env-file`); for a development install prefix `RAILS_ENV=development` (for the Docker install: `docker compose exec app bin/builder-run-report <run id> --out - > run.txt`), writes everything about one run into one file: the timeline, the builder's current state and output, its log lines, and what the web app recorded. Credentials are removed.

A builder that stops on its own — at any point, not only while starting — has its exit code, last output and its own log recorded within a minute, and its log is kept on the project's disk, so it survives the builder and the project's machine being replaced. Once the builder is recorded as stopped, the end of that log is kept with the run and the file itself is removed. The support bundle includes the recent builder runs and the full report for the newest ones.
