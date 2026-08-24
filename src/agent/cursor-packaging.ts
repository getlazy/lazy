/**
 * CursorPackaging — Packaging and deployment concerns for Cursor CLI.
 *
 * Cursor supports both host-process and container runners. The native
 * `cursor-agent` binary installs via Cursor's own curl installer (no npm) —
 * verified inside lazy's container image context (Debian bookworm, aarch64)
 * on 2026-08-18: install, `--version`, `status`, and headless flag parsing
 * all work unauthenticated.
 */

import type { AgentPackaging } from './interface';
import { spawnSyncUnsupervised } from '../utils/spawn';

export const CURSOR_INSTALL_HINT = 'Install with: curl https://cursor.com/install -fsS | bash';
const INSTALL_HINT = CURSOR_INSTALL_HINT;

export class CursorPackaging implements AgentPackaging {
  readonly agentId = 'cursor';

  configDirName(): string {
    return '.cursor';
  }

  npmPackage(): string {
    // Cursor is installed via its own installer, not npm
    return '';
  }

  binaryName(): string {
    // The installer also drops a legacy `agent` symlink, but `cursor-agent`
    // is the documented name and the one that survives PATH collisions.
    return 'cursor-agent';
  }

  supportsContainerRunner(): boolean {
    return true;
  }

  dockerInstallCommand(): string {
    // Same non-root, ~/.local/bin layout the base image uses for Claude Code.
    return 'RUN curl https://cursor.com/install -fsS | bash';
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

# Install Cursor CLI as \`user\` so it lands in /home/user/.local/bin/cursor-agent.
${this.dockerInstallCommand()}

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Missing required tool: git. Install with your system package manager.' },
      // cmd must be a bare binary name: the supervisor's startup check resolves
      // it with `which`, which cannot take arguments.
      { cmd: 'cursor-agent', name: 'Cursor CLI', hint: `Cursor CLI (cursor-agent) not found. ${INSTALL_HINT}` },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    const results: { state: 'ok' | 'fail'; what: string; reason?: string }[] = [];
    try {
      const version = spawnSyncUnsupervised(['cursor-agent', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (version.exitCode === 0) {
        results.push({ state: 'ok', what: `Cursor CLI installed (${version.stdout.toString().trim()})` });
      } else {
        return [{
          state: 'fail',
          what: 'Cursor CLI installed',
          reason: `Cursor CLI (cursor-agent) not found. ${INSTALL_HINT}`,
        }];
      }
    } catch {
      return [{
        state: 'fail',
        what: 'Cursor CLI installed',
        reason: `Cursor CLI (cursor-agent) not found. ${INSTALL_HINT}`,
      }];
    }

    // Auth state: `cursor-agent status` prints "Not logged in" (exit 0) or the
    // logged-in account. Informational — CURSOR_API_KEY may still be provided
    // at launch, so an un-logged-in CLI is a warning-shaped fail, not fatal.
    try {
      const status = spawnSyncUnsupervised(['cursor-agent', 'status'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const text = status.stdout.toString().trim();
      if (status.exitCode === 0 && text && !/not logged in/i.test(text)) {
        results.push({ state: 'ok', what: `Cursor CLI authenticated (${text.split('\n')[0]})` });
      } else {
        results.push({
          state: 'fail',
          what: 'Cursor CLI authenticated',
          reason: 'Not logged in. Run `cursor-agent login` or set CURSOR_API_KEY.',
        });
      }
    } catch {
      results.push({
        state: 'fail',
        what: 'Cursor CLI authenticated',
        reason: 'Could not run `cursor-agent status`. Run `cursor-agent login` or set CURSOR_API_KEY.',
      });
    }

    return results;
  }
}
