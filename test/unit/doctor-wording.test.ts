import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DockerRunner, probeDaemonResponsive } from '../../src/runner/docker-runner';
import { runChecks, toStructuredCheck } from '../../src/doctor/registry';
import { formatAgentDoctorReport, type AgentDoctorResult } from '../../src/agent/doctor';
import { buildRunnerRows } from '../../src/daemon/daemon-health-rows';

describe('doctor wording', () => {
  // INVARIANT: a failing check is titled by its PROBLEM, a passing one by its
  // condition, and the family still comes from the pass wording. "The check
  // that failed: Docker daemon running" reads as a pass when skimmed.
  test('a failure is titled by its problem, a pass by its condition', () => {
    const bad = toStructuredCheck({ ok: false, label: 'Docker daemon running', problem: "Docker isn't responding", detail: 'x' });
    const good = toStructuredCheck({ ok: true, label: 'Docker daemon running' });
    expect(bad.title).toBe("Docker isn't responding");
    expect(good.title).toBe('Docker daemon running');
    expect(bad.id).toBe(good.id);
  });

  // INVARIANT: a check that throws is titled by its own required fail wording,
  // so even the generic runner never reports the pass condition.
  test('a thrown check is titled by its required problem', async () => {
    const report = await runChecks([
      { id: 'docker', title: 'Docker daemon running', problem: "Docker isn't responding", run: async () => { throw new Error('boom'); } },
    ], {});
    expect(report.checks[0]).toMatchObject({ status: 'error', title: "Docker isn't responding" });
  });

  // INVARIANT: lazy-agent doctor prints what is wrong beside the ✗ and in the
  // FAILED line, never the label of the thing checked.
  test('lazy-agent doctor prints the problem on a failed link', () => {
    const result: AgentDoctorResult = {
      host: 'h', taskId: 't', ok: false,
      checks: [
        { id: 'daemon-config', label: 'LAZY_DAEMON_CONFIG', ok: false, problem: 'LAZY_DAEMON_CONFIG is not set', detail: 'not set in this environment' },
        { id: 'tool-permissions', label: '~/.claude/settings.json permissions', ok: true, detail: 'fine' },
      ],
    };
    const text = formatAgentDoctorReport(result);
    expect(text).toContain('✗ LAZY_DAEMON_CONFIG is not set');
    expect(text).toContain('✓ ~/.claude/settings.json permissions');
    expect(text).toContain('FAILED: LAZY_DAEMON_CONFIG is not set');
    expect(text).not.toContain('✗ LAZY_DAEMON_CONFIG\n');
  });

  test('runner rows name the problem on a failure', () => {
    const rows = buildRunnerRows('docker', [
      { state: 'fail', what: 'Docker daemon running', problem: "Docker isn't responding", reason: 'r' },
    ]);
    expect(rows[0]!.name).toBe("Docker isn't responding");
  });
});

async function fakeDocker(script: string): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-docker-'));
  const bin = join(dir, 'docker');
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return { bin, dir };
}

describe('Docker daemon probe', () => {
  // INVARIANT: a slow-but-alive dockerd (busy building an image) is not a
  // fault: the first `info` misses its deadline, the retry answers.
  test('a busy daemon that answers on the second try is responsive', async () => {
    const { bin, dir } = await fakeDocker(`C="$(dirname "$0")/count"\nN=$(cat "$C" 2>/dev/null || echo 0)\necho $((N+1)) > "$C"\n[ "$N" -ge 1 ] || sleep 5\nexit 0`);
    try {
      const r = await probeDaemonResponsive(bin, { timeoutMs: 300, backoffMs: [10] });
      expect(r.responsive).toBe(true);
      expect(r.attempts).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a daemon that never answers fails after every attempt', async () => {
    const { bin, dir } = await fakeDocker('exit 1');
    try {
      const r = await probeDaemonResponsive(bin, { timeoutMs: 300, backoffMs: [10, 10] });
      expect(r).toMatchObject({ responsive: false, attempts: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // INVARIANT: diagnose() is what doctor shows. A daemon that never answers
  // fails with the problem wording and the attempt count; the bounded health
  // path (launchProbes: false) tries once, so it stays inside its deadline.
  test('DockerRunner.diagnose names the problem and counts the attempts', async () => {
    const { bin, dir } = await fakeDocker('case "$1" in --version) echo "Docker version 27.0.1, build x"; exit 0;; esac\nexit 1');
    try {
      const full = (await new DockerRunner(bin).diagnose({ launchProbes: false })).find(c => c.what === 'Docker daemon running')!;
      expect(full).toMatchObject({ state: 'fail', problem: "Docker isn't responding" });
      expect(full.reason).toContain('Tried 1 time ');

      const thorough = (await new DockerRunner(bin).diagnose()).find(c => c.what === 'Docker daemon running')!;
      expect(thorough.problem).toBe("Docker isn't responding");
      expect(thorough.reason).toContain('Tried 3 times');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
