/**
 * The `~/.claude.json` a builder supervisor expects to find in its HOME.
 *
 * Any suite that drives the REAL `lazy-agent builder` supervisor has to supply
 * this file, because the supervisor's MCP preflight
 * (`preflightBuilderMcpConfig` + `probeLazyMcpServerStartup`, see
 * src/builder/mcp-config-check.ts) refuses to hand off to Claude Code unless:
 *
 *   1. `$HOME/.claude.json` is readable, and
 *   2. its `mcpServers.lazy` entry carries the SAME `--daemon-config <path>`
 *      the supervisor was launched with, and
 *   3. that entry, spawned as a child, answers an MCP `initialize` handshake.
 *
 * In production the file is a per-launch copy written by
 * `writeBuilderClaudeSessionConfig` and bind-mounted into the container
 * (src/builder/claude-home.ts); the runner builds the args in
 * src/runner/docker-runner.ts. This mirrors that shape.
 *
 * The one deliberate difference: `command` is `bun run src/agent-entry.ts`
 * rather than `lazy-agent`. The fake `lazy-agent` these suites put on PATH
 * answers `selfcheck` and nothing else (see fake-agent-binary.ts), so the probe
 * would have nothing real to talk to. Pointing it at the agent entrypoint runs
 * the REAL MCP server against the suite's real test daemon — the probe then
 * proves what it claims to prove instead of handshaking with a stub.
 */

import { writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

/**
 * Write `$HOME/.claude.json` naming `daemonConfigPath` as the lazy MCP
 * credential, and return the path written.
 *
 * @param home             Temp HOME the supervisor is launched with
 * @param daemonConfigPath The `--daemon-config` the supervisor gets — must match
 * @param worktree         Repo root the MCP server is pointed at
 */
export async function writeBuilderClaudeConfig(
  home: string,
  daemonConfigPath: string,
  worktree: string,
): Promise<string> {
  const path = join(home, '.claude.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        mcpServers: {
          lazy: {
            command: 'bun',
            args: [
              'run', AGENT_ENTRY,
              'mcp',
              '--daemon-config', daemonConfigPath,
              '--worktree', worktree,
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  return path;
}
