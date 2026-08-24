import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join, dirname } from 'path';
import { mkdir, writeFile, readFile, chmod } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { findFullTaskId, setTaskStatus, taskFilePath, worktreePathFor } from '../helpers/storage';
import { looksLikeLazyPlaceholder, lookupCredentialGrant } from '../../src/proxy/credential-broker';

/**
 * INVARIANT (this whole file): the credential an interactive Claude Code
 * session runs on comes from the DAEMON, never from the shell the human happened
 * to type `lazy pair` / `lazy chat` in.
 *
 * The daemon is the single credential owner (credential-gate.ts) — it refuses to
 * start without one. Reading the client's own `process.env` instead asks a
 * different question and gets it wrong in the common case: in a daemon-only-env
 * setup (or simply a fresh shell after a restart) the human's shell exports
 * nothing, pair handed Claude Code no credential at all, and Claude Code fell
 * through to the host credential store — or, with nothing there either, a
 * `/login` prompt several seconds into the session while task agents kept
 * running fine on the daemon's token.
 *
 * A human who deliberately wants their own host login can still type `/login`
 * inside the session. That escape hatch is explicit; the implicit fallback was
 * the bug.
 *
 * SINCE JIT CREDENTIALS, the same invariant has a different signature on the
 * wire. The launched process no longer receives the daemon's raw token at all —
 * it receives a PLACEHOLDER the daemon minted for this launch, which the proxy
 * exchanges upstream (src/proxy/credential-broker.ts). So "it came from the
 * daemon" is no longer proved by value equality; it is proved by the value
 * resolving to a GRANT in this daemon's own registry. That is a stronger proof
 * than the old one: a value copied out of the human's shell could never resolve.
 */

/**
 * The daemon's real credential in this harness. Asserted against NEGATIVELY:
 * after JIT injection the raw token must never reach a launched process.
 */
const DAEMON_RAW_CREDENTIAL = 'sk-test-fake-key-for-testing';

/** The credential env vars the fake `claude` records, in the order it writes them. */
const RECORDED_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] as const;

/**
 * A fake `claude` on PATH that records the credential env it was launched with.
 * This process stands in for the real host Claude Code process, so whatever
 * lands here is exactly what would have been used to authenticate.
 */
async function installFakeClaude(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const envLog = join(binDir, 'claude-env');
  const lines = RECORDED_ENV.map(k => `printf '%s\\n' "${k}=\$${k}" >> '${envLog}'`).join('\n');
  const script = `#!/bin/sh
: > '${envLog}'
${lines}
exit 0
`;
  const p = join(binDir, 'claude');
  await writeFile(p, script, 'utf-8');
  await chmod(p, 0o755);
}

/** The credential env the fake `claude` saw, as a map (missing ⇒ ''). */
async function readClaudeEnv(binDir: string): Promise<Record<string, string>> {
  const raw = await readFile(join(binDir, 'claude-env'), 'utf-8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Assert the launched process received a placeholder THIS daemon minted for
 * THIS launch — the placeholder-era spelling of "the credential came from the
 * daemon, not from the invoking shell".
 *
 * Three things together make that airtight:
 *  - it is not the credential-less shell's value (which was empty),
 *  - it is not the daemon's raw token either (the whole point of JIT: the real
 *    credential never leaves the daemon process), and
 *  - it resolves in the grant registry to a BUILDER grant. Only the daemon can
 *    write that registry, so resolution is evidence of provenance rather than a
 *    shape check — `looksLikeLazyPlaceholder` alone would pass on any string a
 *    test happened to prefix correctly.
 */
async function expectDaemonMintedPlaceholder(root: string, value: string): Promise<void> {
  expect(value).not.toBe('');                      // a credential was handed over at all
  expect(value).not.toBe(DAEMON_RAW_CREDENTIAL);   // ...but not the raw one
  expect(looksLikeLazyPlaceholder(value)).toBe(true);

  const grant = await lookupCredentialGrant(root, value);
  expect(grant, `no grant registered for the placeholder handed to claude`).not.toBeNull();
  // pair and chat are interactive BUILDER sessions (see resolveInteractiveLaunch).
  expect(grant!.role).toBe('builder');
  expect(grant!.taskId).toBeNull();
  expect(grant!.label).toStartWith('host-builder:');
  // The placeholder occupies the SAME env var the real credential would have,
  // so the client picks the same auth wire shape it always did.
  expect(grant!.envKey).toBe('ANTHROPIC_API_KEY');
}

/**
 * Minimal blocked task with a worktree and a session — the state `lazy pair
 * <task>` requires. Deliberately hand-rolled rather than run through a real
 * turn: this suite is about the launch environment, not about the agent.
 */
function createSessionManually(ctx: TestContext, shortId: string): void {
  const fullTaskId = findFullTaskId(ctx.root, shortId);
  const branchName = `lazy/${shortId}`;
  const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
  const worktreePath = worktreePathFor(ctx.root, shortId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  ctx.git('worktree', 'add', worktreePath, '-b', branchName);

  writeFileSync(taskFilePath(ctx.root, shortId, 'session.json'), JSON.stringify({
    id: randomUUID(),
    task_id: fullTaskId,
    agent_id: 'claude-code',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    git_branch: branchName,
    git_start_sha: startSha,
    agent_session_id: null,
    last_interaction_at: Date.now(),
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
  }, null, 2));
  setTaskStatus(ctx.root, shortId, 'blocked');
}

describe('interactive launch credentials come from the daemon', () => {
  let ctx: TestContext;
  let binDir: string;
  /** Env for a client invocation whose shell exports NO Anthropic credential. */
  let credentiallessShell: Record<string, string>;

  beforeEach(async () => {
    // A real daemon is the point: it holds the credential the client must use.
    ctx = await setupTestLazy({ withDaemon: true });
    binDir = join(ctx.root, '.fake-bin');
    await installFakeClaude(binDir);
    credentiallessShell = {
      PATH: `${binDir}:${process.env.PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
    };
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy pair on a task passes the daemon credential to Claude Code', async () => {
    const taskId = await createTask(ctx, 'Pairing credential task', 'Some work');
    createSessionManually(ctx, taskId);

    const result = await ctx.lazy(['pair', taskId, '--no-summary'], { env: credentiallessShell });
    expectSuccess(result);

    const env = await readClaudeEnv(binDir);
    await expectDaemonMintedPlaceholder(ctx.root, env.ANTHROPIC_API_KEY);
  });

  test('branchless lazy pair passes the daemon credential to Claude Code', async () => {
    const result = await ctx.lazy(['pair'], { env: credentiallessShell });
    expectSuccess(result);

    const env = await readClaudeEnv(binDir);
    await expectDaemonMintedPlaceholder(ctx.root, env.ANTHROPIC_API_KEY);
  });
});
