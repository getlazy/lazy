/**
 * `buildBuilderDockerArgs({ detached: true })` — the argv shape a daemon-owned
 * builder session container launches with (docs/design/actor-identity-and-remote-clients.md §5.2).
 *
 * Pure-function test, no Docker required: the whole point of a daemon-owned
 * session is that the container's lifetime is the SESSION's, not the launching
 * process's — `-d` with no `--rm`, so the process that requested the launch
 * exiting cannot tear the container down the way `docker run --rm` would.
 *
 * `-d` alone is not enough, though: the container's command is the
 * INTERACTIVE builder supervisor, which spawns Claude Code with
 * `stdin: 'inherit'` expecting a pty. Without `-i -t` there is no pty and no
 * open stdin, Claude Code's TUI gets EOF immediately, and the container exits
 * within seconds of starting — the opposite of "the container's lifetime is
 * the session's". `-i -t` is also exactly what a later `docker attach` needs
 * to exist at all. So a detached launch is `-d -i -t`, never bare `-d`.
 */

import { describe, test, expect } from 'bun:test';
import { buildBuilderDockerArgs } from '../../src/runner/docker-runner';

const PROJECT_ROOT = '/tmp/lazy-invariant-project';

function argsFor(opts: { detached?: boolean; resume?: string[] } = {}): string[] {
  return buildBuilderDockerArgs({
    binary: 'docker',
    builderId: 'a1b2c3d4',
    lazyRoot: PROJECT_ROOT,
    dataDir: `${PROJECT_ROOT}/.lazy`,
    scratchDir: '/home/user/.lazy/scratch/lazy-invariant-project-deadbeef',
    containerConfigFile: `${PROJECT_ROOT}/.lazy/tmp/builder-container-a1b2c3d4.json`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    home: '/home/user',
    neutralCredentialStore: `${PROJECT_ROOT}/.lazy/tmp/creds-a1b2c3d4.json`,
    mergedConfigFile: `${PROJECT_ROOT}/.lazy/builder-claude.json`,
    authEnvVars: [{ key: 'ANTHROPIC_API_KEY', value: 'x' }],
    imageName: 'lazy-agent:latest',
    promptFile: `${PROJECT_ROOT}/.lazy/tmp/builder-prompt-1.txt`,
    claudeExtraArgs: opts.resume ?? [],
    debug: false,
    detached: opts.detached,
  });
}

describe('detached builder session argv', () => {
  // INVARIANT: a detached session container must keep a pty and open stdin —
  // it runs the interactive supervisor, which needs both to keep Claude Code
  // alive, and `docker attach` (the route child 11 builds) needs `-i -t` on
  // the ORIGINAL `run` to have anything to attach to. `-d` alone launches a
  // container that exits within seconds of starting.
  test('a detached launch runs -d -i -t, with no --rm', () => {
    const args = argsFor({ detached: true });
    expect(args).toContain('-d');
    expect(args).toContain('-i');
    expect(args).toContain('-t');
    expect(args).not.toContain('--rm');
  });

  test('a normal (non-detached) interactive launch is unchanged: -it --rm, no -d', () => {
    const args = argsFor({ detached: false });
    expect(args).toContain('-it');
    expect(args).toContain('--rm');
    expect(args).not.toContain('-d');
  });

  test('a detached launch still runs the interactive builder supervisor, not a one-shot claude -p', () => {
    const args = argsFor({ detached: true });
    expect(args).toContain('lazy-agent');
    expect(args).toContain('builder');
    expect(args).toContain('--builder-id');
    expect(args[args.indexOf('--builder-id') + 1]).toBe('a1b2c3d4');
  });

  test('--resume is threaded through claudeExtraArgs for a resumed session', () => {
    const args = argsFor({ detached: true, resume: ['--resume', 'sess-xyz'] });
    const dashDash = args.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(args.slice(dashDash + 1)).toEqual(['--resume', 'sess-xyz']);
  });
});

describe('detached builder session prompt mount', () => {
  // INVARIANT: a detached session's prompt file lives in the member's own
  // launch dir, OUTSIDE the data-dir mount, so it must be mounted on its own —
  // read-only, at the path the supervisor is told to read. Without the mount
  // the supervisor starts with no system prompt it can open.
  test('a detached launch mounts its prompt file read-only; a foreground one does not add it', () => {
    const detached = argsFor({ detached: true });
    const prompt = `${PROJECT_ROOT}/.lazy/tmp/builder-prompt-1.txt`;
    expect(detached.join(' ')).toContain(`-v ${prompt}:${prompt}:ro`);
    expect(argsFor({ detached: false }).join(' ')).not.toContain(`${prompt}:${prompt}:ro`);
  });
});
