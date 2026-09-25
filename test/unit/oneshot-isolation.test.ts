/**
 * Unit tests: how a machine one-shot is ISOLATED, and how long it may run for.
 *
 * THE BUG THIS ENCODES
 * --------------------
 * One-shots used to be a bare host `claude -p` spawned with no cwd, so they
 * inherited the caller's. For accept's merge-description run that caller is the
 * daemon, whose cwd is the project root checked out on the TARGET branch — so an
 * agent that wrote a file and committed it landed a commit on `main` mid-accept
 * and manufactured a conflict with the branch being merged ("Session branch has
 * conflicts with main", with nothing wrong on the task branch).
 *
 * The run was also unbounded, which is the second half of the same seam: a
 * wedged model call left the task stuck in `merging` with an orphaned `claude`
 * process, and hung three accept-path e2e suites at 30s.
 *
 * One-shots are a Runner concern now (docs/oneshot-execution.md), so the
 * isolation is structural rather than advisory and these tests pin it at three
 * levels:
 *
 *  - the argv contract  — write tools are disallowed on EVERY one-shot;
 *  - the container      — no repo mount unless asked for, and `:ro` when it is;
 *  - the host runner    — a cwd outside every git tree.
 *
 * The timeout contract is asserted against a REAL spawn of a stub `claude`,
 * because the property that matters is the child process's own fate.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, chmod, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOneshotBaseDir, oneshotCwd, ensureOneshotCwd } from '../../src/oneshot/state-dir';
import {
  buildOneshotArgs,
  buildOneshotAgentArgv,
  resolveOneshotTimeoutMs,
  DEFAULT_ONESHOT_TIMEOUT_MS,
} from '../../src/oneshot/args';
import type { OneshotRequest } from '../../src/oneshot/types';
import { spawn } from '../../src/utils/spawn';

describe('oneshot cwd resolution', () => {
  let base: string;
  let prevBase: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'lazy-oneshot-base-'));
    prevBase = process.env.LAZY_ONESHOT_BASE_DIR;
    process.env.LAZY_ONESHOT_BASE_DIR = base;
  });

  afterEach(async () => {
    if (prevBase === undefined) delete process.env.LAZY_ONESHOT_BASE_DIR;
    else process.env.LAZY_ONESHOT_BASE_DIR = prevBase;
    await rm(base, { recursive: true, force: true });
  });

  test('LAZY_ONESHOT_BASE_DIR overrides the default location', () => {
    expect(getOneshotBaseDir()).toBe(base);
    delete process.env.LAZY_ONESHOT_BASE_DIR;
    // Default is under the home dir, never under a repository.
    expect(getOneshotBaseDir()).toContain(join('.lazy', 'oneshot'));
  });

  // INVARIANT: the whole point of this directory is that it is not inside the
  // project. A cwd under the working tree (`.lazy/tmp`, say) is still inside the
  // repo, so `git commit -am` from it lands on the target branch again.
  test('the cwd is never inside the project root', () => {
    const root = join(tmpdir(), 'some-project');
    expect(oneshotCwd(root).startsWith(root)).toBe(false);
  });

  // Stable per project: Claude Code derives its session directory from the cwd,
  // so a unique path per run would leave one ~/.claude/projects entry per accept.
  test('is stable per project and distinct across projects', () => {
    const a = join(tmpdir(), 'project-a');
    const b = join(tmpdir(), 'project-b');
    expect(oneshotCwd(a)).toBe(oneshotCwd(a));
    expect(oneshotCwd(a)).not.toBe(oneshotCwd(b));
    expect(oneshotCwd(undefined)).toBe(join(base, 'default'));
  });

  test('ensureOneshotCwd creates the directory', async () => {
    const dir = await ensureOneshotCwd(join(tmpdir(), 'project-c'));
    expect((await stat(dir)).isDirectory()).toBe(true);
    // Idempotent — this runs on every accept.
    expect(await ensureOneshotCwd(join(tmpdir(), 'project-c'))).toBe(dir);
  });
});

describe('one-shot argv contract', () => {
  // INVARIANT: write tools are disallowed on EVERY one-shot, with no per-call
  // opt-in. The old `readOnly: true` flag meant a caller that forgot it got an
  // agent holding Bash/Write/Edit — `lazy report` and memory compaction both
  // did. There is deliberately no flag to forget any more.
  test('write tools are disallowed unconditionally', () => {
    for (const args of [buildOneshotArgs('summarize', 'some-model'), buildOneshotArgs('summarize', 'some-model')]) {
      const disallowed = args[args.indexOf('--disallowedTools') + 1];
      expect(disallowed).toContain('Bash');
      expect(disallowed).toContain('Write');
      expect(disallowed).toContain('Edit');
    }
  });

  // A one-shot never runs interactively, so nothing can approve a permission
  // prompt — but skipping permissions wholesale is the opposite fix, and would
  // hand back exactly the tools the line above takes away.
  test('permissions are not skipped', () => {
    expect(buildOneshotArgs('summarize', 'some-model')).not.toContain('--dangerously-skip-permissions');
  });

  test('buildOneshotAgentArgv uses the configured agent binary', () => {
    const claude = buildOneshotAgentArgv('claude-code', 'summarize', 'some-model');
    expect(claude[0]).toBe('claude');
    expect(claude).toContain('--output-format');
    expect(claude[claude.indexOf('--output-format') + 1]).toBe('json');

    // INVARIANT: Cursor's read-only one-shot is a tool DENYLIST, never
    // `--mode plan`. Cursor's native plan mode refuses MCP tool calls outright
    // ("MCP tool is blocked in this review mode"), which would break every
    // one-shot that talks to lazy — so `--exclude-tools` names the write
    // `ToolCall` oneofs instead, mirroring Claude Code's `--disallowedTools`.
    // See src/agent/cursor.ts (EXCLUDED_TOOLS_IN_PLAN_MODE).
    const cursor = buildOneshotAgentArgv('cursor', 'summarize', 'some-model');
    expect(cursor[0]).toBe('cursor-agent');
    expect(cursor).not.toContain('--mode');
    expect(cursor).toContain('--exclude-tools');
    const excluded = cursor[cursor.indexOf('--exclude-tools') + 1];
    expect(excluded).toContain('shellToolCall');
    expect(excluded).toContain('editToolCall');
    expect(excluded).toContain('deleteToolCall');
    expect(excluded).toContain('writeShellStdinToolCall');
  });
});

describe('one-shot process contract', () => {
  let dir: string;

  /**
   * Run `execBoundedOneshot` in a CHILD bun process against a stub `claude`.
   *
   * A subprocess rather than a direct call because the stub has to be found on
   * PATH: `spawn()` inherits the real process environment, and mutating
   * `process.env.PATH` in-process does NOT change what Bun's binary lookup
   * resolves — the real `claude` gets run instead, which is how this test first
   * "failed" against a perfectly good stub. Handing PATH to a child is the only
   * form that holds.
   *
   * `body` is the stub's JS, so a test scripts the agent directly (print its own
   * cwd, or hang). This drives the shared bounded executor both runners use, so
   * the timeout contract is pinned once for the container and host paths alike.
   */
  async function runOneshotWithStub(
    body: string,
    opts: { cwd?: string; timeoutMs?: number; harness?: string; binary?: string },
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    const binName = opts.binary ?? 'claude';
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, binName);
    await writeFile(binPath, `#!${process.execPath}\n${body}\n`);
    await chmod(binPath, 0o755);

    const execModule = join(import.meta.dir, '..', '..', 'src', 'oneshot', 'exec.ts');
    const argsModule = join(import.meta.dir, '..', '..', 'src', 'oneshot', 'args.ts');
    const harness = opts.harness ?? 'claude-code';
    const driver = join(dir, 'driver.ts');
    await writeFile(
      driver,
      `const { execBoundedOneshot } = await import(${JSON.stringify(execModule)});\n` +
        `const { buildOneshotAgentArgv, resolveOneshotTimeoutMs } = await import(${JSON.stringify(argsModule)});\n` +
        `const opts = JSON.parse(process.argv[2]);\n` +
        `try {\n` +
        `  const r = await execBoundedOneshot(buildOneshotAgentArgv(opts.harness, 'hello', 'some-model'), {\n` +
        `    cwd: opts.cwd,\n` +
        `    timeoutMs: resolveOneshotTimeoutMs(opts),\n` +
        `    harness: opts.harness,\n` +
        `  });\n` +
        `  console.log(JSON.stringify({ ok: true, result: r.result }));\n` +
        `} catch (err) {\n` +
        `  console.log(JSON.stringify({ ok: false, error: err.message }));\n` +
        `}\n`,
    );

    const proc = spawn([process.execPath, 'run', driver, JSON.stringify({ ...opts, harness })], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`one-shot driver failed (${exitCode}): ${stderr || stdout}`);
    }
    return JSON.parse(stdout.trim().split('\n').pop()!);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-oneshot-proc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: the requested cwd is where the agent process actually lands.
  // Asserted from the CHILD's own process.cwd(), because "we passed a cwd" is
  // not the property that matters — "the agent was not standing in the repo" is.
  test('runs the agent in the requested cwd', async () => {
    const runDir = join(dir, 'scratch');
    await mkdir(runDir, { recursive: true });

    const out = await runOneshotWithStub(
      `process.stdout.write(JSON.stringify({ type: 'result', result: process.cwd(), session_id: 'stub-s1' }));`,
      { cwd: runDir },
    );
    expect(out.ok).toBe(true);
    // Basename compare: on macOS /tmp is a symlink to /private/tmp, so the
    // child's realpath'd cwd is not string-equal to the path passed in.
    expect(out.result?.endsWith('scratch')).toBe(true);
  });

  // INVARIANT: a one-shot inside an accept is bounded. Unbounded, a wedged model
  // call leaves the task in `merging` until someone kills the daemon — and leaves
  // an orphaned `claude` behind.
  test('kills and reports a run that exceeds timeoutMs', async () => {
    const out = await runOneshotWithStub(`setTimeout(() => {}, 60000);`, {
      cwd: dir,
      timeoutMs: 300,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timed out after 300ms/);
  });

  test('a run that finishes inside the timeout is unaffected', async () => {
    const out = await runOneshotWithStub(
      `process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', session_id: 'stub-s2' }));`,
      { cwd: dir, timeoutMs: 30000 },
    );
    expect(out).toEqual({ ok: true, result: 'ok' });
  });

  // The opt-out still works — a caller that genuinely wants no ceiling gets none.
  // Asserted on a run that COMPLETES: proving the absence of a ten-minute timer
  // by waiting is not a test anyone can run, which is exactly why the polarity is
  // pinned by resolveOneshotTimeoutMs below instead.
  test('timeoutMs: 0 opts out and still returns a normal result', async () => {
    const out = await runOneshotWithStub(
      `process.stdout.write(JSON.stringify({ type: 'result', result: 'unbounded', session_id: 'stub-s3' }));`,
      { cwd: dir, timeoutMs: 0 },
    );
    expect(out).toEqual({ ok: true, result: 'unbounded' });
  });

  // INVARIANT: Cursor one-shots use the agent's alias-tolerant parseResponse, not
  // raw JSON.parse — a success blob whose answer key is `text` must not come back empty.
  test('cursor-shaped stdout with a text alias is parsed through parseResponse', async () => {
    const out = await runOneshotWithStub(
      `process.stdout.write(JSON.stringify({ text: 'cursor answer', session_id: 'sess-c1' }));`,
      { cwd: dir, harness: 'cursor', binary: 'cursor-agent' },
    );
    expect(out).toEqual({ ok: true, result: 'cursor answer' });
  });
});

describe('one-shot timeout polarity', () => {
  // INVARIANT: bounded is the DEFAULT and unbounded is the explicit opt-out —
  // not the other way round. An unbounded default only looks safe: the same
  // wedge that stuck an accept in `merging` hangs a human's terminal with no
  // output forever, and "the human can Ctrl-C" is a person noticing, not a
  // bound. Flipping this back re-opens both.
  test('a caller that names no timeout is bounded by the default', () => {
    expect(resolveOneshotTimeoutMs()).toBe(DEFAULT_ONESHOT_TIMEOUT_MS);
    expect(resolveOneshotTimeoutMs({})).toBe(DEFAULT_ONESHOT_TIMEOUT_MS);
    // A full request that names no timeout is bounded too.
    const req: OneshotRequest = { prompt: 'x', effort: 'low', repoAccess: 'read-only' };
    expect(resolveOneshotTimeoutMs(req)).toBe(DEFAULT_ONESHOT_TIMEOUT_MS);
    expect(DEFAULT_ONESHOT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('an explicit timeout wins, and 0 means unbounded', () => {
    expect(resolveOneshotTimeoutMs({ timeoutMs: 1234 })).toBe(1234);
    expect(resolveOneshotTimeoutMs({ timeoutMs: 0 })).toBe(0);
    // A negative value is nonsense, not "very short" — treat it as the opt-out
    // rather than killing the run instantly.
    expect(resolveOneshotTimeoutMs({ timeoutMs: -1 })).toBe(0);
  });

  // INVARIANT: no production caller opts out. The default only bounds "every
  // machine one-shot" for as long as that stays true, and a `timeoutMs: 0` added
  // for convenience is precisely how the unbounded state came back last time.
  // A genuine opt-out (a one-shot that long-runs by design) is a deliberate
  // change — update this test and say why in the same commit.
  //
  // The same scan doubles as the ONE-PATH check: every call site reaches
  // one-shots through the `src/oneshot` dispatcher, so a future caller that
  // spawns `claude -p` itself shows up as a missing entry here rather than as an
  // unaudited run in production.
  test('no production call site opts out of the bound', async () => {
    const { readFile, readdir } = await import('fs/promises');
    const srcRoot = join(import.meta.dir, '..', '..', 'src');

    async function tsFiles(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await tsFiles(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }

    const callers: string[] = [];
    for (const file of await tsFiles(srcRoot)) {
      // The one-shot implementation itself, not a call site.
      if (file.includes(join('src', 'oneshot'))) continue;
      if (file.endsWith(join('runner', 'docker-runner.ts'))) continue;
      if (file.endsWith(join('runner', 'host-process-runner.ts'))) continue;
      const src = await readFile(file, 'utf-8');
      if (!/\brunOneshot\(/.test(src)) continue;
      callers.push(file);
      expect(`${file}: ${src.match(/timeoutMs:\s*0\b/)?.[0] ?? 'bounded'}`).toBe(`${file}: bounded`);
    }

    // Sanity: a scan that found nothing proves nothing. The four known one-shot
    // callers are report, ask, memory compaction and the fidelity summarizer —
    // plus the daemon RPC handler that runs them.
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  // INVARIANT: ONE PATH. A machine one-shot is identified by the marker stamped
  // into its prompt, and `src/oneshot/args.ts` is the only place that stamps it
  // — so a new caller building its own one-shot argv shows up here rather than
  // as an unaudited `claude -p` in production. That was the defect this refactor
  // fixed: four call sites each authenticating off whatever happened to be in
  // the ambient environment, none of them going through the audit proxy.
  //
  // `lazy pair` is the one documented exception: its wrap-up summary is a real
  // TURN (runClaude), marked only so conversation capture skips it.
  test('only the one-shot argv builder stamps the machine-oneshot marker', async () => {
    const { readFile, readdir } = await import('fs/promises');
    const srcRoot = join(import.meta.dir, '..', '..', 'src');

    async function tsFiles(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await tsFiles(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }

    const stampers: string[] = [];
    for (const file of await tsFiles(srcRoot)) {
      const src = await readFile(file, 'utf-8');
      if (/markMachineOneshotPrompt\(/.test(src)) stampers.push(file.slice(srcRoot.length + 1));
    }
    expect(stampers.sort()).toEqual([
      join('cli', 'commands', 'pair.ts'),       // a turn, not a one-shot (see above)
      join('import', 'machine-oneshot.ts'),     // the definition
      join('oneshot', 'args.ts'),               // the one-shot argv builder
    ]);
  });
});
