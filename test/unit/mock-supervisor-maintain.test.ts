/**
 * Directly exercises the mock supervisor's maintained-files path
 * (test/mocks/claude.ts#launchSupervisorAsync) — the code the maintain e2e tests
 * run through. The start-based e2e harness needs a daemon; this drives the same
 * mock supervisor logic without one, so the maintain follow-up simulation that
 * the e2e relies on is verified here.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { launchSupervisorAsync } from '../mocks/claude';

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const MAINTAIN = [
  { title: 'docs', pattern: 'docs/**/*', instructions: 'Update affected docs.' },
  { title: 'changelog', pattern: 'CHANGELOG.md', instructions: 'Add a changelog line.' },
];

describe('mock supervisor: maintained-files follow-up', () => {
  let worktree: string;
  let protocolDir: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'lazy-mock-sup-'));
    protocolDir = mkdtempSync(join(tmpdir(), 'lazy-mock-proto-'));
    git(worktree, 'init');
    git(worktree, 'config', 'user.email', 't@t.com');
    git(worktree, 'config', 'user.name', 'T');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    writeFileSync(join(worktree, 'docs', 'api.md'), '# API\n');
    writeFileSync(join(worktree, 'CHANGELOG.md'), '# Changelog\n');
    writeFileSync(join(worktree, 'README.md'), '# R\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'init');

    setEnv({
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify({ result: 'Did the work.', session_id: 's1' }),
    });
  });

  afterEach(async () => {
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

  function runAndReadResult(): Record<string, unknown> {
    const sandbox = { worktreePath: worktree, sandboxPath: join(worktree, '.lazy-task-sandbox') };
    return launchSupervisorAsync(sandbox, 'mock-container', protocolDir).then(() =>
      JSON.parse(readFileSync(join(protocolDir, 'response.json'), 'utf-8')),
    ) as unknown as Record<string, unknown>;
  }

  interface BundleResponse {
    result?: string;
    violations?: unknown[];
    start_sha_work?: string;
    end_sha_work?: string;
    usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    supervised?: { kind: string; prompt: string };
  }
  function readBundle(resp: Record<string, unknown>): BundleResponse[] {
    return resp.responses as BundleResponse[];
  }

  // INVARIANT: the completed response is a BUNDLE — responses[0] is the clean work
  // response; the maintain nudge is a SEPARATE full response carrying its own
  // prompt, usage (incl. cache), and SHA window. Nudge text is NEVER appended to
  // the work result; the reconciler materializes the nudge as its own turn pair.
  test('emits a maintain follow-up as a separate bundle response when a group is skipped', async () => {
    writeCommand({ maintain: MAINTAIN });
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/x.ts', content: 'export const x = 1;\n' }]),
      LAZY_MOCK_MAINTAIN_RESPONSE: 'No docs/CHANGELOG update needed — intra-release.',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(2);

    // responses[0] is the clean work response — the nudge is NOT concatenated in.
    expect(bundle[0].result).not.toContain('## Maintained Files Review');
    expect(bundle[0].result).not.toContain('No docs/CHANGELOG update needed — intra-release.');
    expect(bundle[0].supervised).toBeUndefined();

    // responses[1] is the maintain follow-up — full response with its own fields.
    const maintain = bundle[1];
    expect(maintain.supervised?.kind).toBe('maintain');
    expect(maintain.supervised?.prompt).toContain('docs');
    expect(maintain.supervised?.prompt).toContain('changelog');
    expect(maintain.result).toBe('No docs/CHANGELOG update needed — intra-release.');
    // Full fidelity: cache tokens present, per-invocation SHA window present.
    expect(maintain.usage?.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(maintain.usage?.cache_read_input_tokens).toBeGreaterThan(0);
    expect(typeof maintain.start_sha_work).toBe('string');
    expect(typeof maintain.end_sha_work).toBe('string');
  });

  test('no follow-up when a maintained file was touched (work response only)', async () => {
    writeCommand({ maintain: MAINTAIN });
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([
        { path: 'src/x.ts', content: 'export const x = 1;\n' },
        { path: 'docs/new.md', content: '# New\n' },
        { path: 'CHANGELOG.md', content: '# Changelog\n- did it\n' },
      ]),
      LAZY_MOCK_MAINTAIN_RESPONSE: 'should-not-appear',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(1);
    expect(bundle[0].result).not.toContain('should-not-appear');
  });

  test('no follow-up on a no-op turn (no changes)', async () => {
    writeCommand({ maintain: MAINTAIN });
    // No LAZY_MOCK_SHOULD_COMMIT → mock makes no changes.
    setEnv({ LAZY_MOCK_MAINTAIN_RESPONSE: 'should-not-appear' });
    const resp = await runAndReadResult();
    expect(readBundle(resp)).toHaveLength(1);
  });

  // INVARIANT (maintain-nudge-violation-precedence): the maintain nudge fires AFTER
  // the push-back exchange and is INDEPENDENT of the violation outcome. It is NOT
  // gated on the final violation set being empty (lazy.toml is itself a protected
  // file, so otherwise every turn editing it would skip the nudge). It must never
  // re-trigger push-back — push-back is single-shot, so a turn produces AT MOST one
  // push-back response followed by AT MOST one maintain response, in that order.
  //
  // Branch (a): the agent RESOLVED the violations during push-back (final set empty).
  test('fires the maintain nudge after push-back even when the agent resolved violations', async () => {
    // Pre-existing protected file the agent will modify then revert under push-back.
    writeFileSync(join(worktree, 'unit.spec.ts'), 'describe("x", () => {});\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'add spec');

    writeCommand({ maintain: MAINTAIN, protected_patterns: ['*.spec.*'] });
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      // Touches a protected file (violation) AND a plain file (so a net non-maintained
      // change survives the revert → maintained groups are still "skipped").
      LAZY_MOCK_FILES: JSON.stringify([
        { path: 'unit.spec.ts', content: 'describe("modified", () => {});\n' },
        { path: 'src/x.ts', content: 'export const x = 1;\n' },
      ]),
      // Push-back reverts the protected file → final violation set is empty.
      LAZY_MOCK_PUSHBACK_REVERTS: JSON.stringify(['unit.spec.ts']),
      LAZY_MOCK_PUSHBACK_RESPONSE: 'Reverted the spec file.',
      LAZY_MOCK_MAINTAIN_RESPONSE: 'No docs/CHANGELOG update needed.',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    const pushbackIdx = bundle.findIndex(r => r.supervised?.kind === 'permission_pushback');
    const maintainIdx = bundle.findIndex(r => r.supervised?.kind === 'maintain');
    // BOTH supervised turns present, push-back BEFORE maintain.
    expect(pushbackIdx).toBeGreaterThan(0);
    expect(maintainIdx).toBeGreaterThan(pushbackIdx);
    // Agent resolved the violations: push-back response carries an empty final set.
    expect((bundle[pushbackIdx].violations ?? []).length).toBe(0);
    // Exactly one push-back (no second round) and one maintain.
    expect(bundle.filter(r => r.supervised?.kind === 'permission_pushback')).toHaveLength(1);
    expect(bundle.filter(r => r.supervised?.kind === 'maintain')).toHaveLength(1);
    expect(bundle[maintainIdx].result).toBe('No docs/CHANGELOG update needed.');
  });

  // Branch (b): the agent CONFIRMED/kept the violations (final set non-empty). The
  // maintain nudge still fires; the task still heads to `conflict` because the
  // push-back response (not the maintain response) carries the final violation set.
  test('fires the maintain nudge after push-back even when violations remain', async () => {
    writeFileSync(join(worktree, 'unit.spec.ts'), 'describe("x", () => {});\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'add spec');

    writeCommand({ maintain: MAINTAIN, protected_patterns: ['*.spec.*'] });
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([
        { path: 'unit.spec.ts', content: 'describe("modified", () => {});\n' },
        { path: 'src/x.ts', content: 'export const x = 1;\n' },
      ]),
      // No reverts → the violation stands.
      LAZY_MOCK_PUSHBACK_RESPONSE: 'Intentional — keeping the spec change.',
      LAZY_MOCK_MAINTAIN_RESPONSE: 'No docs/CHANGELOG update needed.',
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    const pushbackIdx = bundle.findIndex(r => r.supervised?.kind === 'permission_pushback');
    const maintainIdx = bundle.findIndex(r => r.supervised?.kind === 'maintain');
    expect(pushbackIdx).toBeGreaterThan(0);
    expect(maintainIdx).toBeGreaterThan(pushbackIdx);
    // Violation kept: push-back response carries the final non-empty set (→ conflict).
    expect((bundle[pushbackIdx].violations ?? []).length).toBe(1);
    // The maintain response must NOT carry violations, so the reconciler's
    // last-violation-wins lookup still reads the push-back set.
    expect(bundle[maintainIdx].violations).toBeUndefined();
    // No second push-back round.
    expect(bundle.filter(r => r.supervised?.kind === 'permission_pushback')).toHaveLength(1);
    expect(bundle.filter(r => r.supervised?.kind === 'maintain')).toHaveLength(1);
  });
});
