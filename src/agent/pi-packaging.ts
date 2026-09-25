/**
 * PiPackaging — packaging and deployment concerns for the pi coding agent
 * (pi.dev, npm package `@earendil-works/pi-coding-agent`).
 *
 * Verified against pi 0.84.4 (add-pi-agent, 2026-09-02): the npm package ships
 * a pure-ESM bundle whose bin has a `#!/usr/bin/env node` shebang. Lazy's
 * container images carry bun, not node, so the install writes a small wrapper
 * that runs pi's bundled cli.js under bun — verified working — instead of
 * shimming a fake `node` onto PATH, which would change what `node` means for
 * every project built on the image.
 *
 * The version is PINNED. pi releases frequently and its CLI surface is what
 * lazy's arg-building and parsing were verified against; a floating `latest`
 * would let an unreviewed release change the contract under every task
 * container rebuild.
 */

import type { AgentPackaging } from './interface';
import { spawnSyncUnsupervised } from '../utils/spawn';

/** The npm package and version lazy installs and was verified against. */
export const PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent';
export const PI_PINNED_VERSION = '0.84.4';

export const PI_INSTALL_HINT =
  `Install with: bun add -g --ignore-scripts ${PI_NPM_PACKAGE}@${PI_PINNED_VERSION} ` +
  '(needs node or a bun wrapper on PATH as `pi`)';

/** Path of pi's bundled entry point under a `bun add -g` install. */
const PI_GLOBAL_CLI_JS =
  `/home/user/.bun/install/global/node_modules/${PI_NPM_PACKAGE}/dist/bundle/cli.js`;

export class PiPackaging implements AgentPackaging {
  readonly agentId = 'pi';

  configDirName(): string {
    // pi keeps everything under ~/.pi/agent (sessions, auth.json, models.json,
    // extensions). The mountable home dir is `.pi`.
    return '.pi';
  }

  npmPackage(): string {
    return `${PI_NPM_PACKAGE}@${PI_PINNED_VERSION}`;
  }

  binaryName(): string {
    return 'pi';
  }

  supportsContainerRunner(): boolean {
    return true;
  }

  dockerInstallCommand(): string {
    // Appended to the DEFAULT base Dockerfile (no bun there), as `user`:
    // install bun for pi's runtime, install the pinned package with postinstall
    // scripts blocked, then write a bun wrapper — pi's own bin shebang wants
    // node, which the image deliberately does not have.
    return (
      'RUN curl -fsSL https://bun.sh/install | bash \\\n' +
      `    && /home/user/.bun/bin/bun add -g --ignore-scripts ${PI_NPM_PACKAGE}@${PI_PINNED_VERSION} \\\n` +
      '    && mkdir -p /home/user/.local/bin \\\n' +
      `    && printf '#!/bin/sh\\nexec /home/user/.bun/bin/bun ${PI_GLOBAL_CLI_JS} "$@"\\n' > /home/user/.local/bin/pi \\\n` +
      '    && chmod +x /home/user/.local/bin/pi'
    );
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

# Install the pi coding agent (pinned) with a bun wrapper as \`user\`.
${this.dockerInstallCommand()}

WORKDIR /work
`;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Missing required tool: git. Install with your system package manager.' },
      // cmd must be a bare binary name: the supervisor's startup check resolves
      // it with `which`, which cannot take arguments.
      { cmd: 'pi', name: 'pi CLI', hint: `pi CLI not found. ${PI_INSTALL_HINT}` },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    const results: { state: 'ok' | 'fail'; what: string; reason?: string }[] = [];
    try {
      const version = spawnSyncUnsupervised(['pi', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (version.exitCode === 0) {
        results.push({ state: 'ok', what: `pi CLI installed (v${version.stdout.toString().trim()})` });
      } else {
        return [{
          state: 'fail',
          what: 'pi CLI installed',
          reason: `pi CLI not found. ${PI_INSTALL_HINT}`,
        }];
      }
    } catch {
      return [{
        state: 'fail',
        what: 'pi CLI installed',
        reason: `pi CLI not found. ${PI_INSTALL_HINT}`,
      }];
    }

    // Auth is not pi's own: task turns ride lazy's Anthropic/Ollama credentials
    // through the proxy (see src/agent/pi.ts), so there is no per-agent key to
    // probe here — `lazy doctor`'s credential checks already cover both.
    results.push({
      state: 'ok',
      what: 'pi auth rides lazy credentials (Anthropic / Ollama via the proxy — no pi-specific key)',
    });

    return results;
  }
}
