#!/usr/bin/env bash
# setup-vm.sh — Set up a fresh VM for v0.11 QA testing.
#
# This script installs all dependencies, builds lazy, and runs the test driver.
# Designed for a clean Ubuntu/Debian VM (e.g., GitHub Actions runner, EC2, etc.)
#
# Usage:
#   # Basic (no GitHub integration — only happy-path test)
#   ./test/qa/setup-vm.sh
#
#   # With GitHub integration (all tests including CI and PR comment)
#   QA_GITHUB_REPO=lazy-qa/test-repo GH_TOKEN=ghp_xxx ./test/qa/setup-vm.sh
#
# Environment variables:
#   QA_GITHUB_REPO    - GitHub repo for CI/PR tests (optional)
#   GH_TOKEN          - GitHub token for gh CLI auth (required if QA_GITHUB_REPO is set)
#   LAZY_REPO         - URL or path to lazy repo (default: current directory or git clone)
#   LAZY_BRANCH       - Branch to test (default: current branch)
#   SKIP_INSTALL      - Set to 1 to skip dependency installation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAZY_ROOT="${LAZY_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; }
ok() { echo -e "${GREEN}[setup]${NC} $*"; }

# ---------------------------------------------------------------------------
# 1. Install dependencies
# ---------------------------------------------------------------------------

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  log "Installing dependencies..."

  # Detect OS
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq curl git unzip jq
  elif command -v brew &>/dev/null; then
    brew install curl git jq
  else
    warn "Unknown package manager. Assuming dependencies are already installed."
  fi

  # Install bun
  if ! command -v bun &>/dev/null; then
    log "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  ok "bun $(bun --version) installed"

  # Install gh CLI (for GitHub integration tests)
  if [[ -n "${QA_GITHUB_REPO:-}" ]] && ! command -v gh &>/dev/null; then
    log "Installing GitHub CLI..."
    if command -v apt-get &>/dev/null; then
      # Official GitHub CLI installation for Debian/Ubuntu
      (type -p wget >/dev/null || sudo apt-get install -y -qq wget) \
        && sudo mkdir -p -m 755 /etc/apt/keyrings \
        && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
        && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
        && sudo apt-get update -qq \
        && sudo apt-get install -y -qq gh
    elif command -v brew &>/dev/null; then
      brew install gh
    else
      error "Cannot install gh CLI. Install it manually: https://github.com/cli/cli#installation"
      exit 1
    fi
  fi

  if command -v gh &>/dev/null; then
    ok "gh $(gh --version | head -1) installed"
  fi
else
  log "Skipping dependency installation (SKIP_INSTALL=1)"
fi

# ---------------------------------------------------------------------------
# 2. Authenticate gh CLI
# ---------------------------------------------------------------------------

if [[ -n "${QA_GITHUB_REPO:-}" ]]; then
  if [[ -n "${GH_TOKEN:-}" ]]; then
    log "Authenticating gh CLI with provided token..."
    echo "$GH_TOKEN" | gh auth login --with-token
    ok "gh authenticated"
  elif gh auth status &>/dev/null; then
    ok "gh already authenticated"
  else
    error "QA_GITHUB_REPO is set but no GH_TOKEN provided and gh is not authenticated."
    error "Set GH_TOKEN or run 'gh auth login' first."
    exit 1
  fi

  # Verify repo access
  log "Verifying access to ${QA_GITHUB_REPO}..."
  if gh repo view "$QA_GITHUB_REPO" &>/dev/null; then
    ok "Repository ${QA_GITHUB_REPO} accessible"
  else
    warn "Repository ${QA_GITHUB_REPO} not found. Attempting to create..."
    gh repo create "$QA_GITHUB_REPO" --public --description "Lazy v0.11 QA test repository" || {
      error "Failed to create or access ${QA_GITHUB_REPO}"
      exit 1
    }
    ok "Repository ${QA_GITHUB_REPO} created"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Build lazy
# ---------------------------------------------------------------------------

log "Building lazy from ${LAZY_ROOT}..."
cd "$LAZY_ROOT"

if [[ -n "${LAZY_BRANCH:-}" ]]; then
  log "Checking out branch: ${LAZY_BRANCH}"
  git checkout "$LAZY_BRANCH"
fi

bun install
# Ensure the lazy-agent placeholder exists — it's gitignored but required
# by the Bun file import in src/capture/claude.ts for dev-mode runs.
bun run ensure:agent-placeholder
bun run build
ok "Lazy built successfully"

# ---------------------------------------------------------------------------
# 4. Pre-flight checks
# ---------------------------------------------------------------------------

log "Running pre-flight checks..."

# Verify scenario file exists
QA_SCENARIO="${SCRIPT_DIR}/v011-daemon.scenarios.json"
if [[ ! -f "$QA_SCENARIO" ]]; then
  error "Scenario file not found: ${QA_SCENARIO}"
  exit 1
fi
ok "Scenario file found"

# Verify lazy runs (catches missing deps, broken builds).
# Try installed binary first, fall back to source tree.
if command -v lazy &>/dev/null && lazy --version &>/dev/null; then
  LAZY_CMD="lazy"
  ok "lazy binary works (installed)"
elif bun run "${LAZY_ROOT}/src/index.ts" --version &>/dev/null; then
  LAZY_CMD="bun run ${LAZY_ROOT}/src/index.ts"
  ok "lazy binary works (source tree)"
else
  error "lazy binary does not work. Check build output above."
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Run the test driver
# ---------------------------------------------------------------------------

log "Running v0.11 QA test driver..."
echo ""

export QA_SCENARIO_FILE="$QA_SCENARIO"
export LAZY_BIN="${LAZY_CMD}"

# Pass through GitHub repo if set
if [[ -n "${QA_GITHUB_REPO:-}" ]]; then
  bun run "${SCRIPT_DIR}/run-v011.ts" --github-repo "$QA_GITHUB_REPO"
else
  bun run "${SCRIPT_DIR}/run-v011.ts"
fi

EXIT_CODE=$?

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
  ok "All QA tests passed!"
else
  error "Some QA tests failed (exit code: ${EXIT_CODE})"
fi

exit $EXIT_CODE
