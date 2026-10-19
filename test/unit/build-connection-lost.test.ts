/**
 * A Teams machine's image build whose docker client lost its connection to
 * BuildKit ("failed to receive status: rpc error: code = Unavailable desc =
 * error reading from server: EOF") is retried once when dockerd answers again,
 * and a final failure says what most likely happened.
 *
 * INVARIANT: on the microVM backend a lost build connection gets exactly ONE
 * automatic retry, and only after dockerd is confirmed to answer. The guest
 * dockerd dying mid-build (OOM on a small machine) surfaced only as BuildKit's
 * EOF, which reads as "a Docker problem" and names no cause.
 * INVARIANT: the final failure leads with the likely cause, named only from what
 * the machine RECORDED (a dockerd death or requested restart in its history, a
 * kernel OOM kill since the build started) — never a guess, never only the EOF,
 * and never "fix that Dockerfile".
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  diagnoseLostBuildConnection,
  explainLostBuildConnection,
  isBuildConnectionLost,
  parseDockerdHistory,
  parseMeminfo,
  parseOomKills,
  type DiagnoseDeps,
} from '../../src/daemon/build-connection-lost';
import { parseGuestInitReport } from '../../src/daemon/guest-dockerd';
import { ImageBuildJob } from '../../src/daemon/image-build-job';
import { buildFailureEscalation } from '../../src/daemon/image-state';
import { dockerdOomRemedy } from '../../src/daemon/guest-dockerd';

const EOF_LINE = 'ERROR: failed to build: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF';
const MEMINFO = 'MemTotal:        4194304 kB\nMemFree:          100000 kB\nMemAvailable:     204800 kB\n';
const HISTORY =
  '=== 2026-10-10T09:00:00Z dockerd (pid 12) stopped answering (cause=exited-1, exit_status=1)\n' +
  '--- last lines of /var/log/lazy-dockerd.log:\nblah\n' +
  '=== 2026-10-10T10:00:05Z dockerd (pid 40) stopped answering (cause=exited-137+oom-killer, exit_status=137)\n';
const ready = parseGuestInitReport('ready=yes\nsource=running-dockerd\n', '');
const BUILD_START = new Date('2026-10-10T10:00:00Z');

/** Deps for a check run 60s after BUILD_START, at 1000s since boot (build started at 940s). */
function deps(over: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  let clock = BUILD_START.getTime() + 60_000;
  return {
    recover: async () => ready,
    dockerAnswers: async () => true,
    sleep: async (ms) => { clock += ms; },
    readHistory: async () => '',
    readMeminfo: async () => MEMINFO,
    readUptimeSeconds: async () => 1000,
    readKernelLog: async () => '',
    now: () => clock,
    ...over,
  };
}

describe('recognising a lost build connection', () => {
  test('BuildKit EOF is recognised; a failing Dockerfile step is not', () => {
    expect(isBuildConnectionLost(`#3 transferring context: 1.79kB 0.6s done\n${EOF_LINE}`)).toBe(true);
    expect(isBuildConnectionLost('#5 ERROR: process "/bin/sh -c false" did not complete successfully: exit code: 1')).toBe(false);
  });

  // INVARIANT: only BuildKit's own error lines count. A Dockerfile step whose
  // OUTPUT contains the wording failed on its own — calling it a lost
  // connection blames the machine for the user's Dockerfile.
  test('the wording inside a step\'s output is not a lost connection', () => {
    const stepOutput = [
      '#7 [4/6] RUN ./fetch-deps.sh',
      '#7 1.204 rpc error: code = Unavailable desc = error reading from server: EOF',
      '#7 1.205 failed to receive status: rpc error: code = Unavailable',
      '#7 ERROR: process "/bin/sh -c ./fetch-deps.sh" did not complete successfully: exit code: 1',
      'ERROR: failed to solve: process "/bin/sh -c ./fetch-deps.sh" did not complete successfully: exit code: 1',
    ].join('\n');
    expect(isBuildConnectionLost(stepOutput)).toBe(false);
  });

  test('history, kernel log and meminfo parse', () => {
    const events = parseDockerdHistory(HISTORY + '=== 2026-10-10T10:01:00Z restarting dockerd: restart requested from god mode (not counted)\n');
    expect(events.map(e => e.kind)).toEqual(['death', 'death', 'requested']);
    expect(parseOomKills('[  900.1] Out of memory: Killed process 7 (old)\n[  950.5] Out of memory: Killed process 9 (buildkit-runc)\n', 940))
      .toEqual(['buildkit-runc']);
    expect(parseMeminfo(MEMINFO)).toEqual({ totalMiB: 4096, availableMiB: 200 });
  });
});

describe('the diagnosis names the cause from what the machine recorded', () => {
  test('a dockerd death during the build: when, how, OOM hint, retryable', async () => {
    const d = await diagnoseLostBuildConnection(BUILD_START, deps({ readHistory: async () => HISTORY }));
    expect(d.retryable).toBe(true);
    expect(d.headline).toContain('Docker stopped at 2026-10-10T10:00:05.000Z (out of memory)');
    expect(d.explanation).toContain('dockerd ran out of memory');
    expect(d.explanation).toContain('more memory');
    // The 09:00 death predates the build and is not blamed.
    expect(d.explanation).not.toContain('09:00');
  });

  test('the memory figures recorded with the death are named in the build error', async () => {
    const history = HISTORY + "--- kernel OOM kill of this dockerd:\n--- dockerd memory at the kill: used 7276440 kB of the machine's 8123456 kB\n";
    const d = await diagnoseLostBuildConnection(BUILD_START, deps({ readHistory: async () => history }));
    expect(d.explanation).toContain("dockerd ran out of memory (used 6.9 GiB of the machine's 7.7 GiB)");
  });

  test('dockerd stayed up, an OOM kill since the build started: named, with the process', async () => {
    const d = await diagnoseLostBuildConnection(BUILD_START, deps({
      readKernelLog: async () => '[  900.0] Killed process 3 (before)\n[  970.0] Out of memory: Killed process 9 (buildkit-runc)\n',
    }));
    expect(d.headline).toContain('ran out of memory');
    expect(d.explanation).toContain('buildkit-runc');
    expect(d.explanation).not.toContain('before');
  });

  test('dockerd stayed up and nothing was recorded: no memory claim', async () => {
    const d = await diagnoseLostBuildConnection(BUILD_START, deps());
    expect(d.retryable).toBe(true);
    expect(d.explanation).toContain('recorded no out-of-memory kill');
    expect(d.explanation).toContain('The cause was not recorded');
    expect(d.explanation).not.toContain('memory pressure');
  });

  test('a god-mode restart during the build is named as such', () => {
    const d = explainLostBuildConnection({
      report: ready, answers: true, events: [{ kind: 'requested', at: new Date('2026-10-10T10:00:30Z') }], oomKills: [], memory: null,
    });
    expect(d.headline).toContain('restarted from god mode');
  });

  test('a dockerd that is alive but slow is waited for, then the build is retryable', async () => {
    let polls = 0;
    const d = await diagnoseLostBuildConnection(BUILD_START, deps({
      recover: async () => parseGuestInitReport('ready=no\nreason=dockerd-not-answering\n', ''),
      dockerAnswers: async () => ++polls >= 3,
    }));
    expect(polls).toBe(3);
    expect(d.retryable).toBe(true);
  });

  test('a dockerd that never answers within the wait: not retryable, worded truthfully', async () => {
    const d = await diagnoseLostBuildConnection(BUILD_START, deps({
      recover: async () => parseGuestInitReport('ready=no\nreason=dockerd-not-answering\n', ''),
      dockerAnswers: async () => false,
    }));
    expect(d.retryable).toBe(false);
    expect(d.explanation).toContain('running in the project\'s machine but stopped answering');
    expect(d.explanation).not.toContain('could not');
  });

  test('dockerd could not be brought back: not retryable, says so', () => {
    const down = parseGuestInitReport('ready=no\nreason=dockerd-crash-loop\n', '');
    const d = explainLostBuildConnection({ report: down, answers: false, events: [], oomKills: [], memory: null });
    expect(d.retryable).toBe(false);
    expect(d.explanation).toContain('it kept stopping');
  });

  test('a lost connection is the machine\'s to fix, not the Dockerfile\'s', () => {
    const e = buildFailureEscalation(
      { step: null, output: `Container build failed with exit code 1\n\nLast output:\n${EOF_LINE}`, error: 'x' },
      { failedImage: null, defaultImage: null, adopted: false },
    );
    expect(e.to).toBe('maintainer');
  });
});

describe('the build job and a lost connection', () => {
  test('a lost connection mid-step blames no step; the failure shows the diagnosis', () => {
    const job = new ImageBuildJob('project', 't');
    const obs = job.observer();
    obs.onBuildStart?.('img', 'src');
    obs.onLine('img', '#5 [2/3] RUN make');
    obs.onLine('img', '#5 compiling');
    obs.onBuildEnd?.('img', 'connection-lost');
    job.finish('failed', "The build lost its connection to Docker in the project's machine: Docker stopped.");
    expect(job.failure?.stepId).toBeNull();
    expect(job.failure?.output).toContain('lost its connection to Docker');
    expect(job.steps[0].status).toBe('cancelled');
  });

  test('a retried build gets its own step ids; failure output is the current attempt\'s', () => {
    const job = new ImageBuildJob('project', 't');
    const obs = job.observer();
    obs.onBuildStart?.('img', 'src');
    obs.onLine('img', '#5 [2/3] RUN make');
    obs.onLine('img', '#5 first attempt line');
    obs.onBuildEnd?.('img', 'connection-lost');
    obs.onBuildStart?.('img', 'src');
    obs.onLine('img', '#5 [2/3] RUN make');
    obs.onLine('img', '#5 second attempt line');
    obs.onLine('img', '#5 ERROR: boom');
    obs.onBuildEnd?.('img', 'failed');
    job.finish('failed', 'x');
    expect(job.steps.map(s => s.id)).toEqual(['docker:img:#5', 'docker:img:#5@2']);
    expect(job.failure?.stepId).toBe('docker:img:#5@2');
    expect(job.failure?.output).toContain('second attempt line');
    expect(job.failure?.output).not.toContain('first attempt line');
  });
});

describe('the build runner retries once on the microVM backend', () => {
  let dir: string;

  async function fake(name: string, body: string): Promise<void> {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`);
    await chmod(p, 0o755);
  }

  /** A docker whose `build` loses the connection the first `failures` times. */
  async function setup(failures: number): Promise<void> {
    await fake('docker', `
case "$1" in
  info) exit 0 ;;
  build)
    n=$(cat "${dir}/builds" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"${dir}/builds"
    echo "#1 [internal] load build definition from Dockerfile" >&2
    if [ $n -le ${failures} ]; then echo "${EOF_LINE}" >&2; exit 1; fi
    echo "#2 DONE 0.1s" >&2; exit 0 ;;
  *) exit 0 ;;
esac`);
    await fake('lazy-guest-init', `echo "--ensure" >>"${dir}/ensures"; echo ready=yes; echo source=running-dockerd`);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'build-connection-lost-'));
    await writeFile(join(dir, 'Dockerfile'), 'FROM debian:bookworm\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Build in a child with the fakes first on PATH (bun's spawn reads PATH from the process's start). */
  function runBuild(backend = 'microvm'): { out: string; err: string } {
    const script = `
      import { buildDockerfileCandidate } from '${join(import.meta.dir, '../../src/capture/claude')}';
      try {
        await buildDockerfileCandidate('${dir}', {
          dockerfilePath: '${join(dir, 'Dockerfile')}', contextDir: '${dir}', source: 'Dockerfile',
          notify: (n) => console.log('NOTE', JSON.stringify(n)),
        });
        console.log('OK');
      } catch (e) { console.log('ERR', JSON.stringify(e.message)); }
    `;
    const r = spawnSyncUnsupervised(['bun', '-e', script], {
      env: { ...process.env, LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: backend, LAZY_MANAGED_STORAGE_PATH: join(dir, 'store'), PATH: `${dir}:${process.env.PATH}` },
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    return { out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test('one lost connection: dockerd checked, build retried once and succeeds', async () => {
    await setup(1);
    const { out, err } = runBuild();
    expect(out, err).toContain('OK');
    expect((await readFile(join(dir, 'builds'), 'utf8')).trim()).toBe('2');
    expect(await readFile(join(dir, 'ensures'), 'utf8')).toContain('--ensure');
    expect(out).toContain('retrying the build once');
  });

  test('lost twice: no third attempt, and the error leads with the cause, not "fix the Dockerfile"', async () => {
    await setup(5);
    const { out, err } = runBuild();
    expect(out, err).toContain('ERR "The build lost its connection to Docker');
    expect((await readFile(join(dir, 'builds'), 'utf8')).trim()).toBe('2');
    expect(out).toContain('It happened twice in a row (lazy retried once).');
    expect(out).not.toContain('Fix that Dockerfile');
  });

  test('off the microVM backend the same failure is not retried', async () => {
    await setup(5);
    const { out, err } = runBuild('local-docker');
    expect(out, err).toContain('ERR');
    expect((await readFile(join(dir, 'builds'), 'utf8')).trim()).toBe('1');
  });

  test('a step that genuinely fails is not retried', async () => {
    await fake('docker', `
case "$1" in
  build) n=$(cat "${dir}/builds" 2>/dev/null || echo 0); echo $((n + 1)) >"${dir}/builds"
    echo '#5 ERROR: process "/bin/sh -c false" did not complete successfully: exit code: 1' >&2; exit 1 ;;
  *) exit 0 ;;
esac`);
    await fake('lazy-guest-init', 'echo ready=yes');
    const { out, err } = runBuild();
    expect(out, err).toContain('ERR');
    expect((await readFile(join(dir, 'builds'), 'utf8')).trim()).toBe('1');
  });
});

describe('an out-of-memory lost build', () => {
  const failureFor = (history: string) => {
    const d = explainLostBuildConnection({
      report: ready, answers: true, oomKills: [], memory: null,
      events: parseDockerdHistory(history),
    });
    // Composed exactly as src/capture/claude.ts throws it.
    return { step: null, error: 'x', output: `${d.headline}\n\n${d.explanation}\n\n${EOF_LINE}` };
  };
  const opts = { failedImage: null, defaultImage: null, adopted: false };

  // INVARIANT: a build lost to dockerd running out of memory is the project admin's, with the real remedy; other lost connections stay the maintainer's.
  test('escalates to the admin with the OOM sentence and remedy', () => {
    const e = buildFailureEscalation(failureFor(
      '=== 2026-10-10T10:00:05Z dockerd (pid 40) stopped answering (cause=exited-137+oom-killer, exit_status=137)\n' +
      "--- dockerd memory at the kill: used 3145728 kB of the machine's 4194304 kB\n"), opts);
    expect(e.to).toBe('admin');
    if (e.to !== 'admin') return;
    expect(e.summary).toContain("dockerd ran out of memory (used 3.0 GiB of the machine's 4.0 GiB)");
    expect(e.howToFix).toBe(dockerdOomRemedy());
  });

  test('a non-OOM dockerd death stays the maintainer\'s', () => {
    expect(buildFailureEscalation(failureFor(
      '=== 2026-10-10T09:00:00Z dockerd (pid 12) stopped answering (cause=exited-1, exit_status=1)\n'), opts).to).toBe('maintainer');
  });
});
