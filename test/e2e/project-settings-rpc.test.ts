/**
 * The project settings overlay, over the wire (docs/design/lazy-teams.md §11).
 *
 * The overlay exists because a settings page in a browser must NOT edit
 * lazy.toml — that would put a checkbox on the default branch of the user's
 * repository. So the repository keeps stating the default and the store records
 * the deployment's override. Every test here talks to the daemon directly over
 * its TCP port, because that is the surface Rails uses and the only one whose
 * contract matters.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

const TOKEN = 'test-token-project-settings';
/** Distinct from the init template's own default, so "the repository said this" is provable. */
const REPO_MODEL = 'claude-sonnet-4-6';
const REPO_AGENT = 'claude-code';

isolateInProcessDaemonEnv();

describe('project settings overlay over RPC', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();

    // Give lazy.toml a known [models] default so "the repository value" is a
    // value this test chose, not whatever the template happens to ship.
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    const after = before.replace(/^default = ".*"$/m, `default = "${REPO_MODEL}"`);
    expect(after).not.toBe(before);
    await writeFile(tomlPath, after);

    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  test('reads the repository default when nothing has been overridden', async () => {
    const { status, body } = await rpc('getProjectSettings');
    expect(status).toBe(200);
    expect(body.defaultAgent.value).toBe(REPO_AGENT);
    expect(body.defaultAgent.repositoryValue).toBe(REPO_AGENT);
    expect(body.defaultAgent.source).toBe('repository');
    expect(body.defaultAgent.editable).toBe(true);
    expect(body.defaultModel.value).toBe(REPO_MODEL);
    expect(body.defaultModel.repositoryValue).toBe(REPO_MODEL);
    expect(body.defaultModel.source).toBe('repository');
    expect(body.defaultModel.editable).toBe(true);
  });

  test('a write takes effect and reports the repository value alongside it', async () => {
    const written = await rpc('setProjectSettings', { defaultModel: 'claude-haiku-4-5-20251001' });
    expect(written.status).toBe(200);
    expect(written.body.defaultModel.value).toBe('claude-haiku-4-5-20251001');
    expect(written.body.defaultModel.source).toBe('project-setting');

    const read = await rpc('getProjectSettings');
    expect(read.body.defaultModel.value).toBe('claude-haiku-4-5-20251001');
    // Design §11.2 rule 2: the repository value stays visible so a user can see
    // that their lazy.toml is being overridden rather than ignored.
    expect(read.body.defaultModel.repositoryValue).toBe(REPO_MODEL);
  });

  // INVARIANT: the overlay NEVER writes lazy.toml. This is the whole reason the
  // overlay exists rather than option (a) in design §11.2 — if a settings write
  // ever starts editing the file, a browser click becomes a commit on the
  // user's default branch.
  test('a write does not touch lazy.toml', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    await rpc('setProjectSettings', { defaultModel: 'sonnet' });
    expect(await readFile(tomlPath, 'utf-8')).toBe(before);
  });

  // INVARIANT: whole-record replace. Omitting the key is how a caller says
  // "clear the override, go back to what the repository says" — a patch API
  // could not express it, and a settings form needs to.
  test('omitting the key clears the override back to the repository default', async () => {
    await rpc('setProjectSettings', { defaultModel: 'sonnet' });
    expect((await rpc('getProjectSettings')).body.defaultModel.source).toBe('project-setting');

    const cleared = await rpc('setProjectSettings', {});
    expect(cleared.body.defaultModel.value).toBe(REPO_MODEL);
    expect(cleared.body.defaultModel.source).toBe('repository');
  });

  test('an empty string clears the override too', async () => {
    await rpc('setProjectSettings', { defaultModel: 'sonnet' });
    const cleared = await rpc('setProjectSettings', { defaultModel: '  ' });
    expect(cleared.body.defaultModel.source).toBe('repository');
  });

  // This is an external surface and confirms its own inputs rather than
  // assuming a friendlier one already did.
  test('refuses a malformed model id, loudly', async () => {
    const { status, body } = await rpc('setProjectSettings', { defaultModel: 'bad model; rm -rf /' });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('Invalid defaultModel');

    // And the refusal changed nothing.
    expect((await rpc('getProjectSettings')).body.defaultModel.source).toBe('repository');
  });

  test('refuses a non-string model id', async () => {
    const { status } = await rpc('setProjectSettings', { defaultModel: 42 });
    expect(status).toBe(400);
  });

  test('a defaultAgent write takes effect and reports the repository value alongside it', async () => {
    const written = await rpc('setProjectSettings', { defaultAgent: 'cursor' });
    expect(written.status).toBe(200);
    expect(written.body.defaultAgent.value).toBe('cursor');
    expect(written.body.defaultAgent.source).toBe('project-setting');
    expect(written.body.defaultAgent.repositoryValue).toBe(REPO_AGENT);

    const read = await rpc('getProjectSettings');
    expect(read.body.defaultAgent.value).toBe('cursor');
  });

  test('refuses an unknown defaultAgent, naming it and the alternatives', async () => {
    const { status, body } = await rpc('setProjectSettings', { defaultAgent: 'not-an-agent' });
    expect(status).toBe(400);
    // The message is `agentProfileOrThrow`'s, which every selection surface
    // shares so an unknown name fails the same way everywhere: it names the
    // value, where it came from, and the profiles that DO exist. This assertion
    // used to look for "Invalid defaultAgent", the wording this handler had
    // before `agent-profiles` routed it through that resolver.
    const message = JSON.stringify(body);
    expect(message).toContain('not-an-agent');
    expect(message).toContain('defaultAgent');
    expect(message).toContain('Available profiles');
  });

  test('reports runner type and effort as display-only', async () => {
    const { body } = await rpc('getProjectSettings');
    expect(body.runnerType.editable).toBe(false);
    expect(body.agentEffort.editable).toBe(false);
    expect(typeof body.runnerType.value).toBe('string');
    expect(typeof body.agentEffort.value).toBe('string');
  });

  // INVARIANT: the defaultAgent overlay applies at task creation when the
  // caller omits agentId — not only when Rails pre-fills the form.
  test('storage createTask without agentId uses the project defaultAgent overlay', async () => {
    await rpc('setProjectSettings', { defaultAgent: 'cursor' });

    const created = await rpc('storage', {
      method: 'createTask',
      args: { goal: 'Overlay default agent' },
    });
    expect(created.status).toBe(200);
    expect(created.body.agent_id).toBe('cursor');
  });
});
