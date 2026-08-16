/**
 * Fake `lazy-agent` binary for tests that run the real builder supervisor.
 *
 * The supervisor's startup preflight execs `lazy-agent selfcheck` and refuses
 * to launch unless it prints the agent's sentinel line (see
 * `preflightAgentBinary` in src/supervisor/builder.ts). In production that
 * binary is the compiled agent mounted into the container; a test that drives
 * the supervisor as a plain subprocess has to supply something that answers the
 * same way. This is deliberately the ONLY thing the fake does — every other
 * `lazy-agent` invocation exits non-zero so a test can never accidentally
 * depend on it doing real work.
 */

import { chmod, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Install a `lazy-agent` executable in `binDir`; returns its path.
 *
 * `agentEntry` (path to src/agent-entry.ts) makes `lazy-agent mcp` run the REAL
 * MCP server under bun. The supervisor's launch preflight does not merely check
 * that the binary exists — it starts the MCP server the way Claude Code will and
 * requires a JSON-RPC `initialize` response (`probeLazyMcpServerStartup`). A
 * stub that exits non-zero for `mcp` therefore aborts every supervisor launch,
 * which is not a property of the code under test. Omit it only for suites that
 * never reach that probe.
 */
export async function installFakeAgentBinary(binDir: string, agentEntry?: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, 'lazy-agent');
  await writeFile(
    binPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "selfcheck" ]; then',
      '  echo "lazy-agent ok (fake, e2e)"',
      '  exit 0',
      'fi',
      ...(agentEntry
        ? [
            'if [ "$1" = "mcp" ]; then',
            `  exec bun run ${JSON.stringify(agentEntry)} "$@"`,
            'fi',
          ]
        : []),
      'echo "fake lazy-agent: unsupported invocation: $*" >&2',
      'exit 64',
      '',
    ].join('\n'),
  );
  await chmod(binPath, 0o755);
  return binPath;
}
