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
 * The version is NOT pinned, like every other harness: images install pi's
 * latest release, and lazy tolerates harness upgrades rather than freezing
 * them. Re-verified unchanged against 1.3.0 (pi-agent-unpin-1x, 2026-10-21):
 * headless json stream, --session-id resume, --thinking request bodies on all
 * three wires, the extension bridge and models.json — see
 * docs/pi-agent-integration.md.
 */

import type { HealthCheck } from '../remote/driver';
import type { AgentPackaging } from './interface';
import { spawnSyncUnsupervised } from '../utils/spawn';

/** The npm package lazy installs (latest release, unpinned). */
export const PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * The oldest pi lazy's argv works with: 1.0.4 added `--no-mcp`, which every
 * launch passes, and an older pi exits on it as an unknown option. A floor,
 * not a pin — images install the latest release.
 */
export const PI_MIN_VERSION = '1.0.4';

export const PI_INSTALL_HINT =
  `Install with: bun add -g --ignore-scripts ${PI_NPM_PACKAGE} ` +
  `(pi ${PI_MIN_VERSION} or later; needs node or a bun wrapper on PATH as \`pi\`)`;

/**
 * Whether a `pi --version` string is at least {@link PI_MIN_VERSION}. An
 * unparseable version is not judged too old — only a recognisably older one.
 */
export function piVersionMeetsMinimum(version: string): boolean {
  const parse = (v: string) => v.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const have = parse(version);
  const need = parse(PI_MIN_VERSION)!;
  if (!have) return true;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

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
    return PI_NPM_PACKAGE;
  }

  binaryName(): string {
    return 'pi';
  }

  supportsContainerRunner(): boolean {
    return true;
  }

  dockerInstallCommand(): string {
    // Appended to the DEFAULT base Dockerfile (no bun there), as `user`:
    // install bun for pi's runtime, install the latest package with postinstall
    // scripts blocked, then write a bun wrapper — pi's own bin shebang wants
    // node, which the image deliberately does not have.
    return (
      'RUN curl -fsSL https://bun.sh/install | bash \\\n' +
      `    && /home/user/.bun/bin/bun add -g --ignore-scripts ${PI_NPM_PACKAGE} \\\n` +
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

# Install the pi coding agent (latest) with a bun wrapper as \`user\`.
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

  diagnose(): HealthCheck[] {
    const results: HealthCheck[] = [];
    try {
      const version = spawnSyncUnsupervised(['pi', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (version.exitCode === 0) {
        const installed = version.stdout.toString().trim();
        if (!piVersionMeetsMinimum(installed)) {
          return [{
            state: 'fail',
            what: `pi CLI installed (v${installed})`,
            problem: `pi ${installed} is older than ${PI_MIN_VERSION}, the oldest version lazy can run`,
            reason: `Every pi turn would fail on an unknown option. ${PI_INSTALL_HINT}`,
          }];
        }
        results.push({ state: 'ok', what: `pi CLI installed (v${installed})` });
      } else {
        return [{
          state: 'fail',
          what: 'pi CLI installed',
          problem: 'pi CLI isn\'t installed',
          reason: `pi CLI not found. ${PI_INSTALL_HINT}`,
        }];
      }
    } catch {
      return [{
        state: 'fail',
        what: 'pi CLI installed',
        problem: 'pi CLI isn\'t installed',
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
