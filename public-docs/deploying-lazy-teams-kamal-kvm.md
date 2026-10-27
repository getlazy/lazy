# Deploying Lazy Teams on a KVM server with Kamal, behind ngrok

This page covers one server with hardware virtualization (`/dev/kvm`), so every project runs in its own microVM, deployed with [Kamal](https://kamal-deploy.org) from your own checkout, with ngrok running on that server as the only way in. It also covers moving an existing native (macOS) install onto that server without losing anything.

For a server **without** KVM, see [Deploying Lazy Teams on DigitalOcean with Kamal](./deploying-lazy-teams-digitalocean.md). For the settings themselves (`APP_HOST`, `SERVICES_HOST`, the ngrok policies), see [Self-hosting Lazy Teams](./self-hosting-lazy-teams.md).

## What you need

- A Linux x86_64 server with `/dev/kvm`, `rsync`, and root SSH from your workstation. Docker is installed by the script if it is missing.
- On your workstation (the commands below assume macOS): `git`, `rsync`, `sqlite3`, `curl`, and `bundle install` run once in `lazy-teams/` so `bin/kamal` works.
- A paid ngrok plan with a wildcard domain you own, for example `*.example.com`: Lazy Teams answers at `teams.example.com` and every task service at another name under it. Add the wildcard under **Domains** in the ngrok dashboard, with the DNS records it lists.
- The key endpoint ngrok checks command-line tokens against, created as in step 2 of [Behind an authenticating proxy](./self-hosting-lazy-teams.md#behind-an-authenticating-proxy).

## How it is laid out

`lazy-teams/config/deploy.hetzner.yml` is a Kamal *destination* (`bin/kamal … -d hetzner`) laid over `config/deploy.yml`:

- **Images are built on the server** from the commit you have checked out: the lazy daemon image, then the Lazy Teams image from it, so the app and every project daemon run the same lazy. The app image goes to a registry that runs on the server and listens on its loopback only, so nothing is pushed to a third party and no registry credential is needed.
- **The smolvm backend** with `/dev/kvm` passed in. The fleet boots the daemon image as a file built from the same commit.
- **No public port.** kamal-proxy publishes nothing on the host. An ngrok agent, running as a Kamal accessory on Kamal's network, has ONE endpoint: the wildcard for your domain, which covers Lazy Teams' own name as well as every task service. Its Traffic Policy is Lazy Teams' own policy (Google sign-in, your allowlist, command-line tokens checked by ngrok, the trusted-proxy headers) for Lazy Teams' name, and the stricter services policy (every path signs in) for every other name. ngrok allows one sign-in action per endpoint, so the two share a single Google sign-in rule, which still exempts command-line requests only on Lazy Teams' own name. Lazy Teams itself knows nothing about ngrok.
- **Settings the server does not take over** from your install's env file (for example mail settings) are listed by name in the report; set them in `config/deploy.hetzner.yml` if you need them.
- **Everything that matters is under `/srv/lazy-teams`**, one directory per kind:

| Directory | What | Back it up? |
|---|---|---|
| `storage` | the Lazy Teams SQLite databases | yes |
| `fleet` | the fleet root: project stores, hosted repositories, per-project secrets | yes |
| `secrets` | the install's env file (`SECRET_KEY_BASE`, `AR_ENCRYPTION_*`, `TRUSTED_PROXY_SECRET`, plus `NGROK_AUTHTOKEN`, `TEAMS_ALLOWED_EMAILS` and `TEAMS_JWKS_URL`, which deploying a new version needs) and the CLI signing key | yes — without it nothing stored can be decrypted |
| `home/local`, `home/cache` | the app user's `~/.local` and `~/.cache`, which hold the microVM manager's machine list, and each project machine's disk: its clone, every task's worktree and uncommitted changes, each agent's conversation | `home/local/share/smolvm` and `home/cache/smolvm/vms`, yes, with the projects stopped; the rest is rebuilt |
| `ngrok` | the rendered ngrok configuration | can be re-rendered |
| `images`, `registry`, `build` | built images and build contexts | no, rebuilt from the checkout |

A complete backup is `storage`, `fleet`, `secrets`, `home/local/share/smolvm` and `home/cache/smolvm/vms`, taken together while the app is stopped (or with `sqlite3 .backup` for the databases). Without the two smolvm directories a restore keeps every project and task, but loses work that only exists in a task's worktree: uncommitted changes and branches that were never pushed.

## Moving a native install onto the server

`lazy-teams/bin/move-install` does it all from your workstation and writes a report (by default under `~/lazy-move-reports/`) saying which step passed or failed, with the server's output. Secrets never appear in the output or the report.

The move is a **copy**: your native install is only read. To go back, start it again with `lazy-teams/bin/native-start`.

1. Look first. This changes nothing on either side:

   ```bash
   lazy-teams/bin/move-install root@your-server --domain example.com \
     --emails you@example.com --jwks-url https://keys.example.com/.well-known/lazy-cli-jwks.json --diagnose
   ```

   `--dry-run` instead prints every command each step would run.

2. Copy while the native install keeps running, deploy, and check:

   ```bash
   lazy-teams/bin/move-install root@your-server --domain example.com --emails you@example.com --jwks-url https://keys.example.com/.well-known/lazy-cli-jwks.json
   ```

   The steps are `preflight`, `build`, `copy`, `settle`, `deploy`, `ngrok`, `verify`. Each one can be re-run on its own with `--only copy,settle,deploy`. The databases are copied with `sqlite3 .backup`, so they are consistent even while the app runs. Project stores may still change under the copy; the copy compares every store and hosted repository on both sides before the server's app starts, and reports differences as drift.

   Until the final copy the server's copy is a **rehearsal**: every project on it is held stopped, so it runs no agent turns, pushes nothing, and does not connect to Slack a second time beside your running install (which would split Slack's messages between the two). Add `--live-copy` only if you want the copied projects to run anyway.

3. The final copy. Run the same command with `--final`. It asks you to stop the native install, takes the last copy, carries every project's working clone across (exported to `~/lazy-move-carry`, outside the install), and requires checksums (every project store and its task count, every hosted repository's refs) and counts (users, teams, projects) to match exactly. Projects then start on the server.

The ngrok authtoken is read from `NGROK_AUTHTOKEN`, or from your workstation's ngrok configuration. `--emails` and `--jwks-url` can instead be `TEAMS_ALLOWED_EMAILS` and `TEAMS_JWKS_URL` in the install's env file.

### Deploying a new version

Use `move-install` only for the one-time move. Once the server is your install, ship every new version from a checkout of the commit you want:

```bash
bun run teams:deploy root@your-server
```

This runs `lazy-teams/bin/deploy root@your-server`. It refuses a server with no existing install, pointing to `move-install` for the first move. Add `--domain example.com` for your services domain, or `--app-host` for a different Teams name. An explicit `--env-file /path/to/deploy.env` uses local deployment settings instead; the signing key still comes from the server. `--dry-run` checks the install and reads settings, then prints the update commands. Reports go under `~/lazy-deploy-reports/` by default (`--report` overrides this).

It runs the `preflight`, `build`, `deploy` and `ngrok` steps: it builds both images from the checked-out commit on the server, replaces the app (database migrations run as the new version starts), and refreshes ngrok's configuration from the new version's policy. It never copies anything from your workstation and never holds projects stopped. Project daemons move onto the new lazy by themselves, one by one. The deployment settings and CLI signing key are read over SSH from `/srv/lazy-teams/secrets/deploy.env` and `cli-jwt.pem` on the server. The env file must include `NGROK_AUTHTOKEN`, `TEAMS_ALLOWED_EMAILS`, and `TEAMS_JWKS_URL` as well as the install's encryption and proxy secrets; a move writes all of them. On a server moved earlier whose env file lacks them, deploy reads them from where that move left them — the ngrok token from the running ngrok container, the allowed emails and JWKS URL from `/srv/lazy-teams/ngrok/ngrok.yml` — and says so without showing them. If a value is in neither place, deploy stops before building and names each missing key: add a `KEY=value` line for each to `/srv/lazy-teams/secrets/deploy.env` on the server once (keep it mode 600), or pass the emails and JWKS URL as `--emails` and `--jwks-url`. Deploy reads that file as plain `KEY=VALUE` lines and never runs it as a script: blank lines and `#` comment lines are skipped, an optional `export ` prefix is allowed, and keys other than those it needs are ignored. Write each value plain or in single quotes; a value whose meaning in a shell would differ from its text (spaces, a trailing `# comment`, `$`, backticks, backslashes, `;`, `&`, `|`, `<`, `>`, parentheses, a leading `~`, or double quotes around `$`, backticks or backslashes) is refused with the key named. No native install or workstation env file is needed; secrets are held only in the deployment process, never saved locally or printed. A deploy restarts ngrok, so the install is unreachable for a few seconds.

### Starting over on the server

```bash
lazy-teams/bin/move-install root@your-server --reset
```

It asks you to type `reset <server>`, then removes the app, kamal-proxy, the registry and ngrok from the server, and everything under `/srv/lazy-teams`. Your native install is not touched; the next run copies everything again.

### What changes for people when the address changes

| What | What to do |
|---|---|
| `lazy login` on each laptop | Run `lazy login https://teams.example.com` again: tokens are signed for the old address. |
| Bound clones (`lazy clone`) | Clone again from the new address, or point the clone's remote at the new address. |
| Hosted repositories | The project page shows the new clone URL; update each local `git remote set-url`. |
| Links to old service addresses | Open the service again from its task page. |
| Projects adopted from an existing store | Their store is copied into the fleet layout on the server and is used from there. |

## Checking ngrok

`verify` checks that both names redirect to Google sign-in and that a request reaching the server without ngrok's secret is not signed in. Two checks need a browser, and the report lists them: that signing in on the Lazy Teams name shows you signed in, and that a task's service opens signed in as you. ngrok keeps one sign-in per host name (the policy deliberately does not share its cookie with a parent domain, because a service's cookie reaches the task's app), so opening a service name for the first time takes a quick Google redirect.
