/**
 * The repository-host check as a MANAGED (Lazy Teams) daemon must run it.
 *
 * On a laptop the forge driver's own `checkHealth()` is the truth: pushes and
 * PR/MR work go through the human's `gh` / `glab` login. A Teams daemon is
 * different by construction. Its git authenticates through a credential helper
 * the fleet installs in the clone's `.git/config`, reading the member's forge
 * token (`GH_TOKEN` / `GITLAB_TOKEN`) from the daemon's environment — and the
 * daemon image ships git but NO forge CLI. So the driver's check failed at
 * "gh CLI installed" on every microVM project, and Teams told members their
 * repository host was unreachable while clones, fetches and pushes all worked.
 *
 * What this measures instead:
 *   1. Can git reach AND authenticate against the remote through the clone's
 *      configured credential helper? (`git ls-remote`, exactly the path the
 *      daemon's pushes take.) This is the one that stops work, so it FAILS.
 *   2. Are the forge API features (PR/MR creation on `lazy submit`, review and
 *      comment reads) available here? They need the CLI and the token. Absent
 *      either, that is a WARNING naming what is missing — pushing and
 *      accepting still work, so it must not read as "can't reach the host".
 */

import type { ResolvedConfig } from '../config';
import type { HealthCheck } from '../remote/driver';
import { spawn } from '../utils/spawn';

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type RunCommand = (argv: string[], cwd: string) => Promise<CommandResult>;

const LS_REMOTE_TIMEOUT_MS = 20_000;

const FORGES: Record<string, { label: string; cli: string; tokenVar: string; feature: string }> = {
  github: { label: 'GitHub', cli: 'gh', tokenVar: 'GH_TOKEN', feature: 'pull requests' },
  gitlab: { label: 'GitLab', cli: 'glab', tokenVar: 'GITLAB_TOKEN', feature: 'merge requests' },
};

export const defaultRunCommand: RunCommand = async (argv, cwd) => {
  try {
    const proc = spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // Never prompt: a missing credential must fail, not hang the sweep.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: LS_REMOTE_TIMEOUT_MS,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    // spawn's ENOENT message names the missing binary — that IS the answer.
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

/** True when this driver's health is measured by `managedRepositoryHostChecks` under managed mode. */
export function isForgeDriver(driverName: string): boolean {
  return driverName in FORGES;
}

export async function managedRepositoryHostChecks(
  config: ResolvedConfig,
  root: string,
  run: RunCommand = defaultRunCommand,
  env: NodeJS.ProcessEnv = process.env,
  driverChecks?: () => Promise<HealthCheck[]>,
): Promise<HealthCheck[]> {
  const forge = FORGES[config.remote.driver];
  if (!forge) throw new Error(`managedRepositoryHostChecks: driver "${config.remote.driver}" is not a forge driver`);
  const remote = config.remote.git_remote;
  const checks: HealthCheck[] = [];

  const url = await run(['git', 'remote', 'get-url', remote], root);
  if (url.exitCode !== 0) {
    checks.push({ state: 'fail', what: `Git remote ${remote}`, reason: `The clone has no remote '${remote}' configured.` });
    return checks;
  }

  const lsRemote = await run(['git', 'ls-remote', '--heads', remote], root);
  if (lsRemote.exitCode === 0) {
    checks.push({ state: 'ok', what: `Git can reach and authenticate to remote ${remote}` });
  } else {
    const why = lsRemote.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${lsRemote.exitCode}`;
    checks.push({
      state: 'fail',
      what: `Git can reach and authenticate to remote ${remote}`,
      reason: `git ls-remote ${remote} (${url.stdout.trim()}) failed through the clone's credential helper: ${why}. ` +
        `Check the project's forge connection token and that the repository still exists.`,
    });
  }

  // ls-remote proves READ access only — a public repository answers it
  // anonymously. Pushes and accepts authenticate through the helper, which reads
  // this token, so without it finished work cannot reach the host.
  const hasToken = Boolean(env[forge.tokenVar]);
  if (!hasToken) {
    checks.push({
      state: 'fail',
      what: 'Git push credential',
      reason: `No ${forge.label} token (${forge.tokenVar}) in the daemon's environment, so the credential helper has ` +
        `nothing to push with: the repository can be read, but pushes and accepts cannot authenticate. ` +
        `Connect a forge account for this project.`,
    });
  }

  // Forge API features. Not needed to push or accept, so never a failure.
  const missing: string[] = [];
  if (!hasToken) missing.push(`no ${forge.label} token (${forge.tokenVar}) in the daemon's environment`);
  const cli = await run([forge.cli, '--version'], root);
  if (cli.exitCode !== 0) missing.push(`the ${forge.cli} CLI is not installed in the daemon's environment`);
  if (missing.length === 0) {
    checks.push({ state: 'ok', what: `${forge.label} API features (${forge.feature})` });
    // With the CLI and token present the driver's API features really run here,
    // so keep its own findings (public-repo comment sync, token scopes, remote
    // shape) — as warnings, since none of them stops a push.
    if (driverChecks) {
      for (const c of await driverChecks()) {
        checks.push(c.state === 'fail' ? { state: 'warn', what: c.what, reason: c.reason } : c);
      }
    }
  } else {
    checks.push({
      state: 'warn',
      what: `${forge.label} API features (${forge.feature})`,
      reason: `Git push and accept work through the credential helper, but ${missing.join(' and ')}, ` +
        `so opening ${forge.feature} from this daemon and reading their reviews are unavailable here.`,
    });
  }
  return checks;
}
