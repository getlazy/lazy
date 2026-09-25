/**
 * scripts/with-deploy-key.sh — the one place the getlazy/lazy WRITE deploy key
 * touches a CI runner's disk — run for real.
 *
 * INVARIANT: the key exists only while the one command that needs it runs. It is
 * written 0600 into a temp dir that is gone once the command exits — on success
 * AND on failure — and the command does not see it in its environment. The
 * workflows used to write it to ~/.ssh/deploy_key plus a global ~/.ssh/config
 * entry in a separate step, so it stayed on disk and in effect for every step
 * after (the docs job's smoke tests included) until a trailing cleanup step.
 *
 * INVARIANT: github.com is verified against the PINNED host keys with
 * StrictHostKeyChecking=yes, and ~/.ssh/config and any agent are ignored. The
 * workflows used `ssh-keyscan github.com` + `StrictHostKeyChecking accept-new`,
 * which trusts whichever host answers first — the write key would be offered to
 * it. Checked through `ssh -G`, i.e. what ssh itself resolves, not a string grep.
 *
 * INVARIANT: the key is never printed, and a run without one refuses before
 * running the command.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const REPO = join(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'with-deploy-key.sh');
const PINNED = join(REPO, 'scripts', 'github-known-hosts');
const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nNOT-A-REAL-KEY-deadbeef\n-----END OPENSSH PRIVATE KEY-----';

// Runs inside the wrapper: records what the command can see into $OUT.
const PROBE = [
  'set -euo pipefail',
  'key="$(eval "set -- $GIT_SSH_COMMAND"; while [[ $# -gt 0 ]]; do [[ "$1" == -i ]] && { echo "$2"; break; }; shift; done)"',
  '{',
  '  echo "deploy_key_env=${DEPLOY_KEY-<unset>}"',
  '  echo "key_path=$key"',
  '  echo "key_mode=$(stat -c %a "$key" 2>/dev/null || stat -f %Lp "$key")"',
  '  echo "key_matches=$([[ "$(cat "$key")" == "$EXPECT" ]] && echo yes || echo no)"',
  '  eval "$GIT_SSH_COMMAND -G github.com" | grep -Ei "^(stricthostkeychecking|userknownhostsfile|globalknownhostsfile|identitiesonly|identityagent|identityfile) "',
  '} > "$OUT"',
  'exit "${EXIT_WITH:-0}"',
].join('\n');

describe('with-deploy-key.sh', () => {
  let dir: string;
  let runnerTemp: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'wdk-')));
    runnerTemp = join(dir, 'runner-temp');
    await Bun.write(join(runnerTemp, '.keep'), '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(env: Record<string, string>, cmd: string[] = ['bash', '-c', PROBE]) {
    const out = join(dir, 'probe.txt');
    const result = spawnSyncUnsupervised(['bash', SCRIPT, ...cmd], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', HOME: dir, RUNNER_TEMP: runnerTemp, OUT: out, EXPECT: FAKE_KEY, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), out };
  }

  async function probe(out: string): Promise<Record<string, string[]>> {
    const lines = (await readFile(out, 'utf-8')).trim().split('\n');
    const map: Record<string, string[]> = {};
    for (const line of lines) {
      const m = line.match(/^([a-z_]+)[= ](.*)$/i);
      if (!m) continue;
      const k = m[1].toLowerCase();
      (map[k] ??= []).push(m[2]);
    }
    return map;
  }

  async function leftovers(): Promise<string[]> {
    return (await readdir(runnerTemp)).filter((n) => n.startsWith('deploy-key.'));
  }

  test('key is private to the command, pinned host keys enforced, removed afterwards', async () => {
    const { code, output, out } = run({ DEPLOY_KEY: FAKE_KEY });
    expect(output).not.toContain('NOT-A-REAL-KEY');
    expect(code).toBe(0);

    const p = await probe(out);
    expect(p.deploy_key_env).toEqual(['<unset>']);
    expect(p.key_path[0].startsWith(join(runnerTemp, 'deploy-key.'))).toBe(true);
    expect(p.key_mode).toEqual(['600']);
    expect(p.key_matches).toEqual(['yes']);
    // What ssh itself resolves for github.com.
    expect(p.stricthostkeychecking).toEqual(['true']);
    expect(p.userknownhostsfile).toEqual([PINNED]);
    expect(p.globalknownhostsfile).toEqual(['/dev/null']);
    expect(p.identitiesonly).toEqual(['yes']);
    expect(p.identityagent).toEqual(['none']);
    expect(p.identityfile).toEqual([p.key_path[0]]);

    expect(await leftovers()).toEqual([]);
  });

  test('a failing command keeps its exit status and still removes the key', async () => {
    const { code, output, out } = run({ DEPLOY_KEY: FAKE_KEY, EXIT_WITH: '7' });
    expect(output).not.toContain('NOT-A-REAL-KEY');
    expect(code).toBe(7);
    expect((await probe(out)).key_matches).toEqual(['yes']);
    expect(await leftovers()).toEqual([]);
  });

  test('refuses without a key, before running the command', async () => {
    const marker = join(dir, 'ran');
    const { code, output } = run({ DEPLOY_KEY: '' }, ['bash', '-c', `touch ${marker}`]);
    expect(code).not.toBe(0);
    expect(output).toContain('PUBLIC_REPO_DEPLOY_KEY is not available');
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await leftovers()).toEqual([]);
  });
});
