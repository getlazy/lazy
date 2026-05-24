# Spike: Self-Hosted GitLab CE for Lazy Development

**Date:** 2026-02-25
**Task:** spike-self-hosted-gitlab

## Executive Summary

Self-hosting GitLab CE is feasible on a single DigitalOcean droplet for ~$24-48/mo.
However, **the recommendation is to stay on gitlab.com** unless there's a concrete
need that SaaS can't meet. The operational burden of self-hosting doesn't pay for
itself at lazy's current scale. If a lighter forge is ever needed, Forgejo is a
better fit than self-hosted GitLab CE.

---

## 1. Setup and Hosting

### System Requirements

| Tier | CPU | RAM | Swap | Users |
|------|-----|-----|------|-------|
| Absolute minimum | 1 core (AMD64) | 2 GB | 1 GB | ~5 |
| Small team | 2-4 cores | 4 GB | 2 GB | up to 500 |
| Standard | 8 vCPUs | 16 GB | 2 GB | up to 1,000 |

For lazy's needs (1-5 developers), the absolute minimum (2 GB + swap + tuned config)
works but is sluggish. The practical sweet spot is **4 GB RAM / 2 vCPU**.

### DigitalOcean Droplet Cost

| Config | Monthly Cost | Notes |
|--------|-------------|-------|
| 2 GB / 1 vCPU (Basic) | ~$12/mo | Bare minimum, needs memory tuning |
| 4 GB / 2 vCPU (Basic) | ~$24/mo | **Recommended starting point** |
| 8 GB / 4 vCPU (Basic) | ~$48/mo | Comfortable with runner on same box |

Add ~$5/mo for block storage if repos/artifacts grow. DigitalOcean also offers a
1-click GitLab EE Marketplace image (EE without license = CE-equivalent).

### Recommended Setup: Docker Compose

Docker Compose is the simplest approach. The Omnibus package (Linux packages) is
also well-supported but Docker gives better isolation and easier upgrades.

```yaml
# Minimal docker-compose.yml
version: '3.8'
services:
  gitlab:
    image: gitlab/gitlab-ce:latest
    hostname: gitlab.example.com
    environment:
      GITLAB_OMNIBUS_CONFIG: |
        external_url 'https://gitlab.example.com'
        # Memory-constrained tuning
        puma['worker_processes'] = 2
        sidekiq['concurrency'] = 5
        prometheus_monitoring['enable'] = false
        grafana['enable'] = false
    ports:
      - '80:80'
      - '443:443'
      - '2222:22'
    volumes:
      - gitlab_config:/etc/gitlab
      - gitlab_logs:/var/log/gitlab
      - gitlab_data:/var/opt/gitlab
    shm_size: '256m'

  gitlab-runner:
    image: gitlab/gitlab-runner:latest
    volumes:
      - runner_config:/etc/gitlab-runner
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - gitlab

volumes:
  gitlab_config:
  gitlab_logs:
  gitlab_data:
  runner_config:
```

### Maintenance

- **Backups:** Built-in `gitlab-backup create` command. Should be cron'd daily.
  Back up `/etc/gitlab/gitlab-secrets.json` separately (not included in backups).
- **Updates:** Not auto-updating. Must follow GitLab's upgrade path (never skip
  major versions). Docker makes this: pull new image, stop, start. But you must
  check the upgrade path tool first.
- **Monitoring:** Prometheus/Grafana included but should be disabled on small
  instances to save RAM. Use external monitoring or just check `/admin/health_check`.
- **Estimated maintenance:** ~2-4 hours/month for updates, backup verification,
  and occasional troubleshooting. More during major version upgrades.

---

## 2. Capabilities

### CI/CD Pipelines and Runners

- **CI/CD is fully included in CE.** `.gitlab-ci.yml` pipelines work identically.
- **Runners on same droplet:** Technically possible but GitLab advises against it.
  CI jobs compete for RAM/CPU with the GitLab server. For a small team with light
  CI, it's workable. For building Docker images, a separate runner droplet is better.
- **Runner executors:**
  - **Docker executor** (recommended): Each job runs in a fresh container. Mount
    Docker socket for DinD builds.
  - **Shell executor:** Simpler but no isolation between jobs.
- **Registration:** Admin > CI/CD > Runners > New instance runner. Copy token,
  register with `gitlab-runner register`.

### Container Registry

- **Included in CE for free.** Fully integrated, no additional setup beyond
  enabling it in `gitlab.rb` / `GITLAB_OMNIBUS_CONFIG`.
- Based on the OCI Distribution Registry (CNCF project).
- Each project gets its own registry namespace.
- CI pipelines can push/pull images natively.

### GitLab Pages

- **Included in CE.** Was moved from EE to CE in GitLab 8.16 (2017).
- Requires wildcard DNS: `*.pages.example.com` pointing to the instance.
- Supports static site generators, custom domains, TLS.

### What CE Does NOT Include (Premium/Ultimate only)

| Feature | Tier Required |
|---------|---------------|
| Merge request approval rules | Premium ($29/user/mo) |
| Code Owners | Premium |
| Epics and Roadmaps | Premium |
| Merge trains | Premium |
| Protected environments | Premium |
| Multiple LDAP servers | Premium |
| DAST, dependency scanning | Ultimate ($99/user/mo) |
| Vulnerability dashboards | Ultimate |

For lazy's purposes, the missing features don't matter. The CE feature set covers
everything needed: git hosting, CI/CD, container registry, Pages.

---

## 3. Customization

### UI Appearance (Admin > Settings > Appearance)

What you CAN customize:
- Logo and favicon
- Sign-in/sign-up page title, description, logo
- System header/footer banners
- PWA name and icon
- New project page guidelines

What you CANNOT customize:
- **Core terminology** (cannot rename "Merge Requests" to something else)
- Navigation structure or sidebar layout
- Feature names or labels in the UI

### Disabling Features Per Project

In Project > Settings > General > Visibility, project features, permissions:
- Toggle off Issues, Merge Requests, Wiki, Snippets, etc.
- Disabled features are hidden from the project sidebar.
- This is per-project only, not instance-wide.

### Feature Flags (Admin Rails Console)

GitLab has hundreds of internal feature flags controllable via Rails console:
```ruby
Feature.enable(:my_feature)
Feature.disable(:my_feature)
```
These control GitLab's own features (not user applications). Useful for
enabling/disabling experimental features, but not for reshaping the UI.

### Verdict on Customization

**You cannot meaningfully reshape GitLab's UI.** You can brand it (logo, colors,
messages) and disable features per-project, but the core navigation and terminology
are fixed. If the goal is to present a simplified forge that doesn't look like
GitLab, self-hosted GitLab CE won't achieve that.

---

## 4. API Compatibility with Lazy

### Current State

Lazy's GitLab driver (`src/remote/gitlab-driver.ts`, ~1,120 lines) uses the `glab`
CLI tool, which talks to GitLab's REST API v4. Key operations:

- MR lifecycle: create, view, update, merge, approve, close, comment
- Pipeline status polling: `projects/:id/merge_requests/{iid}/pipelines`
- MR notes (comments): paginated fetch with filtering
- Project visibility check
- Auth health checks

### Self-Hosted Compatibility

**The API is identical.** GitLab self-hosted CE exposes the same `/api/v4` endpoints
as gitlab.com. The `glab` CLI works with self-hosted instances — you just configure
it to point at your hostname instead of `gitlab.com`.

The only differences:
- Some endpoints are EE/Premium-only (approval rules, etc.) — lazy doesn't use those
- Rate limits may differ (self-hosted = no limits by default)
- Self-hosted has full admin API access

**Lazy's GitLab driver would work against self-hosted CE with zero code changes.**
Just `glab auth login --hostname gitlab.example.com`.

---

## 5. For Lazy Specifically

### As Canonical Repo Host

Could work, but consider:
- **Pro:** Full control, no gitlab.com dependency, custom CI runners
- **Con:** Single point of failure (one droplet), operational burden, no CDN/HA,
  backup responsibility falls on us

### Forking/Mirroring for Users

GitLab CE supports repository mirroring (push and pull). Users could mirror from
our self-hosted instance. However, this adds friction compared to gitlab.com where
users already have accounts.

### Registry + Git Remote for Playgrounds

Yes, a self-hosted instance could serve as both:
- Container registry for playground images
- Git remote for playground repos
- CI runners to build playground images

This is actually the strongest argument for self-hosting: a unified platform where
CI builds playground images and pushes them to the integrated registry.

### CI Runners Building Playground Images

Feasible but needs careful sizing:
- Building Docker images is RAM/CPU intensive
- Runner on the same 4GB droplet as GitLab would be tight
- Better: 4GB droplet for GitLab + separate 2-4GB droplet for runner
- Total cost: ~$36-48/mo

---

## 6. Comparison: GitLab CE vs Gitea vs Forgejo

| Dimension | GitLab CE | Gitea | Forgejo |
|-----------|-----------|-------|---------|
| **RAM (idle)** | 2-4 GB | 200-300 MB | 200-300 MB |
| **Min droplet** | $24/mo (4GB) | $6/mo (1GB) | $6/mo (1GB) |
| **CI/CD** | Built-in, mature | Gitea Actions (GitHub-compatible) | Forgejo Actions (GitHub-compatible) |
| **Container registry** | Built-in | Built-in (packages) | Built-in (packages) |
| **Pages** | Built-in | No native equivalent | No native equivalent |
| **API** | REST v4 + GraphQL | REST (GitHub-like) | REST (GitHub-like) |
| **Lazy driver** | **Exists** (`glab` CLI) | Would need new driver | Would need new driver |
| **Governance** | Open core (Gitlab Inc) | Open core (for-profit) | Non-profit (Codeberg e.V.) |
| **Maintenance** | Heavy (many services) | Minimal (single binary) | Minimal (single binary) |

### Key Insight: API Incompatibility

Gitea/Forgejo use a **GitHub-compatible API**, not a GitLab-compatible one. Lazy
already has a GitLab driver (using `glab`) and a GitHub driver (using `gh`). If we
switched to Forgejo, we'd likely need to adapt the GitHub driver to work with Forgejo
(since Forgejo's API mirrors GitHub's, not GitLab's), or write a new Forgejo driver.

### Is GitLab CE Overkill?

**Yes, for pure git hosting.** GitLab CE idles at 2-4 GB RAM for what Forgejo does
in 200 MB. But GitLab CE's advantage is:
1. Lazy's driver already works with it (zero code changes)
2. Built-in CI/CD that's mature and well-documented
3. Built-in container registry
4. Built-in Pages

If we only need git + registry + CI, Forgejo with its Actions runner is sufficient
and 10x lighter. But it would require writing a new driver.

---

## 7. Self-Host vs Stay on gitlab.com

### Arguments for Self-Hosting

1. No dependency on gitlab.com availability or policy changes
2. Full admin control (user management, settings, feature flags)
3. Integrated CI runners + container registry under one roof
4. No usage limits (storage, CI minutes, users)
5. Could serve as reference deployment for users who self-host

### Arguments for Staying on gitlab.com

1. **Zero maintenance** — no backups, no updates, no monitoring
2. **High availability** — gitlab.com has redundancy, CDN, DDoS protection
3. **Free tier is generous** for small teams
4. Lazy's driver already works with it
5. Users already have gitlab.com accounts (less friction for collaboration)
6. No single-droplet SPOF risk

### The Deciding Factor

The main concrete benefit of self-hosting would be **integrated CI + registry for
playground images**. But this can also be achieved on gitlab.com with a free runner
registered from a DigitalOcean droplet ($12-24/mo), keeping the git hosting on
gitlab.com's infrastructure.

---

## 8. Recommendation

**Stay on gitlab.com. Don't self-host GitLab CE.**

Reasons:
1. The operational burden (updates, backups, monitoring, security patches) isn't
   justified for a 1-5 person team that gets all of this for free on gitlab.com.
2. The customization depth is shallow — you can't reshape the UI meaningfully.
3. The cost savings are negative: self-hosting costs $24-48/mo for infrastructure
   that's currently free on gitlab.com.
4. The main potential benefit (integrated CI + registry) can be achieved with a
   self-hosted runner pointing at gitlab.com.

**If the need ever arises for a self-hosted forge** (e.g., for air-gapped users,
reference deployments, or playground infrastructure), **consider Forgejo over GitLab
CE.** It's 10x lighter ($6/mo vs $24/mo), easier to maintain (single binary vs
multi-service monolith), and the driver work (adapting the GitHub driver) is bounded.

### If You Still Want to Try It

1. Create a 4GB/2vCPU Basic droplet on DigitalOcean (~$24/mo)
2. Use the docker-compose.yml above
3. Configure DNS: `gitlab.example.com` + `*.pages.example.com`
4. Set up Let's Encrypt (built into GitLab's nginx)
5. Register a runner (Docker executor) on the same droplet
6. Set up daily backups: `gitlab-backup create` + offsite copy
7. Point `glab` at the new instance: `glab auth login --hostname gitlab.example.com`
8. Lazy's GitLab driver works immediately — no code changes needed

Total setup time: a few hours. Total ongoing maintenance: a few hours/month.
