#!/usr/bin/env bash
# Build the lazy playground repository (playground/ in this repo) as its own git
# repository with a clean, one-commit history — and, only when asked from a
# terminal, push it.
#
#   scripts/publish-playground-repo.sh                      # build + print the plan
#   scripts/publish-playground-repo.sh --out DIR            # build into DIR
#   scripts/publish-playground-repo.sh --remote URL --push  # build + push (TTY only)
#
# Without --push nothing leaves this machine: the script builds the repository,
# prints where it is and the exact push command, and stops. --push must be run
# by a human from their own terminal (stdin a TTY): it pushes with whatever git
# credentials that terminal has, and an agent or a script must never do that on
# someone's behalf. It never force-pushes — a remote that already has history
# refuses the push, and you decide what to do about it.
#
# The default remote is the playground's intended home; override it with
# --remote. Commits are made as the git identity of the shell running this.

set -euo pipefail

DEFAULT_REMOTE="git@github.com:getlazy/playground.git"
MARKER=".lazy-playground-build"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/playground"
out="${TMPDIR:-/tmp}/lazy-playground-repo"
remote="$DEFAULT_REMOTE"
push=false

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    --remote) remote="${2:?--remote needs a git URL}"; shift 2 ;;
    --push) push=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if $push && [[ ! -t 0 ]]; then
  echo "Refusing --push: stdin is not a terminal. Run this from your own shell — it pushes" >&2
  echo "with your git credentials, and nothing should do that without you at the keyboard." >&2
  exit 1
fi

[[ -f "$src/tasks.json" ]] || { echo "No playground at $src (expected tasks.json there)." >&2; exit 1; }

# Only ever delete a directory this script built.
if [[ -e "$out" ]]; then
  if [[ -f "$out/$MARKER" || -z "$(ls -A "$out")" ]]; then
    rm -rf "$out"
  else
    echo "Refusing to overwrite $out: it exists and was not built by this script. Pick another --out." >&2
    exit 1
  fi
fi

echo "==> Copying playground/ into $out"
mkdir -p "$out"
# Tracked and untracked-but-not-ignored files: never node_modules or a local database.
(cd "$repo_root" && git ls-files -z --cached --others --exclude-standard -- playground) |
  while IFS= read -r -d '' path; do
    [[ -f "$repo_root/$path" ]] || continue   # deleted in the working tree
    rel="${path#playground/}"
    mkdir -p "$out/$(dirname "$rel")"
    cp -p "$repo_root/$path" "$out/$rel"
  done

echo "==> Creating a fresh git history"
(
  cd "$out"
  git init -q -b main
  git add -A
  git commit -q -m "Linkshelf: the lazy playground project"
  # Written after the commit so it is never part of the repository.
  touch "$MARKER"
  echo "$MARKER" >> .git/info/exclude
)

commit="$(git -C "$out" rev-parse --short HEAD)"
files="$(git -C "$out" ls-files | wc -l | tr -d ' ')"
echo "    $files files, one commit ($commit) on main"

if ! $push; then
  cat <<MSG

Built. Nothing was pushed.

  Repository: $out
  Try it:     lazy playground up --repo $out

To publish it, run this yourself from a terminal (it uses your git credentials):

  scripts/publish-playground-repo.sh --remote $remote --push
MSG
  exit 0
fi

echo "==> Pushing main to $remote"
git -C "$out" push "$remote" main
echo "Pushed. If this is the playground's public home, set PLAYGROUND_REPO_URL in src/demo/playground.ts."
