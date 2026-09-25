/**
 * Directly exercises the mock supervisor's presentation step
 * (test/mocks/claude.ts#launchSupervisorAsync) — the code the present e2e tests
 * run through. The start-based e2e harness needs a daemon; this drives the same
 * mock supervisor logic without one.
 *
 * The mock reproduces BOTH sides of the present step: the supervisor's
 * enforcement (clear the marker, check it, fail the turn when it is absent) and
 * the agent's declaration (the daemon-side echo a real lazy_report call
 * produces). LAZY_MOCK_PRESENT_SKIP=1 withholds the declaration, so the mock's
 * ErrorResponse — written INSTEAD of the completed bundle, with the post-turn
 * check skipped — is asserted here as a fidelity contract: an e2e suite
 * depending on "turn fails when no presentation was declared" must be standing
 * on a mock that actually does that.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { launchSupervisorAsync } from '../mocks/claude';
import presentRegionsTemplate from '../../src/prompts/present-regions.md' with { type: 'text' };
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('mock supervisor: presentation step', () => {
  let worktree: string;
  let protocolDir: string;
  let finalFlag: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'lazy-mock-sup-present-'));
    protocolDir = mkdtempSync(join(tmpdir(), 'lazy-mock-proto-present-'));
    finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    git(worktree, 'init');
    git(worktree, 'config', 'user.email', 't@t.com');
    git(worktree, 'config', 'user.name', 'T');
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

  function declareFinal() {
    writeFileSync(finalFlag, '');
    setEnv({ LAZY_MOCK_FINAL: finalFlag });
  }

  async function runAndReadResult(): Promise<Record<string, unknown>> {
    const sandbox = { worktreePath: worktree, sandboxPath: join(worktree, '.lazy-task-sandbox') };
    await launchSupervisorAsync(sandbox, 'mock-container', protocolDir);
    return JSON.parse(readFileSync(join(protocolDir, 'response.json'), 'utf-8')) as Record<string, unknown>;
  }

  interface BundleResponse {
    result?: string;
    supervised?: { kind: string; prompt: string };
    session_id?: string;
  }
  function readBundle(resp: Record<string, unknown>): BundleResponse[] {
    return resp.responses as BundleResponse[];
  }

  test('declared-final turn: present declares (default) and lands as a supervised response with the real prompt', async () => {
    writeCommand({ wrap_up: { steps: ['present'] } });
    declareFinal();
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    expect(bundle).toHaveLength(2);
    const present = bundle[1];

    // Prompt fidelity: the recorded prompt is the REAL template, verbatim —
    // this is what e2e asserts §6.2 content against.
    expect(present.supervised?.kind).toBe('present');
    expect(present.supervised?.prompt).toBe(presentRegionsTemplate.replace("{{provenance_hint}}", ""));

    // Present declares by default — the marker stays on the protocol dir (the
    // daemon-side echo), exactly as a real lazy_report leaves it.
    expect(existsSync(join(protocolDir, PRESENTATION_MARKER_FILE))).toBe(true);

    // Sessions advance through the wrap-up conversation; per-invocation usage present.
    expect(present.session_id).toBe('mock-sess-present');
    expect((present as Record<string, unknown>).usage).toBeDefined();
  });

  // INVARIANT: the mock simulates NO systemic step — the check was removed from
  // the wrap-up, and a mock that still produced its response would let a suite
  // stand on a step the real supervisor no longer has.
  test('a plan naming the removed systemic step simulates nothing', async () => {
    writeCommand({ wrap_up: { steps: ['systemic'] } });
    declareFinal();
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(1);
    expect(bundle[0].supervised).toBeUndefined();
  });

  // INVARIANT (§6.2 enforcement): with the declaration withheld, the turn FAILS —
  // the mock writes an ErrorResponse INSTEAD of the completed bundle (no
  // post-turn check, no responses array), with the same shape the real
  // supervisor's error path produces: error names the presentation step, phase
  // is 'work', command_id echoed, agent_had_no_effect computed from git state.
  test('LAZY_MOCK_PRESENT_SKIP=1: no declaration → ErrorResponse instead of a bundle', async () => {
    writeCommand({ wrap_up: { steps: ['present'] }, command_id: 'cid-present-1' });
    declareFinal();
    setEnv({ LAZY_MOCK_PRESENT_SKIP: '1' });
    const resp = await runAndReadResult();

    expect(resp.status).toBe('error');
    expect(resp.phase).toBe('work');
    expect(resp.command_id).toBe('cid-present-1');
    expect(String(resp.error)).toContain('Presentation step did not complete');
    expect(String(resp.error)).toContain('no presentation was declared via lazy_report');
    // The agent (mock) committed nothing and left the worktree clean.
    expect(resp.agent_had_no_effect).toBe(true);
    // No bundle: enforcement skips everything after the present step.
    expect(resp.responses).toBeUndefined();
  });

  test('enforcement error reports agent_had_no_effect=false when the turn committed work first', async () => {
    writeCommand({ wrap_up: { steps: ['present'] } });
    declareFinal();
    setEnv({
      LAZY_MOCK_PRESENT_SKIP: '1',
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([{ path: 'src/x.ts', content: 'export const x = 1;\n' }]),
    });
    const resp = await runAndReadResult();
    expect(resp.status).toBe('error');
    expect(resp.agent_had_no_effect).toBe(false);
  });

  // INVARIANT: the FINAL list is for a turn that declared. A park reads
  // `park_steps` and nothing else, so a plan with an empty (or absent) park
  // list runs no closing steps at all — no marker cleared, no responses.
  test('the final steps are inert on a turn that did not declare final', async () => {
    writeCommand({ wrap_up: { steps: ['present'], park_steps: [] } });
    // No declareFinal() — the park list is empty, so the chain is skipped.
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);
    expect(bundle).toHaveLength(1);
    expect(bundle[0].supervised).toBeUndefined();
    // The supervisor side never ran, so no marker was even cleared/written.
    expect(existsSync(join(protocolDir, PRESENTATION_MARKER_FILE))).toBe(false);
  });

  // INVARIANT (this task): the presentation runs on EVERY human-facing park,
  // not only on a final — it is what the human decides from, and they decide
  // most often about a task that parked for a decision. The rest of the chain
  // (here, the protected-file exchange) stays pencils-down work and does NOT
  // run, even though this turn produced a violation it would have caught.
  test('a park runs the park steps only: present yes, permission_pushback no', async () => {
    writeCommand({
      protected_patterns: ['README.md'],
      wrap_up: { steps: ['permission_pushback', 'present'], park_steps: ['present'] },
    });
    setEnv({
      LAZY_MOCK_SHOULD_COMMIT: '1',
      LAZY_MOCK_FILES: JSON.stringify([{ path: 'README.md', content: '# touched\n' }]),
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    expect(bundle).toHaveLength(2);
    expect(bundle[1].supervised?.kind).toBe('present');
    expect(bundle.some((r) => r.supervised?.kind === 'permission_pushback')).toBe(false);
    // No final claim rode home — the turn parked.
    expect((bundle[0] as Record<string, unknown>).final).toBeUndefined();
  });

  // INVARIANT (this task): the §6.2 enforcement is FINAL-ONLY. Failing a park
  // for a missing walkthrough would turn "the agent stopped" into "the turn
  // errored" and cost the human the agent's own account of where it got to.
  test('a park with no declaration does NOT fail the turn', async () => {
    writeCommand({ wrap_up: { steps: ['present'], park_steps: ['present'] } });
    setEnv({ LAZY_MOCK_PRESENT_SKIP: '1' });
    const resp = await runAndReadResult();

    expect(resp.status).toBe('completed');
    expect(readBundle(resp)).toHaveLength(2);
  });

  // INVARIANT (this task): the walkthrough is re-authored only when HEAD has
  // moved past the one on record. This is what makes presenting on every park
  // affordable rather than a model turn per park.
  test('presented_sha at the current head skips the step entirely', async () => {
    const head = git(worktree, 'rev-parse', 'HEAD');
    writeCommand({
      wrap_up: { steps: ['present'], park_steps: ['present'], presented_sha: head },
    });
    const resp = await runAndReadResult();
    const bundle = readBundle(resp);

    expect(bundle).toHaveLength(1);
    expect(existsSync(join(protocolDir, PRESENTATION_MARKER_FILE))).toBe(false);
  });
});