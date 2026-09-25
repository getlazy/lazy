/**
 * The dashboard's region surfaces, end to end — against a PRESENTATION
 * source. What a human surface shows are the walkthrough groups the agent
 * declared in its final-turn report (`lazy_report` with a `presentation`),
 * never a carve guessed from git (§6.3: the carve's area axis and superseded
 * fold left every human surface; they survive only as the agent's own
 * `lazy_regions` provenance read, which the MCP e2e covers).
 *
 * Two honest answers exist for "where are the regions": the walkthrough's
 * groups when the agent filed one, and — when it did not — the empty card
 * that says so in plain words. What is NEVER served is a page that pays for
 * a git walk before showing the diff, or that mistakes "not declared yet"
 * for "no such region".
 *
 * The one carve-driven reading aid that survives on the page is the
 * subtask-blame gutter (line attribution by which subtask wrote each run):
 * it is computed in the background on first open and appears on a reload,
 * which is why the gutter test polls the way a reader's reload does.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { signInToDashboard } from '../helpers/dashboard-session';
import { screenshotDashboardPage } from '../helpers/page-screenshot';
import { findChromeBinary } from '../../src/utils/chrome';
import { runMcpSession } from '../helpers/mcp-session';

/**
 * A started, blocked task whose branch carries three files, two of which the
 * agent's walkthrough claims — `alpha.txt` under a core group, `notes.md`
 * under a docs one — leaving `extra.txt` for the residual group. The declared
 * order (core, docs) deliberately disagrees with display order (docs above
 * core); the review page is the surface where that display order is the
 * point, so the card test can lock it.
 */
async function presentedTask(
  ctx: TestContext,
  /**
   * Claim only `alpha.txt`, leaving BOTH other files unnamed — the shape the
   * residual-count tests need, where one leftover is a maintained path and
   * one is not.
   */
  opts: { claimAlphaOnly?: boolean } = {},
): Promise<{ taskId: string; worktree: string }> {
  const taskId = await createTask(ctx, 'Regions on the web', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktree, 'alpha.txt'), 'alpha one\nalpha two\n');
  writeFileSync(join(worktree, 'notes.md'), 'docs one\n');
  writeFileSync(join(worktree, 'extra.txt'), 'extra one\n');
  expect(ctx.git('-C', worktree, 'add', 'alpha.txt', 'notes.md', 'extra.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add alpha, notes, extra').exitCode).toBe(0);

  await runMcpSession(ctx.root, taskId, worktree, [
    {
      method: 'initialize',
      id: 1,
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    },
    {
      method: 'tools/call',
      id: 2,
      params: {
        name: 'lazy_report',
        arguments: {
          sections: [{ kind: 'what_was_done', body: 'Shipped the regions web fixture' }],
          presentation: {
            groups: opts.claimAlphaOnly
              ? [{ title: 'Alpha work', tier: 'core', items: [{ kind: 'file', file: 'alpha.txt' }] }]
              : [
                  { title: 'Alpha work', tier: 'core', items: [{ kind: 'file', file: 'alpha.txt' }] },
                  { title: 'Docs pages', tier: 'docs', items: [{ kind: 'file', file: 'notes.md' }] },
                ],
          },
        },
      },
    },
  ]);

  return { taskId, worktree };
}

/**
 * The same shape, but the walkthrough claims its test mass with ONE glob
 * item — the case a release-sized branch depends on. Three changed files,
 * two matched by the glob, one left for the residual.
 */
async function globPresentedTask(
  ctx: TestContext,
  opts: { hitCap?: boolean } = {},
): Promise<{ taskId: string; worktree: string }> {
  const taskId = await createTask(ctx, 'Regions by glob', 'Some work');
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  mkdirSync(join(worktree, 'test', 'e2e'), { recursive: true });
  writeFileSync(join(worktree, 'test', 'e2e', 'regions-web.test.ts'), 'test web one\n');
  writeFileSync(join(worktree, 'test', 'e2e', 'regions-cli.test.ts'), 'test cli one\n');
  writeFileSync(join(worktree, 'leftover.txt'), 'leftover one\n');
  expect(ctx.git('-C', worktree, 'add', '-A').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add region tests and a leftover').exitCode).toBe(0);

  await runMcpSession(ctx.root, taskId, worktree, [
    { method: 'initialize', id: 1, params: {} },
    // A walkthrough that does NOT fit, when asked for: refused, and the cap
    // recorded — so the walkthrough that follows is one a reviewer can see was
    // shaped by a cap rather than by choice.
    ...(opts.hitCap
      ? [{
          method: 'tools/call',
          id: 9,
          params: {
            name: 'lazy_report',
            arguments: {
              sections: [{ kind: 'what_was_done', body: 'Too many groups to file' }],
              presentation: {
                groups: Array.from({ length: 33 }, (_, i) => ({
                  title: `Group ${i}`,
                  tier: 'core',
                  items: [{ kind: 'prose', body: `Story ${i}` }],
                })),
              },
            },
          },
        }]
      : []),
    {
      method: 'tools/call',
      id: 2,
      params: {
        name: 'lazy_report',
        arguments: {
          sections: [{ kind: 'what_was_done', body: 'Claimed the test mass by glob' }],
          presentation: {
            groups: [
              {
                title: 'Region tests',
                tier: 'tests',
                items: [{ kind: 'file', file: 'test/e2e/regions*.test.ts', note: 'the suites' }],
              },
            ],
          },
        },
      },
    },
  ]);

  return { taskId, worktree };
}

/** A started, blocked task whose agent filed no walkthrough at all. */
async function unpresentedTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'Unpresented web', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktree, 'alpha.txt'), 'alpha one\n');
  expect(ctx.git('-C', worktree, 'add', 'alpha.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add alpha only').exitCode).toBe(0);
  return taskId;
}

/**
 * A branch whose commits several SUBTASKS wrote, so the gutter's per-line
 * attribution has something true to say: one unit whose every line a later
 * one rewrites (it owns nothing in the final tree, which the carve marks —
 * and the gutter never showed anyway), and two units whose lines both
 * survive in one shared file. No walkthrough is filed on purpose: the gutter
 * is the one reading aid still computed from the commit graph, in the
 * background, so the test reloads until it is in.
 */
async function gutterTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'Hub regions on the web', 'Do work');
  await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  await ctx.lazy(['show', taskId]);

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: worktree });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
  };
  git('config', 'user.email', 'test@lazy.test');
  git('config', 'user.name', 'Lazy Test');

  const areas = ['src/alpha', 'src/beta', 'docs'];
  for (let i = 0; i < 9; i++) {
    const path = `${areas[i % areas.length]}/file-${i}.ts`;
    mkdirSync(join(worktree, path, '..'), { recursive: true });
    writeFileSync(join(worktree, path), `unit ${i}\nline two\nline three\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `Accept task unit-${i}: Unit number ${i}`, '--no-verify');
  }
  // One unit whose every line a later one rewrites — it owns nothing and
  // collapses off the attribution. The same later unit also APPENDS to a file
  // the first one wrote, so both units' lines survive there: that is the
  // multi-claimant file the blame gutter is for.
  writeFileSync(join(worktree, 'src/alpha/doomed.ts'), 'first\nsecond\nthird\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Accept task doomed: Work that does not survive', '--no-verify');
  writeFileSync(join(worktree, 'src/alpha/shared.ts'), 'kept one\nkept two\nkept three\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Accept task keeper: Work that survives alongside', '--no-verify');
  writeFileSync(join(worktree, 'src/alpha/doomed.ts'), 'REWRITTEN\nENTIRELY\nAGAIN\n');
  writeFileSync(
    join(worktree, 'src/alpha/shared.ts'),
    'kept one\nkept two\nkept three\nadded four\nadded five\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'Accept task rewriter: Rewrite it all', '--no-verify');
  return taskId;
}

/**
 * Wait for the background line-attribution carve, the way a reader does: by
 * reloading. The first Changes open deliberately does not pay for the carve —
 * it renders without the gutter — and each reload joins the run already
 * going, so the gutter is in within a reload or two.
 */
async function untilBlamed(
  authed: (url: string) => Promise<Response>,
  url: string,
): Promise<string> {
  // "rv-blame-chip", not "rv-blame-on": the class name is also in the page's
  // toggle SCRIPT, which every render carries whether or not any file has
  // attribution — polling for it returns on the first open, before the
  // background carve has landed, and the gutters are then read off a page
  // that does not have them. Only a rendered header chip (or a column cell)
  // proves the attribution is in.
  for (let attempt = 0; attempt < 60; attempt++) {
    const html = await (await authed(url)).text();
    if (html.includes('rv-blame-chip')) return html;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the blame gutter never appeared after 15s: ${url}`);
}

describe('Changes tab region filter', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the Regions TAB lists the walkthrough groups, and links each one into Changes', async () => {
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const tab = await (await authed(`${base}/tasks/${taskId}/regions`)).text();
    // The tab is the map: every declared group is on it, residual last.
    expect(tab).toContain('Review regions');
    expect(tab).toContain('Alpha work');
    expect(tab).toContain('Docs pages');
    expect(tab).toContain('Other changes');
    // Each row links into the Changes tab with the filter applied — the tab
    // is the map, Changes is still where the diff is read.
    expect(tab).toContain('/changes?region=');
    expect(tab).toContain(`region=${encodeURIComponent('alpha-work')}`);
    // And it does NOT render the diff: opening the map must not pay for the
    // territory, which is the whole reason it is its own tab.
    expect(tab).not.toContain('+alpha one');
  });

  test('a group claiming a GLOB is one region with all its files, and the residual says what is left', async () => {
    // INVARIANT: a directory/glob file item claims every changed file it
    // matches as ONE item, and the partition reads through that expansion —
    // the region owns all of them, and the residual holds only what no
    // pattern claimed, stating how much that is. Without this a hub-sized
    // walkthrough cannot be written inside the item caps at all.
    const { taskId } = await globPresentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const tab = await (await authed(`${base}/tasks/${taskId}/regions`)).text();
    expect(tab).toContain('Region tests');
    // Two files under one claim — the row's size is the files, not the items.
    expect(tab).toMatch(/Region tests[\s\S]{0,400}?2 files/);
    // The residual says how much of the change the walkthrough did not name.
    expect(tab).toContain('Other changes');
    expect(tab).toContain('1 of 3 changed files is not named in the walkthrough.');

    // And the Changes block shows the group's files as its diff cards: one
    // item in the report, every matched file in the walkthrough.
    const changes = await (await authed(`${base}/tasks/${taskId}/changes?region=region-tests`)).text();
    expect(changes).toContain('regions-web.test.ts');
    expect(changes).toContain('regions-cli.test.ts');
    expect(changes).not.toContain('leftover one');
  });

  test('Changes carries a compact regions CARD, not the whole list', async () => {
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const all = await (await authed(`${base}/tasks/${taskId}/changes`)).text();
    // The card states the groups and points at the tab...
    expect(all).toContain('rv-regions-card');
    expect(all).toContain('Alpha work');
    expect(all).toMatch(/href="\/tasks\/[^"]+\/regions"/);
    // ...and the diff itself is still right there.
    expect(all).toContain('alpha.txt');
    expect(all).toContain('notes.md');
    // INVARIANT: the card is a POINTER, not a second copy of the list. Before
    // Regions had its own tab the full strip sat above every diff, which is
    // the same information twice and pushes the changes further down.
    expect(all).not.toContain('rv-regions-list');
    // INVARIANT: the whole review page reads display order — docs above core
    // (`sortPresentationGroupsForDisplay`) — and the card is part of that
    // page, so the agent's declared tier beats its declared order here even
    // though the CLI lists the declared order.
    expect(all.indexOf('Docs pages')).toBeLessThan(all.indexOf('Alpha work'));
  });

  test('the empty card says the walkthrough has not been filed', async () => {
    // INVARIANT: a task whose agent has not declared regions yet answers with
    // the note — "no presented regions yet" is a different and honest answer,
    // where silence reads as a bug and a carve would take seconds the reader
    // never asked to pay.
    const taskId = await unpresentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const html = await (await authed(`${base}/tasks/${taskId}/changes`)).text();
    expect(html).toContain('No review regions.');
    expect(html).toContain('no presented regions yet');
    // The diff is not withheld behind the missing walkthrough — that is the
    // thing the reviewer came for.
    expect(html).toContain('alpha.txt');
  });

  test('the unnamed-file count is one number, the same on Changes and on Regions', async () => {
    // INVARIANT: one sentence, from the WHOLE residual, said once. The Changes
    // block splits maintained paths into their own card and the region
    // surfaces never split, so a per-block count made the two halves of one
    // page answer the same question with different numbers.
    const { taskId } = await presentedTask(ctx, { claimAlphaOnly: true });
    // notes.md becomes a maintained leftover; extra.txt an ordinary one.
    const configPath = join(ctx.root, 'lazy.toml');
    await Bun.write(
      configPath,
      `${await Bun.file(configPath).text()}\n[[automation.maintain]]\n` +
        `title = "notes"\npattern = "notes.md"\ninstructions = "Keep notes.md current"\n`,
    );

    const { base, fetch: authed } = await signInToDashboard(ctx);
    const changes = await (await authed(`${base}/tasks/${taskId}/changes`)).text();
    const tab = await (await authed(`${base}/tasks/${taskId}/regions`)).text();

    const SENTENCE = '2 of 3 changed files are not named in the walkthrough.';
    expect(changes).toContain('Maintained files');
    expect(changes).toContain(SENTENCE);
    expect(tab).toContain(SENTENCE);
    // The maintained block explains the split rather than stating a second,
    // smaller count of its own.
    expect(changes).toContain(
      '1 of the files the walkthrough did not name is a maintained file, shown separately.',
    );
    expect(changes).not.toContain('1 of 3 changed files');
  });

  test('a cap refused with no walkthrough filed names the cap on Changes and on Regions', async () => {
    // INVARIANT (the engineer's rule this work exists for): a cap that was hit
    // reaches the reviewer even when no fitting walkthrough was ever filed —
    // the agent gave up, wrote prose, or the turn was killed. Both reader
    // paths used to gate on a stored presentation, so the case the record
    // matters most in showed nothing at all.
    const taskId = await unpresentedTask(ctx);
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);

    await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Could not fit a walkthrough' }],
            presentation: {
              groups: Array.from({ length: 33 }, (_, i) => ({
                title: `Group ${i}`,
                tier: 'core',
                items: [{ kind: 'prose', body: `Story ${i}` }],
              })),
            },
          },
        },
      },
    ]);

    const { base, fetch: authed } = await signInToDashboard(ctx);

    // The review page, where there is no presented block to carry it.
    const changes = await (await authed(`${base}/tasks/${taskId}/changes`)).text();
    expect(changes).toContain('the 32-group cap');
    expect(changes).toContain('no walkthrough because of the cap');
    // ...and the diff is still right there, as it was before.
    expect(changes).toContain('alpha.txt');

    // And the Regions tab says the same thing.
    const tab = await (await authed(`${base}/tasks/${taskId}/regions`)).text();
    expect(tab).toContain('the 32-group cap');
  });

  test('?region= scopes the diff to the group, and the card says which is in force', async () => {
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const scoped = await (await authed(
      `${base}/tasks/${taskId}/changes?region=${encodeURIComponent('alpha-work')}`,
    )).text();
    // INVARIANT: a scoped diff must SAY it is scoped and offer the way out. A
    // filtered diff that looks unfiltered lies about how big the change is.
    expect(scoped).toContain('rv-regions-card-active');
    expect(scoped).toContain('Alpha work');
    expect(scoped).toContain('Showing one region');
    expect(scoped).toContain('show all changes');
    // Scoped to the group's own files: alpha is in, notes.md is not.
    expect(scoped).toContain('alpha.txt');
    expect(scoped).not.toContain('+docs one');
  });

  test('a group id that is not in the walkthrough falls back to all changes with a notice', async () => {
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const response = await authed(`${base}/tasks/${taskId}/changes?region=nope`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // INVARIANT: a bad filter is a NOTICE plus the unfiltered diff, never a
    // broken page and never a silently empty Changes tab — the reviewer must
    // be able to tell which of the two they are looking at.
    expect(html).toContain('No region');
    expect(html).toContain('alpha.txt');
    expect(html).toContain('notes.md');
  });

  test('INVARIANT: the FIRST open of Changes reads the walkthrough, never a carve. The presentation is stored state the report already wrote, so opening the page costs no git walk at all — and it must never withhold the diff behind one, whichever source the groups come from.', async () => {
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    // The card and the diff are both there on the very first render: no
    // "being computed" window exists on a human surface any more.
    const first = await (await authed(`${base}/tasks/${taskId}/changes`)).text();
    expect(first).toContain('rv-regions-card');
    expect(first).toContain('Alpha work');
    expect(first).toContain('alpha.txt');
    expect(first).not.toContain('being computed');
  });

  test('a file two units wrote carries the subtask-blame gutter', async () => {
    // INVARIANT: the gutter is ON where it tells the reviewer something they
    // do not already know — a file several units touched — and labels each RUN
    // once with a link to that subtask, not once per line.
    const taskId = await gutterTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const changes = await untilBlamed(authed, `${base}/tasks/${taskId}/changes`);

    expect(changes).toContain('rv-blame-on');
    expect(changes).toContain('rv-blame-label');
    // Both units' lines survive in shared.ts, so both are labelled there.
    expect(changes).toContain('href="/tasks/rewriter"');
    expect(changes).toContain('href="/tasks/keeper"');
    expect(changes).toContain('2 units');
    // The toggle says how many units are in the file, so a reader who does not
    // want the column can put it away.
    expect(changes).toContain('data-rv-blame-toggle');
    // A file only one unit touched gets the header chip instead of a column of
    // the same label repeated.
    expect(changes).toContain('rv-blame-chip');
  });

  test('screenshot: the Regions tab with the walkthrough groups', async () => {
    const chrome = await findChromeBinary();
    if (!chrome) {
      console.log('skip: no headless browser on PATH, screenshot not captured');
      return;
    }
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);
    const out = process.env.LAZY_SHOT_DIR
      ? join(process.env.LAZY_SHOT_DIR, 'regions-tab.png')
      : join(ctx.root, 'regions-tab.png');
    await screenshotDashboardPage({ fetch: authed, base, path: `/tasks/${taskId}/regions`, out });
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test('a cap refusal is on the Regions tab, naming the cap', async () => {
    // INVARIANT (engineer, 2026-09-20): a cap that is hit is visible to the
    // REVIEWER. The builder reviewing a hub must be able to see "the
    // walkthrough hit the cap" without reading the agent's turn.
    const { taskId } = await globPresentedTask(ctx, { hitCap: true });
    const { base, fetch: authed } = await signInToDashboard(ctx);

    const tab = await (await authed(`${base}/tasks/${taskId}/regions`)).text();
    expect(tab).toContain('the 32-group cap');
    expect(tab).toContain('33 declared');
  });

  test('screenshot: the Regions tab of a walkthrough claimed by glob, with a cap hit', async () => {
    const chrome = await findChromeBinary();
    if (!chrome) {
      console.log('skip: no headless browser on PATH, screenshot not captured');
      return;
    }
    const { taskId } = await globPresentedTask(ctx, { hitCap: true });
    const { base, fetch: authed } = await signInToDashboard(ctx);
    const out = process.env.LAZY_SHOT_DIR
      ? join(process.env.LAZY_SHOT_DIR, 'regions-tab-glob-cap.png')
      : join(ctx.root, 'regions-tab-glob-cap.png');
    await screenshotDashboardPage({ fetch: authed, base, path: `/tasks/${taskId}/regions`, out });
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test('screenshot: the subtask-blame gutter on a multi-claimant file', async () => {
    const chrome = await findChromeBinary();
    if (!chrome) {
      console.log('skip: no headless browser on PATH, screenshot not captured');
      return;
    }
    const taskId = await gutterTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);
    // The gutter is the subject, so the picture waits for it to be in — and
    // stays unscoped: a walkthrough group id is the only selectable filter,
    // and this fixture files no walkthrough by design.
    await untilBlamed(authed, `${base}/tasks/${taskId}/changes`);
    const out = process.env.LAZY_SHOT_DIR
      ? join(process.env.LAZY_SHOT_DIR, 'blame-gutter.png')
      : join(ctx.root, 'blame-gutter.png');
    await screenshotDashboardPage({
      fetch: authed,
      base,
      path: `/tasks/${taskId}/changes`,
      out,
    });
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test('screenshot: the regions strip on the Changes tab', async () => {
    const chrome = await findChromeBinary();
    if (!chrome) {
      // No headless browser in this image — the two assertions above already
      // cover the behaviour; only the picture is missing.
      console.log('skip: no headless browser on PATH, screenshot not captured');
      return;
    }
    const { taskId } = await presentedTask(ctx);
    const { base, fetch: authed } = await signInToDashboard(ctx);
    const out = join(ctx.root, 'regions-changes.png');
    await screenshotDashboardPage({
      fetch: authed,
      base,
      path: `/tasks/${taskId}/changes`,
      out,
    });
    expect(await Bun.file(out).exists()).toBe(true);
  });
});