/**
 * INVARIANT: revoking the builder's MCP token on exit is BEST EFFORT.
 *
 * `lazy builder` revokes the session's token in the `finally` of its launch
 * path, i.e. on the way out of an interactive session the human has already
 * finished. A daemon that has since crashed, been stopped, or has an unreadable
 * token registry must never turn a normal builder exit into a failure — but it
 * must not fail SILENTLY either: the stale token is then only bounded by the
 * registry's builder cap, and the human deserves to know.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { revokeBuilderMcpToken } from '../../src/builder/mcp-session';
import { mintMcpToken, peekMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { getMcpTokensPath } from '../../src/daemon/paths';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { logger } from '../../src/utils/logger';
import { requireLazyRoot } from '../../src/cli/helpers';

// This suite calls src/ directly, in a project with no daemon by design.
enableInProcessTestMode();

describe('builder MCP token revocation on exit', () => {
  let baseDir: string;
  let root: string;
  let warnings: string[];
  let restoreWarn: () => void;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    clearMcpTokenCache();
    // The exit hook talks to the daemon; with LAZY_DAEMON_BASE_DIR pointed at an
    // empty temp dir there is no socket to reach, so it falls through to the
    // in-process handler — against the project root the CLI itself would resolve
    // (from a worktree that is the MAIN repo root, not cwd).
    root = requireLazyRoot();

    warnings = [];
    const original = logger.warn.bind(logger);
    logger.warn = ((message: string) => { warnings.push(message); }) as typeof logger.warn;
    restoreWarn = () => { logger.warn = original; };
  });

  afterEach(async () => {
    restoreWarn();
    clearMcpTokenCache();
    delete process.env.LAZY_DAEMON_BASE_DIR;
    await removeDaemonBaseDir(baseDir);
  });

  test('revokes the session token', async () => {
    await mintMcpToken(root, { kind: 'builder' }, 'builder-42');

    await revokeBuilderMcpToken('builder-42');

    expect(await peekMcpToken(root, { kind: 'builder' }, 'builder-42')).toBeNull();
    expect(warnings).toEqual([]);
  });

  // The failure mode this exists for: exit must complete anyway, and say so.
  test('a failing revoke warns instead of breaking builder exit', async () => {
    const registryPath = getMcpTokensPath(root);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, 'not json{');
    clearMcpTokenCache();

    // Must resolve, not reject — the builder has already exited.
    await revokeBuilderMcpToken('builder-42');

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('builder-42');
    expect(warnings[0]).toContain('remains valid');
  });

  // The hook runs on every builder exit, including sessions that never got a
  // token (host-process runner, a daemon that was down at launch).
  test('an unknown builder name is a quiet no-op', async () => {
    await revokeBuilderMcpToken('builder-never-launched');
    expect(warnings).toEqual([]);
  });
});
