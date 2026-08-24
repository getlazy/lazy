/**
 * E2E for the review page's remedial actions when an accept is REFUSED.
 *
 * The page used to answer a refusal with "Accept failed: <prose>" and nothing
 * else — the reviewer had to work out the fix themselves and go to a terminal
 * for it. Now the daemon attaches a structured remedy to the refusal and the
 * page renders it: the exact command, and where it can act itself (a protection
 * gate, a stale merge base) an in-page form that completes the job.
 *
 * These tests drive the real daemon over its web port with plain form POSTs —
 * the same requests a browser with scripting OFF sends.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon';
import { enrollPassphrase } from '../helpers/passphrase';

const PASSPHRASE = 'test-approval-passphrase';

/** Opt in to branch protection (OFF by default) and enroll the passphrase. */
async function enableProtection(ctx: TestContext): Promise<void> {
  const tomlPath = join(ctx.root, 'lazy.toml');
  const toml = await readFile(tomlPath, 'utf-8');
  const updated = toml.replace('[protection]\n', '[protection]\nenabled = true\n');
  expect(updated).not.toBe(toml);
  await writeFile(tomlPath, updated);
  await enrollPassphrase(ctx.passphraseBaseDir, PASSPHRASE);
}

describe('review page remedies for a refused accept', () => {
  let ctx: TestContext;
  let base: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    await enableProtection(ctx);
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    base = `http://localhost:${health.webPort}`;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** A blocked task with one commit, ready to be accepted into protected main. */
  async function blockedTaskWithWork(name: string): Promise<string> {
    const taskId = await createTask(ctx, `Remedy ${name}`, 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    return taskId;
  }

  function acceptForm(fields: Record<string, string>): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    };
  }

  // INVARIANT: a gated accept never dead-ends. The page shows the daemon's own
  // refusal, the exact CLI command, AND the in-page passphrase form — the "no
  // MCP approve" asymmetry is about agents, not about a human at the browser.
  test('a protection-gated accept offers the passphrase form and the CLI command', async () => {
    const taskId = await blockedTaskWithWork('gate');

    const res = await fetch(`${base}/review/${taskId}/accept`, acceptForm({ reason: 'LGTM' }));
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Accept failed:');
    expect(html).toContain('requires human approval');
    // The remedy panel, keyed by the daemon's reason slug.
    expect(html).toContain('data-rv-remedy="approval-required"');
    expect(html).toContain('name="passphrase"');
    expect(html).toContain('Approve and accept');
    expect(html).toContain(`lazy accept ${taskId}`);
    // The merge did not happen.
    expect(ctx.git('log', '--oneline', 'main').stdout).not.toContain('Remedy gate');
  }, 60000);

  // Never lose human feedback: an accept refused after the reviewer typed an
  // unblock message and a reason must hand both back, not blank the page.
  test('a refused accept preserves the reason and the unblock feedback', async () => {
    const taskId = await blockedTaskWithWork('draft');

    const res = await fetch(`${base}/review/${taskId}/accept`, acceptForm({
      reason: 'ship it please',
      feedback: 'also rename the helper before merging',
    }));
    const html = await res.text();

    expect(html).toContain('ship it please');
    expect(html).toContain('also rename the helper before merging');
    // Both are carried into the passphrase form too, so a WRONG passphrase
    // (a second failure) still cannot eat them.
    expect(html).toContain('<input type="hidden" name="feedback" value="also rename the helper before merging">');
  }, 60000);

  // A wrong passphrase is a retryable mistake, not an error to start over from:
  // the same form comes back, with the typed text intact — and the passphrase
  // itself is never echoed into the page.
  test('a wrong passphrase re-offers the form and never echoes the attempt', async () => {
    const taskId = await blockedTaskWithWork('wrong-pass');

    const res = await fetch(`${base}/review/${taskId}/accept`, acceptForm({
      reason: 'LGTM',
      feedback: 'keep this text',
      passphrase: 'not-the-passphrase',
    }));
    const html = await res.text();

    expect(html).toContain('Approval passphrase does not match');
    expect(html).toContain('data-rv-remedy="approval-invalid"');
    expect(html).toContain('name="passphrase"');
    expect(html).toContain('keep this text');
    expect(html).not.toContain('not-the-passphrase');
    expect(ctx.git('log', '--oneline', 'main').stdout).not.toContain('Remedy wrong-pass');
  }, 60000);

  // The whole point of the passphrase form: the human completes the gated merge
  // from the page, exactly as `lazy approve` + `lazy accept` does at a terminal.
  test('the correct passphrase completes the gated accept', async () => {
    const taskId = await blockedTaskWithWork('good-pass');

    const res = await fetch(`${base}/review/${taskId}/accept`, acceptForm({
      reason: 'LGTM',
      passphrase: PASSPHRASE,
    }));
    // Success redirects to the task page, same as an ungated accept.
    expect(res.status).toBe(303);
    expect(ctx.git('log', '--oneline', 'main').stdout).toContain('Remedy good-pass');
  }, 60000);
});
