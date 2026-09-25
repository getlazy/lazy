/**
 * Every test-spawned MCP server must be launched with `MCP_SERVER_ENV_PINS`.
 *
 * WHY THIS EXISTS
 * ---------------
 * MCP e2e suites spawn the server themselves — `spawn([..., 'mcp', ...], { env:
 * { ...process.env } })` — so they inherit whatever the `bun test` process
 * carries. Four inherited variables silently break them (see
 * test/helpers/mcp-env.ts): `LAZY_TEST` and `LAZY_IS_DAEMON` reroute the
 * server's storage, and the turn-identity pair makes it fail-closed outright.
 *
 * The last one is the reason this scan exists rather than a comment. When lazy
 * is developed WITH lazy, `bun test` runs inside a task agent's process tree, so
 * `LAZY_MCP_EXPECTED_TASK_ID` is always set and every unpinned suite refuses to
 * start with an error naming the AGENT's task. That is a whole test file going
 * red for a reason unrelated to the code under test — and it stayed unnoticed on
 * main across several suites, because a suite nobody runs is indistinguishable
 * from a suite that passes.
 *
 * A missing pin is a one-line omission in a new file, so catch it as drift the
 * way `cli-flag-alias-coverage` catches a missing flag alias — cheaply, in the
 * unit suite, with no CI machinery.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';

const E2E_DIR = resolve(__dirname, '../e2e');

/** A spawn of the MCP server: `AGENT_ENTRY, 'mcp'` in the argv array. */
const SPAWNS_MCP_SERVER = /AGENT_ENTRY,\s*['"]mcp['"]/;

/**
 * Spawns that take no env because they never reach the store or the identity
 * guard: `mcp --help` and the bare `mcp` usage error both exit before either.
 */
const ARGV_ONLY_SPAWN = /AGENT_ENTRY,\s*['"]mcp['"],?\s*(['"]--help['"])?\s*\]/;

describe('MCP server spawns in e2e suites', () => {
  test('every file that spawns the MCP server pins its environment', async () => {
    const files = (await readdir(E2E_DIR)).filter(f => f.endsWith('.test.ts'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(join(E2E_DIR, file), 'utf-8');
      if (!SPAWNS_MCP_SERVER.test(source)) continue;

      // Only argv-only spawns (--help / usage) — nothing to pin.
      const realSpawns = source
        .split('\n')
        .filter(line => SPAWNS_MCP_SERVER.test(line) && !ARGV_ONLY_SPAWN.test(line));
      if (realSpawns.length === 0) continue;

      if (!source.includes('MCP_SERVER_ENV_PINS')) offenders.push(file);
    }

    expect({ offenders }).toEqual({ offenders: [] });
  });
});
