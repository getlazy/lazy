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

/** Install a `lazy-agent` executable in `binDir`; returns its path. */
export async function installFakeAgentBinary(binDir: string): Promise<string> {
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
      'echo "fake lazy-agent: unsupported invocation: $*" >&2',
      'exit 64',
      '',
    ].join('\n'),
  );
  await chmod(binPath, 0o755);
  return binPath;
}
