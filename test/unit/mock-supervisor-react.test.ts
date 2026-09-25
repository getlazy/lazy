/**
 * Directly exercises the mock supervisor's reactive-automation path
 * (test/mocks/claude.ts#launchSupervisorAsync) — the code the react e2e tests
 * run through.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { launchSupervisorAsync } from '../mocks/claude';

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const REACT = [
  { title: 'take-UI-snapshots', pattern: 'src/ui/**/*', instructions: 'Screenshot changed screens.' },
];

describe('mock supervisor: reactive-automation follow-up', () => {
  let worktree: string;
  let protocolDir: string;
  /** Existence declares final for the turn the mock supervisor runs (the
   *  wrap-up chain fires only on a declared-final turn — final-turn design
   *  §14 slice 3). These tests drive launchSupervisorAsync directly, so the
   *  flag file is both created here and named in the env the mock reads. */
  let finalFlag: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'lazy-mock-react-'));
    protocolDir = mkdtempSync(join(tmpdir(), 'lazy-mock-react-proto-'));
    finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    git(worktree, 'init');
    git(worktree, 'config', 'user.email', 't@t.com');
    git(worktree, 'config', 'user.name', 'T');
    mkdirSync(join(worktree, 'src', 'ui'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'ui', 'page.tsx'), 'export const Page = () => null;\n');
    writeFileSync(join(worktree, 'README.md'), '# R\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'init');

    setEnv({
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({ result: 'Did the work.', session_id: 's1' }),
    });
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    const { rm } = await import('fs/promises');
    await rm(worktree, { recursive: true, force: true });
    await rm(protocolDir, { recursive: true, force: true });
  });

  function writeCommand(extra: Record<string, unknown>) {
    writeFileSync(join(protocolDir, 'command.json'), JSON.stringify({ type: 'start', task_id: 'mock', ...extra }));
  }

  /** Seed a declared-final turn for the mock: write the flag file and put its
   *  path into LAZY_MOCK_FINAL (the mock's seam, mirroring what the daemon
   *  launcher puts on the command plus what the agent declares via the marker). */
  function declareFinal() {
    writeFileSync(finalFlag, '');
    setEnv({ LAZY_MOCK_FINAL: finalFlag });
  }

  function runAndReadResult(): Promise<Record<string, unknown>> {
    const sandbox = { worktreePath: worktree, sandboxPath: join(worktree, '.lazy-task-sandbox') };
    return launchSupervisorAsync(sandbox, 'mock-container', protocolDir).then(() =>
      JSON.parse(readFileSync(join(protocolDir, 'response.json'), 'utf-8')),
    );
  }

  interface BundleResponse {
    result?: string;
    usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    supervised?: { kind: string; prompt: string };
  }

  function readBundle(resp: Record<string, unknown>): BundleResponse[] {
    return resp.responses as BundleResponse[];
  }

  // INVARIANT: Touching a react pattern fires a supervised follow-up of kind 'react'.
  test('emits a react follow-up as a separate bundle response when a pattern is matched', async () => {
    writeCommand({ react: REACT, wrap_up: { steps: ['permission_pushback', 'maintain', 'react'] } });
    declareFinal();
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([
        { path: 'src/ui/page.tsx', content: 'export const Page = () => "v2";\n' },
      ]),
      LAZY_MOCK_REACT_RESPONSE: 'Took the screenshots.',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(2);

    expect(bundle[0].result).not.toContain('## Reactive Automation');
    expect(bundle[0].result).not.toContain('Took the screenshots.');
    expect(bundle[0].supervised).toBeUndefined();

    const react = bundle[1];
    expect(react.supervised?.kind).toBe('react');
    expect(react.supervised?.prompt).toContain('take-UI-snapshots');
    expect(react.result).toBe('Took the screenshots.');
    expect(react.usage?.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(react.usage?.cache_read_input_tokens).toBeGreaterThan(0);
  });

  // INVARIANT: Untouched react patterns do not fire.
  test('no follow-up when no react pattern was touched', async () => {
    writeCommand({ react: REACT, wrap_up: { steps: ['permission_pushback', 'maintain', 'react'] } });
    declareFinal();
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/x.ts', content: 'export const x = 1;\n' }]),
      LAZY_MOCK_REACT_RESPONSE: 'should-not-appear',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(1);
    expect(bundle[0].result).not.toContain('should-not-appear');
  });

  // INVARIANT: A no-op turn never triggers reactive automations.
  test('no follow-up on a no-op turn (no changes)', async () => {
    writeCommand({ react: REACT, wrap_up: { steps: ['permission_pushback', 'maintain', 'react'] } });
    declareFinal();
    setEnv({ LAZY_MOCK_REACT_RESPONSE: 'should-not-appear' });
    const resp = await runAndReadResult();
    expect(readBundle(resp)).toHaveLength(1);
  });

  // INVARIANT: react scans startShaWork..HEAD AFTER maintain, so a file the
  // maintain follow-up commits that matches a react pattern still triggers react.
  // A regression that scanned only lastInvocationSha..HEAD before maintain, or
  // that ran react before maintain, would miss this.
  test('react fires on a path the maintain follow-up committed', async () => {
    const maintain = [
      { title: 'docs', pattern: 'docs/**/*', instructions: 'Update docs.' },
    ];
    writeCommand({ maintain, react: REACT, wrap_up: { steps: ['permission_pushback', 'maintain', 'react'] } });
    declareFinal();
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    writeFileSync(join(worktree, 'docs', 'api.md'), '# API\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'seed docs');

    setEnv({
      // Work touches neither docs nor UI — maintain skips, react would not fire on work alone.
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/feature.ts', content: 'export const f = 1;\n' }]),
      LAZY_MOCK_MAINTAIN_RESPONSE: 'Updated docs and also touched UI for the screenshot path.',
      // Maintain follow-up commits a UI file that matches the react pattern.
      LAZY_MOCK_MAINTAIN_FILES: JSON.stringify([
        { path: 'docs/api.md', content: '# API v2\n' },
        { path: 'src/ui/page.tsx', content: 'export const Page = () => "from-maintain";\n' },
      ]),
      LAZY_MOCK_REACT_RESPONSE: 'Took screenshots of the UI maintain just touched.',
    });

    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    const maintainIdx = bundle.findIndex(r => r.supervised?.kind === 'maintain');
    const reactIdx = bundle.findIndex(r => r.supervised?.kind === 'react');
    expect(maintainIdx).toBeGreaterThan(0);
    expect(reactIdx).toBeGreaterThan(maintainIdx);
    expect(bundle[reactIdx].result).toBe('Took screenshots of the UI maintain just touched.');
  });
});
