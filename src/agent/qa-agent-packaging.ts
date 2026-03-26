/**
 * QaAgentPackaging — Packaging and deployment concerns for qa-agent.
 *
 * qa-agent runs as a bun script — no external binary or npm package needed.
 * For Docker, it's already available in the container via the lazy source tree.
 * For host-process, it just runs locally via bun.
 */

import type { AgentPackaging } from './interface';

export class QaAgentPackaging implements AgentPackaging {
  readonly agentId = 'qa-agent';

  configDirName(): string {
    return '.qa-agent';
  }

  npmPackage(): string {
    // qa-agent is part of the lazy source tree, not an npm package.
    return '';
  }

  binaryName(): string {
    return 'bun';
  }

  dockerInstallCommand(): string {
    // qa-agent is a bun script shipped with lazy — no install needed.
    // Bun is already in the base Docker image.
    return '# qa-agent: no install needed (runs via bun from lazy source tree)';
  }

  generateDockerfile(): string {
    return `FROM oven/bun:slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Non-root user with sudo
RUN useradd -m -s /bin/bash user
USER user

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Missing required tool: git. Install with your system package manager.' },
      { cmd: 'bun --version', name: 'bun', hint: 'Missing required tool: bun. Install from: https://bun.sh/' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    return [{ state: 'ok', what: 'qa-agent available (built-in bun script)' }];
  }
}
