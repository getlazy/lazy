/**
 * CursorPackaging — Packaging and deployment concerns for Cursor CLI.
 *
 * Cursor is host-process only — Docker methods throw clear errors.
 */

import type { AgentPackaging } from './interface';
import { spawnSync } from '../utils/spawn';

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
    return 'agent';
  }

  dockerInstallCommand(): string {
    throw new Error(
      'Cursor agent does not support Docker runner. Use runner = "dangerously-host-process-without-any-isolation" in lazy.toml.'
    );
  }

  generateDockerfile(): string {
    throw new Error(
      'Cursor agent does not support Docker runner. Use runner = "dangerously-host-process-without-any-isolation" in lazy.toml.'
    );
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Missing required tool: git. Install with your system package manager.' },
      { cmd: 'agent --version', name: 'Cursor CLI', hint: 'Cursor CLI (agent) not found. Install from: https://www.cursor.com/' },
      { cmd: 'lazy-agent', name: 'lazy-agent', hint: 'lazy-agent binary not found at /usr/local/bin/lazy-agent. This is likely a volume mount issue.' },
    ];
  }

  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[] {
    try {
      const result = spawnSync(['agent', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      if (result.exitCode === 0) {
        const version = result.stdout.toString().trim();
        return [{ state: 'ok', what: `Cursor CLI installed (${version})` }];
      }
    } catch {
      // Fall through to failure
    }
    return [{
      state: 'fail',
      what: 'Cursor CLI installed',
      reason: 'Cursor CLI (agent) not found. Install from: https://www.cursor.com/',
    }];
  }
}
