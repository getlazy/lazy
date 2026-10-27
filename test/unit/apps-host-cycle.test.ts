import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const probe = resolve(import.meta.dir, '../../scripts/smolvm-probes/apps-stateful.sh');

async function runProbe(dryRun: boolean, result: object, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'apps-host-cycle-'));
  try {
    const scripts = join(root, 'scripts/lazy-apps-probes/stateful');
    const results = join(root, 'results');
    const marker = join(root, 'invoked');
    await mkdir(scripts, { recursive: true });
    await mkdir(results);
    // The Docker runner is the external boundary of this harness adapter.
    // These tests never claim to have executed Docker or a VM.
    await writeFile(join(scripts, 'run-docker.sh'), `
set -eu
printf invoked > "$S24_MARKER"
mkdir "$2"
printf '%s\\n' "$S24_RESULT" > "$2/runner.json"
exit "$S24_EXIT"
`);
    const command = Bun.spawnSync(['bash', '-uc', `
source "$1"
REPO_ROOT=$2
RESULTS_DIR=$3
DRY_RUN=$4
criterion() { printf 'CRITERION\\n'; }
say() { printf '%s\\n' "$*"; }
record() { printf 'RESULT %s %s\\n' "$1" "$2"; }
capture() { shift; "$@"; }
probe_S24
`, 'probe', probe, root, results, dryRun ? '1' : '0'], {
      env: { ...process.env, S24_MARKER: marker, S24_RESULT: JSON.stringify(result), S24_EXIT: String(exitCode) },
      timeout: 5000,
    });
    expect(command.exitCode, command.stderr.toString()).toBe(0);
    let invoked = false;
    try {
      invoked = (await readFile(marker, 'utf8')) === 'invoked';
    } catch (error) {
      // Absence is the expected dry-run observation; other I/O errors fail.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not read host-probe invocation marker ${marker}: ${error}`);
      }
    }
    return { output: command.stdout.toString(), invoked };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// INVARIANT: rehearsal cannot execute the workload or become runtime evidence.
// The host command is deliberately safe to rehearse in a container without Docker.
test('S24 dry-run states its criterion but never invokes the runner', async () => {
  const result = await runProbe(true, {});
  expect(result.invoked).toBe(false);
  expect(result.output).toContain('RESULT S24 DRY-RUN');
  expect(result.output).not.toContain('RESULT S24 PASS');
});

// INVARIANT: a successful shell exit alone cannot certify a workload pass.
// The runner's evidence must agree, including actual execution and cleanup.
test('S24 refuses failed, unexecuted, or contradictory evidence', async () => {
  const pass = { passed: true, executed: true, status: 'passed', exit: 0 };
  for (const [result, code] of [
    [pass, 1],
    [{ ...pass, passed: false }, 0],
    [{ ...pass, executed: false }, 0],
    [{ ...pass, status: 'dry-run' }, 0],
    [{ ...pass, exit: 1 }, 0],
    [{ passed: true, executed: true, status: 'passed' }, 0],
    [{}, 0],
  ] as const) {
    const observation = await runProbe(false, result, code);
    expect(observation.invoked).toBe(true);
    expect(observation.output).toContain('RESULT S24 ERROR');
    expect(observation.output).not.toContain('RESULT S24 PASS');
  }
});

test('S24 records the criterion before a verified runner result', async () => {
  const result = await runProbe(false, { passed: true, executed: true, status: 'passed', exit: 0 });
  expect(result.invoked).toBe(true);
  expect(result.output).toBe('CRITERION\nRESULT S24 PASS\n');
});
