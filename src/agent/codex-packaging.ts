/**
 * CodexPackaging — Packaging and deployment concerns for OpenAI's Codex CLI.
 *
 * The `codex` binary is a native (Rust, musl-static) executable. npm
 * `@openai/codex` exists but its bin stub is a node script (our images carry
 * bun, not node), so the container install pulls the latest GitHub release
 * tarball directly — one static binary, no runtime dependency. Checked inside
 * lazy's container image context (Debian bookworm, aarch64) on 2026-09-03
 * with codex-cli 0.152.1: download, `--version`, `exec --json`, `login status`
 * and `doctor` all worked. Codex is NOT pinned: installs take the latest
 * release, like Claude Code and Cursor — but every asset is verified against
 * the sha256 digest the same release publishes, and a missing digest fails.
 */

import type { HealthCheck } from '../remote/driver';
import type { AgentPackaging } from './interface';
import { spawnSyncUnsupervised } from '../utils/spawn';

/**
 * Shell that sets `$tag` to the latest Codex release tag, resolved ONCE so
 * both assets are downloaded from that one release (resolving per download via
 * `releases/latest/download` could straddle a newly published release and
 * install a mismatched pair). The redirect of `releases/latest` names the tag.
 * No version constant is kept and there is no fallback: a failed lookup fails
 * the install loudly.
 */
const RESOLVE_LATEST_TAG =
  `tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/openai/codex/releases/latest | sed 's|.*/||')"`;

/**
 * Both binaries, because `codex` alone is not a working install — see
 * {@link CodexPackaging.dockerInstallCommand} for what fails without the
 * code-mode host and why it cannot come from a different release.
 */
export const CODEX_INSTALL_HINT =
  `Install with (needs curl, jq, sha256sum; each asset is verified against the sha256 digest the release publishes): triple="$(uname -m | sed 's/^arm64$/aarch64/')-unknown-linux-musl"; ` +
  `${RESOLVE_LATEST_TAG}; case "$tag" in rust-v*) ;; *) echo "could not resolve the latest codex release tag (got: '$tag')" >&2; false ;; esac && ` +
  `json="$(curl -fsSL "https://api.github.com/repos/openai/codex/releases/tags/$tag")" && ` +
  // A subshell, so a failed download or checksum EXITS non-zero: `|| break`
  // left the loop with status 0 and the one-liner reported success.
  `(for bin in codex codex-code-mode-host; do ` +
  `asset="$bin-$triple.tar.gz"; ` +
  `want="$(printf '%s' "$json" | jq -er --arg a "$asset" '.assets[] | select(.name == $a) | .digest | select(startswith("sha256:")) | ltrimstr("sha256:")')" && ` +
  `curl -fsSL -o "/tmp/$asset" "https://github.com/openai/codex/releases/download/$tag/$asset" ` +
  `&& echo "$want  /tmp/$asset" | sha256sum -c - && tar -xzf "/tmp/$asset" -C /tmp && rm "/tmp/$asset" ` +
  `&& mv "/tmp/$bin-$triple" "$HOME/.local/bin/$bin" || exit 1; done)`;

export class CodexPackaging implements AgentPackaging {
  readonly agentId = 'codex';

  configDirName(): string {
    return '.codex';
  }

  npmPackage(): string {
    // The npm package exists but needs node for its bin stub; lazy installs
    // the native release binary instead (see dockerInstallCommand).
    return '';
  }

  binaryName(): string {
    return 'codex';
  }

  supportsContainerRunner(): boolean {
    return true;
  }

  dockerInstallCommand(): string {
    // Latest-release, arch-resolved static binaries into the same non-root ~/.local/bin
    // layout the base image uses for Claude Code and Cursor. Each tarball
    // contains a single file named <name>-<triple> (checked on 0.152.1, 2026-09).
    //
    // TWO BINARIES, NOT ONE. `codex-code-mode-host` is a SEPARATE release asset
    // and is not optional: when the model the turn runs on declares `tool_mode
    // = "code_mode_only"` — which the ChatGPT subscription backend's default
    // model does — codex runs every tool call through that helper, spawning it
    // from its OWN directory by name. Without it a turn authenticates, reaches
    // the model, and then dies on `failed to spawn code-mode host
    // /home/user/.local/bin/codex-code-mode-host: No such file or directory`
    // having touched nothing: no repository access, no lazy tools, no work.
    // The two MUST come from the same release — it is one program split across
    // two files, and they handshake on a version-stamped protocol.
    return `RUN arch="$(uname -m)" \\
    && case "$arch" in \\
         x86_64) triple=x86_64-unknown-linux-musl ;; \\
         aarch64|arm64) triple=aarch64-unknown-linux-musl ;; \\
         *) echo "unsupported architecture for codex: $arch" >&2; exit 1 ;; \\
       esac \\
    && mkdir -p /home/user/.local/bin \\
    && ${RESOLVE_LATEST_TAG} \\
    && case "$tag" in rust-v*) ;; *) echo "could not resolve the latest codex release tag (got: '$tag')" >&2; exit 1 ;; esac \\
    && json="$(curl -fsSL "https://api.github.com/repos/openai/codex/releases/tags/$tag")" \\
    && for bin in codex codex-code-mode-host; do \\
         asset="\${bin}-\${triple}.tar.gz"; \\
         want="$(printf '%s' "$json" | jq -er --arg a "$asset" '.assets[] | select(.name == $a) | .digest | select(startswith("sha256:")) | ltrimstr("sha256:")')" || { echo "codex release $tag publishes no sha256 digest for $asset" >&2; exit 1; }; \\
         curl -fsSL -o "/tmp/$asset" "https://github.com/openai/codex/releases/download/$tag/$asset" \\
         && echo "$want  /tmp/$asset" | sha256sum -c - \\
         && tar -xzf "/tmp/$asset" -C /home/user/.local/bin \\
         && rm "/tmp/$asset" \\
         && mv "/home/user/.local/bin/\${bin}-\${triple}" "/home/user/.local/bin/\${bin}" \\
         || exit 1; \\
       done \\
    && mkdir -p /home/user/.local/share/lazy && echo "$tag" > /home/user/.local/share/lazy/codex-release-tag`;
  }

  generateDockerfile(): string {
    return `FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl jq ca-certificates sudo \\
    && rm -rf /var/lib/apt/lists/*

# Non-root user with sudo — allows in-container tool installs
RUN useradd --create-home --shell /bin/bash user \\
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
ENV PATH="/home/user/.local/bin:\${PATH}"

# Install the Codex CLI (latest native binary) as \`user\`.
${this.dockerInstallCommand()}

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Missing required tool: git. Install with your system package manager.' },
      // cmd must be a bare binary name: the supervisor's startup check resolves
      // it with `which`, which cannot take arguments.
      { cmd: 'codex', name: 'Codex CLI', hint: `Codex CLI (codex) not found. ${CODEX_INSTALL_HINT}` },
      // DELIBERATELY NOT HERE: `codex-code-mode-host`. A failed check in this
      // list is fatal (`process.exit(1)` in src/supervisor/index.ts), and the
      // helper is only needed for models whose `tool_mode` is `code_mode_only`
      // — so refusing on its absence would break every codex task running on an
      // image built before it was installed, including the ones working fine
      // today. It is REPORTED by `diagnose()` instead, which says what is wrong
      // without deciding that nothing may run.
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): HealthCheck[] {
    const results: HealthCheck[] = [];
    try {
      const version = spawnSyncUnsupervised(['codex', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (version.exitCode === 0) {
        results.push({ state: 'ok', what: `Codex CLI installed (${version.stdout.toString().trim()})` });
      } else {
        return [{
          state: 'fail',
          what: 'Codex CLI installed',
          problem: 'Codex CLI isn\'t installed',
          reason: `Codex CLI (codex) not found. ${CODEX_INSTALL_HINT}`,
        }];
      }
    } catch {
      return [{
        state: 'fail',
        what: 'Codex CLI installed',
        problem: 'Codex CLI isn\'t installed',
        reason: `Codex CLI (codex) not found. ${CODEX_INSTALL_HINT}`,
      }];
    }

    // The code-mode host, which is a SECOND binary from the same release and is
    // what codex spawns to run tools for any model whose `tool_mode` is
    // `code_mode_only`. Reported rather than enforced at launch: a turn on a
    // model that does not use code mode runs perfectly well without it, so this
    // says the image is behind instead of refusing to start anything. When it IS
    // needed and missing, the turn authenticates, reaches the model and then
    // dies on a spawn error — this line is what makes that predictable.
    try {
      const host = spawnSyncUnsupervised(['which', 'codex-code-mode-host'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (host.exitCode === 0) {
        results.push({ state: 'ok', what: 'Codex code-mode host installed' });
      } else {
        results.push({
          state: 'fail',
          what: 'Codex code-mode host installed',
          problem: 'Codex code-mode host is missing',
          reason:
            'codex-code-mode-host is not installed next to the codex binary. Models that run ' +
            'tools in code mode (the ChatGPT subscription default does) will reach the model ' +
            'and then fail to run any tool. Rebuild the task image: `lazy upgrade --images`.',
        });
      }
    } catch {
      results.push({
        state: 'fail',
        what: 'Codex code-mode host installed',
        problem: 'Codex code-mode host is missing',
        reason: 'Could not check for codex-code-mode-host next to the codex binary.',
      });
    }

    // Auth state: `codex login status` prints "Logged in using …" (exit 0) or
    // "Not logged in" (exit 1) — checked on 0.152.1. Informational —
    // OPENAI_API_KEY (or a stored `lazy system agent set-key codex` key) is
    // resolved at launch, so an un-logged-in CLI is a warning-shaped fail.
    try {
      const status = spawnSyncUnsupervised(['codex', 'login', 'status'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const text = `${status.stdout.toString()}\n${status.stderr.toString()}`.trim();
      const firstLine = text.split('\n')[0] ?? '';
      if (status.exitCode === 0 && text && !/not logged in/i.test(text)) {
        results.push({ state: 'ok', what: `Codex CLI authenticated (${firstLine})` });
      } else {
        results.push({
          state: 'fail',
          what: 'Codex CLI authenticated',
          problem: 'Codex CLI isn\'t logged in',
          reason: 'Not logged in. Run `lazy system agent set-key codex` (or `codex login` for host runs).',
        });
      }
    } catch {
      results.push({
        state: 'fail',
        what: 'Codex CLI authenticated',
        problem: 'Codex CLI isn\'t logged in',
        reason: 'Could not run `codex login status`. Run `lazy system agent set-key codex` or `codex login`.',
      });
    }

    return results;
  }
}
