/**
 * CodexPackaging — Packaging and deployment concerns for OpenAI's Codex CLI.
 *
 * The `codex` binary is a native (Rust, musl-static) executable. npm
 * `@openai/codex` exists but its bin stub is a node script (our images carry
 * bun, not node), so the container install pulls the pinned GitHub release
 * tarball directly — one static binary, no runtime dependency. Verified inside
 * lazy's container image context (Debian bookworm, aarch64) on 2026-09-03:
 * download, `--version`, `exec --json`, `login status` and `doctor` all work.
 */

import type { AgentPackaging } from './interface';
import { spawnSyncUnsupervised } from '../utils/spawn';

/**
 * Pinned release. Bump deliberately, re-running the argv/event probes in the
 * add-codex-agent journal — the JSONL event contract is what lazy parses.
 */
export const CODEX_PINNED_VERSION = '0.152.1';

/**
 * Both binaries, because `codex` alone is not a working install — see
 * {@link CodexPackaging.dockerInstallCommand} for what fails without the
 * code-mode host and why it cannot come from a different release.
 */
export const CODEX_INSTALL_HINT =
  `Install with: triple="$(uname -m | sed 's/^arm64$/aarch64/')-unknown-linux-musl"; ` +
  `for bin in codex codex-code-mode-host; do ` +
  `curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_PINNED_VERSION}/$bin-$triple.tar.gz" | tar -xz ` +
  `&& mv "$bin-$triple" "$HOME/.local/bin/$bin"; done`;

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
    // Pinned, arch-resolved static binaries into the same non-root ~/.local/bin
    // layout the base image uses for Claude Code and Cursor. Each tarball
    // contains a single file named <name>-<triple> (verified for 0.152.1).
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
    && for bin in codex codex-code-mode-host; do \\
         curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_PINNED_VERSION}/\${bin}-\${triple}.tar.gz" | tar -xz -C /home/user/.local/bin \\
         && mv "/home/user/.local/bin/\${bin}-\${triple}" "/home/user/.local/bin/\${bin}" \\
         || exit 1; \\
       done`;
  }

  generateDockerfile(): string {
    return `FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates sudo \\
    && rm -rf /var/lib/apt/lists/*

# Non-root user with sudo — allows in-container tool installs
RUN useradd --create-home --shell /bin/bash user \\
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
ENV PATH="/home/user/.local/bin:\${PATH}"

# Install the Codex CLI (pinned native binary) as \`user\`.
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

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    const results: { state: 'ok' | 'fail'; what: string; reason?: string }[] = [];
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
          reason: `Codex CLI (codex) not found. ${CODEX_INSTALL_HINT}`,
        }];
      }
    } catch {
      return [{
        state: 'fail',
        what: 'Codex CLI installed',
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
        reason: 'Could not check for codex-code-mode-host next to the codex binary.',
      });
    }

    // Auth state: `codex login status` prints "Logged in using …" (exit 0) or
    // "Not logged in" (exit 1) — verified against 0.152.1. Informational —
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
          reason: 'Not logged in. Run `lazy system agent set-key codex` (or `codex login` for host runs).',
        });
      }
    } catch {
      results.push({
        state: 'fail',
        what: 'Codex CLI authenticated',
        reason: 'Could not run `codex login status`. Run `lazy system agent set-key codex` or `codex login`.',
      });
    }

    return results;
  }
}
