/**
 * ClaudeCodePackaging — Packaging and deployment concerns for Claude Code.
 *
 * Extracted from src/capture/claude.ts (DEFAULT_DOCKERFILE) and
 * src/runner/docker-runner.ts (supervisorToolChecks, diagnose).
 */

import type { AgentPackaging } from './interface';

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
    return 'RUN bun install -g @anthropic-ai/claude-code@latest && chmod o+x /root && chmod -R o+rX /root/.bun';
  }

  generateDockerfile(): string {
    return `FROM oven/bun:slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# bun install -g puts packages in /root/.bun/ and symlinks binaries to /usr/local/bin/.
# The symlinks point into /root/ which is 700 by default, so the non-root user can't
# follow them. Open /root for traversal so the "user" account can run claude.
${this.dockerInstallCommand()}

RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Container missing required tool: git. Install with: apt-get install -y git' },
      { cmd: 'claude', name: 'claude', hint: 'Container missing required tool: claude. Install with: npm install -g @anthropic-ai/claude-code' },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    try {
      const result = Bun.spawnSync(['claude', '--version'], {
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
      reason: 'Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code',
    }];
  }
}
