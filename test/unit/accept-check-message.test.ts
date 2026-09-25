import { describe, test, expect } from 'bun:test';
import {
  acceptCheckRefusalMessage,
  acceptCheckOverriddenWarning,
  acceptCheckOverrideAvailable,
  enforceAcceptCheck,
  AcceptCheckFailedError,
  ALLOW_BROKEN_FLAG,
} from '../../src/protection/accept-check';

const base = {
  displayId: 'ab12cd34',
  targetBranch: 'main',
  command: 'bun run typecheck',
  output: '--- stdout ---\nsrc/x.ts(1,1): error TS2551\n',
  elapsedMs: 6_200,
};

describe('accept check refusal wording', () => {
  test('a failing build is stated in merge terms, naming the branch it would break', () => {
    const msg = acceptCheckRefusalMessage({ ...base, exitCode: 2, timedOut: false });
    expect(msg).toContain('does not build');
    expect(msg).toContain('would break `main`');
    expect(msg).toContain('bun run typecheck');
    expect(msg).toContain('error TS2551');
    expect(msg).toContain(`lazy accept ab12cd34 ${ALLOW_BROKEN_FLAG}`);
  });

  // INVARIANT: exit 127 means the command never ran, so nothing was verified.
  // Calling that "does not compile" would send the reviewer hunting a type
  // error that does not exist — and passing it would be the very defect this
  // gate exists to prevent, so it still refuses.
  test('exit 127 is reported as "could not run", never as a build failure', () => {
    const msg = acceptCheckRefusalMessage({ ...base, exitCode: 127, timedOut: false });
    expect(msg).toContain('COULD NOT RUN');
    expect(msg).not.toContain('does not build');
    expect(msg).toContain('refused');
  });

  test('a timeout is a refusal, not a pass', () => {
    const msg = acceptCheckRefusalMessage({ ...base, exitCode: -1, timedOut: true });
    expect(msg).toContain('did not finish');
    expect(msg).toContain('not a pass');
  });

  // INVARIANT: --allow-broken is CLI-only (docs/surface-asymmetries.md §14), so
  // a refusal delivered over MCP must not hand an agent a command its surface
  // cannot run — it says the override exists and is out of reach instead.
  test('an MCP-facing refusal states the override is unavailable instead of naming the flag', () => {
    const msg = acceptCheckRefusalMessage({
      ...base, exitCode: 2, timedOut: false, overrideAvailable: false,
    });
    expect(msg).toContain('does not build');
    expect(msg).toContain('no override on this surface');
    expect(msg).toContain('human at a terminal');
    expect(msg).not.toContain(`lazy accept ab12cd34 ${ALLOW_BROKEN_FLAG}`);
  });

  test('the override is offered by default — the CLI passes no flag to ask for it', () => {
    const msg = acceptCheckRefusalMessage({ ...base, exitCode: 2, timedOut: false });
    expect(msg).toContain(`lazy accept ab12cd34 ${ALLOW_BROKEN_FLAG}`);
    expect(msg).not.toContain('no override on this surface');
  });

  test('the override warning states the failure as fact', () => {
    const warning = acceptCheckOverriddenWarning('ab12cd34', 2);
    expect(warning).toContain('FAILED');
    expect(warning).toContain(ALLOW_BROKEN_FLAG);
    expect(warning).toContain('does not build');
  });
});

describe('acceptCheckOverrideAvailable', () => {
  // The MCP boundary sets an explicit actor; a CLI accept passes none and
  // falls back to 'human'. That is the whole signal for "can this caller take
  // the escape hatch?" — no new parameter, no surface sniffing.
  test('the MCP actors cannot override; every other caller can', () => {
    expect(acceptCheckOverrideAvailable('agent')).toBe(false);
    expect(acceptCheckOverrideAvailable('builder')).toBe(false);
    expect(acceptCheckOverrideAvailable({ role: 'agent' })).toBe(false);
    expect(acceptCheckOverrideAvailable('human')).toBe(true);
    expect(acceptCheckOverrideAvailable({ role: 'human', userId: 'u1' })).toBe(true);
    expect(acceptCheckOverrideAvailable(undefined)).toBe(true);
  });
});

describe('enforceAcceptCheck', () => {
  const silent = { info: () => {}, warn: () => {} };

  // INVARIANT: lazy never invents a build command for a project that
  // configured none — the gate reports itself skipped, and accept continues.
  test('an unset command skips the gate and says why', async () => {
    const outcome = await enforceAcceptCheck({
      worktreePath: process.cwd(), command: '   ', timeoutSecs: 60,
      displayId: 'ab12cd34', targetBranch: 'main', allowBroken: false, logSink: silent,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedReason).toContain('accept_check');
  });

  test('a passing command returns ran with an elapsed cost', async () => {
    const outcome = await enforceAcceptCheck({
      worktreePath: process.cwd(), command: 'true', timeoutSecs: 60,
      displayId: 'ab12cd34', targetBranch: 'main', allowBroken: false, logSink: silent,
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.overridden).toBeUndefined();
    expect(typeof outcome.elapsedMs).toBe('number');
  });

  test('a failing command throws, and --allow-broken turns the throw into a reported override', async () => {
    const failing = {
      worktreePath: process.cwd(), command: 'echo boom >&2; exit 3', timeoutSecs: 60,
      displayId: 'ab12cd34', targetBranch: 'main', logSink: silent,
    };
    await expect(enforceAcceptCheck({ ...failing, allowBroken: false }))
      .rejects.toBeInstanceOf(AcceptCheckFailedError);

    const overridden = await enforceAcceptCheck({ ...failing, allowBroken: true });
    expect(overridden.ran).toBe(true);
    expect(overridden.overridden).toBe(true);
    expect(overridden.exitCode).toBe(3);
  });
});
