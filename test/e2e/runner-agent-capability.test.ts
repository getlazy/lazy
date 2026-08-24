/**
 * Runner/agent capability gating (cursor-first-class-agent).
 *
 * The old guard hardcoded "only claude-code may use container runners". The
 * capability now comes from each agent's packaging
 * (AgentPackaging.supportsContainerRunner), so container-capable agents
 * (cursor) pass and host-only agents (qa-agent) are still refused with the
 * same actionable error.
 *
 * Daemonless suite calling src/ in-process — needs enableInProcessTestMode()
 * (see CLAUDE.md, env-leakage rules).
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { createRunner } from '../../src/runner';

enableInProcessTestMode();

async function setAgent(root: string, agentId: string): Promise<void> {
  const configPath = join(root, 'lazy.toml');
  const toml = await readFile(configPath, 'utf-8');
  const updated = toml.replace(/agent_id = "[a-z-]+"/, `agent_id = "${agentId}"`);
  expect(updated).not.toBe(toml);
  await writeFile(configPath, updated);
}

describe('runner/agent capability gating', () => {
  let ctx: TestContext;
  let unpinConfig: () => void;

  beforeEach(async () => {
    // The init template's [runner] type is "docker" — exactly the runner the
    // capability check gates.
    ctx = await setupTestLazy();
    // In-process createRunner loads config via the cwd walk — pin it to the
    // fixture project or it silently adopts lazy's own lazy.toml (CLAUDE.md).
    unpinConfig = pinConfig(ctx.root);
  });

  afterEach(async () => {
    unpinConfig();
    await ctx.cleanup();
  });

  // INVARIANT (cursor-first-class-agent): Cursor works under container
  // runners — the guard must NOT refuse it. Container support is the
  // make-or-break requirement for first-class Cursor support.
  test('cursor + docker runner is allowed', async () => {
    await setAgent(ctx.root, 'cursor');
    const runner = await createRunner(ctx.root);
    expect(runner.type).toBe('docker');
  });

  test('claude-code + docker runner is allowed (unchanged)', async () => {
    const runner = await createRunner(ctx.root);
    expect(runner.type).toBe('docker');
  });

  // qa-agent keeps its pre-existing host-only posture.
  test('qa-agent + docker runner is refused with an actionable error', async () => {
    await setAgent(ctx.root, 'qa-agent');
    await expect(createRunner(ctx.root)).rejects.toThrow(/only supports host-process runner/);
  });
});
