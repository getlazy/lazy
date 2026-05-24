# Release Pipeline

Lazy uses a squash-publish pipeline to release from the dev repo to the public
repo (getlazy/lazy). Each release creates a single clean commit in the public
repo containing only source code — no task state, dev config, or messy history.

Lazy also has an **alpha channel** (getlazy/lazy-alpha) that publishes on every
push to main, giving early access testers the latest development version.

## Alpha Channel vs. Release Channel

| | Alpha Channel | Release Channel |
|---|---|---|
| **Repository** | getlazy/lazy-alpha | getlazy/lazy |
| **Trigger** | Every push to `main` | Version tag push (e.g., `v0.3.0`) |
| **Version** | `0.0.0-alpha.<short-sha>` | Semantic version (e.g., `v0.3.0`) |
| **Changelog** | Latest commit message only | Full changelog since previous release |
| **Audience** | Early access testers | Public users |
| **Files** | Same as release (uses `.releaseignore`) | Same as alpha |

## CI/CD Platform

Lazy supports both GitHub Actions (`.github/workflows/`) and GitLab CI/CD (`.gitlab-ci.yml`).

### GitLab CI/CD Setup

The `.gitlab-ci.yml` file defines three pipelines:

1. **typecheck** — Runs on merge requests targeting `main`
2. **alpha-publish** — Scheduled daily at 4am UTC + manual trigger
3. **release** — Manual trigger on version tags (v*.*. *)

#### Required CI/CD Variables

Add these to **Settings → CI/CD → Variables** in your GitLab project:

| Variable | Value | Protected | Masked |
|----------|-------|-----------|--------|
| `ALPHA_REPO_DEPLOY_KEY` | Base64-encoded private SSH key for lazy-alpha repo | Yes | Yes |
| `PUBLIC_REPO_DEPLOY_KEY` | Base64-encoded private SSH key for lazy public repo | Yes | Yes |

**Important:** GitLab CI/CD variables cannot mask multiline values, so SSH private keys must be
base64-encoded before adding them to GitLab. To encode a key:

```bash
# Generate the SSH key pair (same as GitHub process)
cd /tmp
ssh-keygen -t ed25519 -f lazy-alpha-deploy-key -C "lazy-alpha-bot" -N ""

# Base64-encode the private key for GitLab
base64 -i lazy-alpha-deploy-key

# Copy the base64 output and paste it as the CI variable value in GitLab
# The .gitlab-ci.yml will automatically decode it: echo "$KEY" | base64 -d > ~/.ssh/deploy_key
```

Generate keys following the same process as GitHub Actions (see setup sections below), but encode them
before adding to GitLab.

#### Scheduled Pipeline Configuration

To enable daily alpha publishing at 4am UTC:

1. Go to **CI/CD → Schedules** in your GitLab project
2. Click **"New schedule"**
3. Fill in:
   - **Description:** Daily alpha publish
   - **Interval Pattern:** Custom (`0 4 * * *`)
   - **Target Branch:** `main`
4. Click **"Save pipeline schedule"**

The alpha-publish job will run automatically on this schedule.

#### Manual Triggers

- **Alpha publish:** Go to **CI/CD → Pipelines**, click **"Run pipeline"**, select the `main` branch, and manually run the `alpha-publish` job
- **Release:** Push a version tag (e.g., `v0.3.0`), then go to the pipeline and manually trigger the `release` job

### GitHub Actions (Legacy)

The GitHub Actions workflows in `.github/workflows/` are the original CI/CD implementation.
When migrating to GitLab CI/CD, these can be removed after verification that GitLab pipelines
work correctly. Do not delete them until the GitLab CI/CD is fully operational.

## Release Channel

### How it works

1. Human tags a release on the dev repo (e.g., `git tag v0.3.0`)
2. Human pushes the tag (`git push --tags`)
3. The `release.yml` GitHub Action triggers on the tag push
4. The action runs `scripts/release.sh`, which:
   - Archives the tagged commit via `git archive`
   - Removes paths listed in `.releaseignore` (`.lazy/`, dev workflows, etc.)
   - Clones the public repo (getlazy/lazy) via SSH deploy key
   - Replaces its contents with the clean archive
   - Commits with a release message and auto-generated changelog
   - Tags the commit with the same version tag
   - Pushes both the commit and tag to the public repo

## One-time setup

These steps must be completed before the first release. You need admin access
to both the dev repo and getlazy/lazy.

### Step 1: Generate an SSH deploy key

Run this in a temporary directory (NOT inside the repo):

```bash
cd /tmp
ssh-keygen -t ed25519 -f lazy-deploy-key -C "lazy-release-bot" -N ""
```

This creates two files:
- `lazy-deploy-key` — the private key (goes into dev repo secrets)
- `lazy-deploy-key.pub` — the public key (goes into getlazy/lazy deploy keys)

### Step 2: Add the public key to getlazy/lazy

1. Open https://github.com/getlazy/lazy/settings/keys
2. Click **"Add deploy key"**
3. Fill in:
   - **Title:** `lazy-release-bot`
   - **Key:** paste the full contents of `/tmp/lazy-deploy-key.pub`
4. Check **"Allow write access"** (required — the release workflow pushes commits)
5. Click **"Add key"**

### Step 3: Add the private key as a secret in the dev repo

1. Open the dev repo's settings page: **Settings → Secrets and variables → Actions**
   (e.g., `https://github.com/getlazy/lazy-dev/settings/secrets/actions`)
2. Click **"New repository secret"**
3. Fill in:
   - **Name:** `PUBLIC_REPO_DEPLOY_KEY`
   - **Value:** paste the full contents of `/tmp/lazy-deploy-key` (the private key,
     including the `-----BEGIN OPENSSH PRIVATE KEY-----` and
     `-----END OPENSSH PRIVATE KEY-----` lines)
4. Click **"Add secret"**

### Step 4: Delete the local key files

```bash
rm /tmp/lazy-deploy-key /tmp/lazy-deploy-key.pub
```

Do not keep copies of the private key on disk.

### Step 5: Verify the public repo exists and has a main branch

The release script pushes to the `main` branch of getlazy/lazy. If the repo is
empty (no commits), the script handles this by initializing a fresh git repo.
However, it's cleaner to ensure getlazy/lazy has at least one commit on `main`
before the first release:

```bash
# If getlazy/lazy is empty, create an initial commit manually:
# (do this from the GitHub UI or a local clone with push access)
git clone git@github.com:getlazy/lazy.git /tmp/lazy-public
cd /tmp/lazy-public
git commit --allow-empty -m "Initial commit"
git push origin main
rm -rf /tmp/lazy-public
```

## Alpha Channel

### One-time setup

The alpha channel requires a separate deploy key for the `getlazy/lazy-alpha` repository.
Follow the same process as the release channel setup, but with different repo and secret names.

#### Step 1: Generate an SSH deploy key for alpha

Run this in a temporary directory:

```bash
cd /tmp
ssh-keygen -t ed25519 -f lazy-alpha-deploy-key -C "lazy-alpha-bot" -N ""
```

This creates:
- `lazy-alpha-deploy-key` — the private key (goes into dev repo secrets)
- `lazy-alpha-deploy-key.pub` — the public key (goes into getlazy/lazy-alpha deploy keys)

#### Step 2: Add the public key to getlazy/lazy-alpha

1. Open https://github.com/getlazy/lazy-alpha/settings/keys
2. Click **"Add deploy key"**
3. Fill in:
   - **Title:** `lazy-alpha-bot`
   - **Key:** paste the full contents of `/tmp/lazy-alpha-deploy-key.pub`
4. Check **"Allow write access"** (required)
5. Click **"Add key"**

#### Step 3: Add the private key as a secret in the dev repo

1. Open the dev repo's settings: **Settings → Secrets and variables → Actions**
2. Click **"New repository secret"**
3. Fill in:
   - **Name:** `ALPHA_REPO_DEPLOY_KEY`
   - **Value:** paste the full contents of `/tmp/lazy-alpha-deploy-key` (the private key)
4. Click **"Add secret"**

#### Step 4: Delete the local key files

```bash
rm /tmp/lazy-alpha-deploy-key /tmp/lazy-alpha-deploy-key.pub
```

#### Step 5: Verify the alpha repo exists

The alpha workflow pushes to `getlazy/lazy-alpha`. If the repo doesn't exist yet,
create it first (private or public, depending on your preference for alpha access).
Initialize it with at least one commit on `main`:

```bash
git clone git@github.com:getlazy/lazy-alpha.git /tmp/lazy-alpha
cd /tmp/lazy-alpha
git commit --allow-empty -m "Initial commit"
git push origin main
rm -rf /tmp/lazy-alpha
```

### How alpha publishing works

1. Developer pushes a commit to `main` on the dev repo
2. GitHub Action (`.github/workflows/alpha-publish.yml`) triggers automatically
3. The workflow runs `scripts/release.sh` in alpha mode (`ALPHA=1`)
4. The script:
   - Archives `HEAD` (the latest commit)
   - Removes paths listed in `.releaseignore` (same exclusions as releases)
   - Clones `getlazy/lazy-alpha`
   - Replaces its contents with the clean archive
   - Commits with message: `Alpha <short-sha>: <latest commit subject>`
   - Tags the commit: `0.0.0-alpha.<short-sha>`
   - Pushes to `getlazy/lazy-alpha`

### Inviting alpha testers

To give someone alpha access:
1. Invite them as a collaborator to `getlazy/lazy-alpha` (if private)
2. Point them to the alpha installation instructions (to be written in lazy-alpha's README)

### Testing the alpha pipeline

Before the first alpha publish, test it with a dry run:

```bash
# Test locally (no SSH key needed)
ALPHA=1 DRY_RUN=1 scripts/release.sh HEAD

# Check the dry-run output:
# - "==> Publishing alpha 0.0.0-alpha.<short-sha>"
# - Same file exclusions as release pipeline
# - Commit message should be: "Alpha <short-sha>: <your latest commit subject>"
```

The first real alpha publish will happen automatically on the next push to `main`
(assuming the GitHub secret `ALPHA_REPO_DEPLOY_KEY` is configured).

## Verification before first release

### Local dry run

Before doing a real release, verify the script works locally:

```bash
# Create a test tag on the current commit
git tag v0.0.0-test

# Run the release script in dry-run mode
# (this skips the push — no SSH key needed)
DRY_RUN=1 scripts/release.sh v0.0.0-test

# Clean up the test tag
git tag -d v0.0.0-test
```

**What to check in the dry-run output:**

1. `==> Archiving v0.0.0-test...` — archive was created
2. `==> Applying exclusions from .releaseignore...` — exclusions applied
3. Lines like `==>   Excluded: .lazy` — each excluded path is listed
4. `==> [DRY RUN] Files in release:` — review the file list:
   - Source code (`src/`, `test/`, `scripts/build.ts`, etc.) should be present
   - Private files (`.lazy/`, `.github/`, `lazy.toml`, `WORKSHOP.md`) should NOT be present
   - Config templates (`lazy.toml.example`) should be present
5. `==> [DRY RUN] Commit message:` — the commit message should include a changelog

### GitHub Actions dry run (workflow_dispatch)

After the deploy key and secret are set up, test the full pipeline without
actually pushing to the public repo:

1. Create and push a test tag:
   ```bash
   git tag v0.0.0-test
   git push origin v0.0.0-test
   ```
   Note: this will trigger the release action automatically. If you want to
   avoid the automatic trigger, create the tag but don't push it yet, then
   use workflow_dispatch:

2. Go to the dev repo → **Actions** tab → **"Release to Public Repo"** workflow
3. Click **"Run workflow"** (dropdown on the right)
4. Fill in:
   - **Tag to release:** `v0.0.0-test`
   - **Dry run:** check this box
5. Click **"Run workflow"**
6. Click into the running workflow to monitor progress
7. Check the "Run release script" step output — same checks as the local dry run

8. Clean up the test tag:
   ```bash
   git tag -d v0.0.0-test
   git push origin --delete v0.0.0-test
   ```

## Making a release

### Standard release (tag push)

```bash
# Make sure you're on main with all changes merged
git checkout main
git pull

# Create the release tag
git tag v0.3.0

# Push the tag — this triggers the release workflow
git push --tags
```

The GitHub Action handles the rest. Monitor progress in the Actions tab.

### Manual release (workflow_dispatch)

If the tag already exists but the release didn't run (or you want to re-release):

1. Go to the dev repo → **Actions** tab → **"Release to Public Repo"** workflow
2. Click **"Run workflow"**
3. Enter the tag (e.g., `v0.3.0`)
4. Leave "Dry run" unchecked
5. Click **"Run workflow"**

## Verifying a release landed correctly

After the workflow completes successfully:

1. **Check the public repo:** Open https://github.com/getlazy/lazy
   - The latest commit should say "Release v0.3.0" (or whatever tag you released)
   - The commit author should be `lazy-release[bot]`

2. **Check the tag:** Open https://github.com/getlazy/lazy/tags
   - The tag `v0.3.0` should exist and point to the release commit

3. **Check the file list:** Browse the repo and verify:
   - Source code is present (`src/`, `test/`, `scripts/build.ts`, etc.)
   - Private files are absent (no `.lazy/`, no `.github/workflows/release.yml`,
     no `lazy.toml`, no `WORKSHOP.md`)
   - Config example is present (`lazy.toml.example`)

4. **Check the commit message:** Click on the release commit — it should contain:
   - The tag name
   - A changelog listing commits since the previous release
   - The source SHA from the dev repo

## What gets published

Both the release channel (getlazy/lazy) and alpha channel (getlazy/lazy-alpha)
publish the same files — everything in the repo **except** paths listed in `.releaseignore`:

| Excluded | Reason |
|----------|--------|
| `.lazy/` | Task state, sessions, turns, worktrees |
| `.lazy-task-sandbox/` | Task sandbox files |
| `task-sandbox/` | Task sandbox files |
| `.github/` | Dev repo workflows (public repo has its own) |
| `.claude/` | Claude Code settings (dev-specific) |
| `lazy.toml` | Dev-specific configuration |
| `WORKSHOP.md` | Internal dev documentation |
| `scripts/migrate-to-lazy.ts` | Dev-only migration script |
| `scripts/release.sh` | Release script (only needed in dev repo) |
| `docs/release-pipeline.md` | This document (dev-only) |
| `.releaseignore` | The exclusion list itself |

To change what gets excluded, edit `.releaseignore` and commit.

## Changelog generation

The release script auto-generates a changelog from commit messages between the
previous and current release tags. The changelog is included in the release
commit message on the public repo.

For the first release (no previous tag), all commits up to the tag are included.

## Troubleshooting

### "Tag does not exist"

The release script requires the tag to exist in the local repo (for CI, in the
checkout). If you see this error:

```
ERROR: Tag 'v0.3.0' does not exist. Create it first: git tag v0.3.0
```

Create the tag and push it:

```bash
git tag v0.3.0
git push origin v0.3.0
```

### "Tag must match pattern v<major>.<minor>.<patch>"

The script only accepts semantic version tags like `v0.3.0`, `v1.0.0`, etc.
Pre-release suffixes (e.g., `v0.3.0-beta.1`) are not supported.

### SSH authentication failure

If the "Configure SSH for public repo" or "Run release script" step fails with
an SSH error like `Permission denied (publickey)`:

1. **Verify the deploy key exists on getlazy/lazy:**
   - Open https://github.com/getlazy/lazy/settings/keys
   - The `lazy-release-bot` key should be listed with **write access**

2. **Verify the secret exists on the dev repo:**
   - Open the dev repo → Settings → Secrets and variables → Actions
   - `PUBLIC_REPO_DEPLOY_KEY` should be listed (you can't view the value, but
     you can see when it was last updated)

3. **Verify the key pair matches:**
   - If in doubt, regenerate: delete the deploy key from getlazy/lazy, delete
     the secret from the dev repo, and repeat the setup steps from scratch

4. **Check the SSH config format:**
   - The workflow writes `~/.ssh/config` with indented Host directives. If GitHub
     Actions changes its runner environment, the SSH config format might need updating.

### "No changes from previous release"

```
==> No changes from previous release — nothing to push
```

The script detected that the archive contents are identical to the last release
commit on the public repo. This means no source code changed between the two
tags. This is not an error — the script exits cleanly with code 0.

### Tag already exists on the public repo

If the tag already exists on getlazy/lazy (e.g., from a previous release
attempt), the push will fail. To fix:

```bash
# Delete the tag on the public repo (requires direct access)
git clone --depth=1 git@github.com:getlazy/lazy.git /tmp/lazy-fix
cd /tmp/lazy-fix
git push origin --delete v0.3.0
rm -rf /tmp/lazy-fix
```

Then re-run the release workflow.

### Empty archive

```
ERROR: Archive is empty — something went wrong
```

This means `git archive` produced no files for the tag. Verify the tag points
to a valid commit with actual content:

```bash
git log -1 v0.3.0
git archive --format=tar v0.3.0 | tar -tf - | head -20
```
