/**
 * ClaudeCodePackaging — Packaging and deployment concerns for Claude Code.
 *
 * Extracted from src/capture/claude.ts (DEFAULT_DOCKERFILE) and
 * src/runner/docker-runner.ts (supervisorToolChecks, diagnose).
 */

import type { AgentPackaging } from './interface';
import { spawnSync } from '../utils/spawn';

export class ClaudeCodePackaging implements AgentPackaging {
  readonly agentId = 'claude-code';

  configDirName(): string {
    return '.claude';
  }

  npmPackage(): string {
    return '@anthropic-ai/claude-code@latest';
  }

  binaryName(): string {
    return 'claude';
  }

  dockerInstallCommand(): string {
    return 'RUN curl -fsSL https://claude.ai/install.sh | bash';
  }

  generateDockerfile(): string {
    return `FROM oven/bun:slim

RUN apt-get update && apt-get install -y git curl sudo && rm -rf /var/lib/apt/lists/*

# Install Claude Code via native installer (installs to ~/.local/bin/claude)
${this.dockerInstallCommand()}
# Make Claude available system-wide (for non-root builder sessions)
RUN cp /root/.local/bin/claude /usr/local/bin/claude
# Remove native install artifacts so Claude Code doesn't detect a stale native install
RUN rm -rf /root/.local/bin/claude

# Non-root user with sudo — passes Claude Code's root check while allowing tool installs
RUN useradd -m -s /bin/bash user \\
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER user
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Container missing required tool: git. Install with: apt-get install -y git' },
      { cmd: 'claude', name: 'claude', hint: 'Container missing required tool: claude. Install with: curl -fsSL https://claude.ai/install.sh | bash' },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    try {
      const result = spawnSync(['claude', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (result.exitCode === 0) {
        const version = result.stdout.toString().trim();
        return [{ state: 'ok', what: `Claude Code CLI installed (${version})` }];
      }
    } catch {
      // Fall through to failure
    }
    return [{
      state: 'fail',
      what: 'Claude Code CLI installed',
      reason: 'Claude Code CLI not found. Install: curl -fsSL https://claude.ai/install.sh | bash',
    }];
  }
}
