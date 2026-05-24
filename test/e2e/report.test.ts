import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFile, readFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectError } from '../helpers/assertions';

// The map-reduce mock (test/mocks/claude.ts) inspects the LAZY_REPORT_STAGE
// marker in each prompt and synthesizes:
//   task-map  → `[map:task:<code>] ...`
//   commit-map → `[map:commit:<sha7>] ...`
//   reduce    → three-section markdown whose lead tier echoes every
//               [map:...] marker the reduce saw — letting these tests
//               grep stdout to verify wiring.
// The reduce body is the default synthesis unless a test passes
// `LAZY_MOCK_CLAUDE_RESPONSE` with a custom `result`.

// `MOCK_RESPONSE` is passed positionally to `ctx.lazyMocked` but for the
// report command this only pins the reduce body when no marker
// synthesis is desired. Most tests use the synthesized default and just
// assert against the echoed markers.
const PASSTHROUGH_MOCK = {
  result: 'unused — synthesized by stage-aware mock instead',
  session_id: 'mock-reduce-passthrough',
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('lazy report', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('default 24h window produces a three-section report', async () => {
    await ctx.lazy(['create', '--goal', 'A recent task within the window']);

    // Don't pin the reduce body — let the stage-aware mock synthesize it so
    // [map:task:*] markers from the map phase get echoed in stdout.
    const result = await ctx.lazyMocked(['report'], PASSTHROUGH_MOCK);

    expectSuccess(result);
    expectOutput(result, '# Lazy activity report');
    expectOutput(result, '**Window:**');
    expectOutput(result, '## Brief');
    expectOutput(result, '## For the engineering manager');
    expectOutput(result, '## For the engineering lead');
  });

  test('--start -3d widens the window', async () => {
    await ctx.lazy(['create', '--goal', 'Task for the wider window']);
    const result = await ctx.lazyMocked(['report', '--start', '-3d'], PASSTHROUGH_MOCK);

    expectSuccess(result);
    expectOutput(result, '**Window:**');
    expect(/\d{4}-\d{2}-\d{2}T.*→.*\d{4}-\d{2}-\d{2}T/.test(result.stdout)).toBe(true);
  });

  test('empty window produces a sensible no-activity report rather than crashing', async () => {
    // Use a window far in the past — before the test fixture's setup
    // commits — so the reduce sees zero units.
    const result = await ctx.lazyMocked(
      ['report', '--start', '2020-01-01T00:00:00Z', '--end', '2020-01-02T00:00:00Z'],
      PASSTHROUGH_MOCK,
    );

    expectSuccess(result);
    expectOutput(result, '## Brief');
    expectOutput(result, 'Nothing of note in this window.');
  });

  test('non-lazy main-branch commit lands in the report as a commit unit', async () => {
    // Make a direct commit on main — no lazy task involved.
    await writeFile(join(ctx.root, 'collab-change.txt'), 'work done outside lazy\n');
    ctx.git('add', 'collab-change.txt');
    ctx.git('commit', '-m', 'Collaborator change without lazy');

    const result = await ctx.lazyMocked(['report'], PASSTHROUGH_MOCK);

    expectSuccess(result);
    // The synthesized reduce body echoes [map:commit:<sha7>] for every
    // non-lazy commit it saw. Verifying any such marker reaches stdout
    // proves: enumeration found the commit, classification kept it
    // non-lazy, the commit map call ran, and the reduce input included
    // its output.
    expect(/\[map:commit:[0-9a-f]{7}\]/.test(result.stdout)).toBe(true);
  });

  test('Accept-task commit on main is classified as lazy and not emitted as a non-lazy unit', async () => {
    // Create a task, then synthesize a squash-merge-style "Accept task ..."
    // commit on main referencing it. lazy report should bucket this as
    // lazy-managed (so it appears under a task unit, NOT as a
    // [map:commit:*] entry).
    const createOut = await ctx.lazy(['create', '--goal', 'Build feature X']);
    expectSuccess(createOut);
    const code = createOut.stdout.match(/Created task ([^\s]+)/)?.[1];
    if (!code) throw new Error(`could not extract task code from: ${createOut.stdout}`);

    await writeFile(join(ctx.root, 'accepted.txt'), 'merged work\n');
    ctx.git('add', 'accepted.txt');
    ctx.git('commit', '-m', `Accept task ${code}: Build feature X\n\nSquashed.`);

    // Capture the accept commit's SHA so we can assert on it specifically —
    // other fixture commits in-window would otherwise produce their own
    // [map:commit:*] markers and confuse a blanket "no commit markers"
    // assertion.
    const acceptSha = ctx.git('rev-parse', 'HEAD').stdout.trim().slice(0, 7);

    const result = await ctx.lazyMocked(['report'], PASSTHROUGH_MOCK);

    expectSuccess(result);
    // Lazy-managed: the task unit echoed in stdout.
    expect(result.stdout).toContain(`[map:task:${code}]`);
    // The accept commit specifically must NOT show up as a non-lazy unit.
    expect(result.stdout).not.toContain(`[map:commit:${acceptSha}]`);
  });

  test('a map-call failure does not crash the reduce phase', async () => {
    await writeFile(join(ctx.root, 'will-fail.txt'), 'this commit triggers the mock to throw\n');
    ctx.git('add', 'will-fail.txt');
    // Sentinel-bearing subject so LAZY_MOCK_FAIL_KEYWORD matches when the
    // commit bundle is sent to the per-commit map call.
    ctx.git('commit', '-m', 'TRIGGER_MAP_FAILURE: collaborator change');

    const result = await ctx.lazyMocked(['report'], PASSTHROUGH_MOCK, {
      env: {
        LAZY_MOCK_FAIL_KEYWORD: 'TRIGGER_MAP_FAILURE',
      },
    });

    // Reduce ran and produced output.
    expectSuccess(result);
    expectOutput(result, '## Brief');
    // The failed-units header is emitted by the command itself when at
    // least one map call failed.
    expectOutput(result, 'could not be summarized');
  });

  test('reduce sees both lazy and non-lazy units in its input', async () => {
    // Create a lazy task AND a non-lazy commit; both should reach the
    // reduce phase as distinct units with distinct map markers.
    await ctx.lazy(['create', '--goal', 'Lazy unit A']);
    await writeFile(join(ctx.root, 'non-lazy.txt'), 'outside lazy\n');
    ctx.git('add', 'non-lazy.txt');
    ctx.git('commit', '-m', 'Non-lazy contributor change');

    const result = await ctx.lazyMocked(['report'], PASSTHROUGH_MOCK);

    expectSuccess(result);
    // Lead tier must distinguish both flavors via the marker echoes.
    expect(/\[map:task:[^\]]+\]/.test(result.stdout)).toBe(true);
    expect(/\[map:commit:[0-9a-f]{7}\]/.test(result.stdout)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // PDF path
  //
  // renderPdf has a LAZY_TEST=1 short-circuit that writes a stub PDF
  // instead of shelling out to a real Chrome — these tests verify the
  // wiring (flag parsing, default vs --out path, auto-open vs not)
  // without depending on Chrome being installed in CI.
  // ---------------------------------------------------------------------
  test('--pdf writes a PDF to tmpdir and prints the path', async () => {
    const result = await ctx.lazyMocked(['report', '--pdf'], PASSTHROUGH_MOCK, {
      env: { LAZY_REPORT_PDF_STUB: '1' },
    });

    expectSuccess(result);
    expectOutput(result, 'Wrote PDF: ');
    const match = result.stdout.match(/Wrote PDF: (.+)$/m);
    if (!match) throw new Error(`could not find "Wrote PDF:" line in stdout:\n${result.stdout}`);
    const pdfPath = match[1].trim();

    // Default path goes into the OS tmpdir.
    expect(pdfPath).toContain(tmpdir());
    expect(pdfPath.endsWith('.pdf')).toBe(true);
    // File exists and has the stub PDF marker.
    const bytes = await readFile(pdfPath, 'utf-8');
    expect(bytes.startsWith('%PDF-1.4')).toBe(true);
    // Reduce body should not also be printed to stdout in PDF mode —
    // only the "Wrote PDF: ..." confirmation line.
    expect(result.stdout).not.toContain('## For the engineering lead');
    await rm(pdfPath, { force: true });
  });

  test('--pdf --out <path> writes to the given path and skips auto-open', async () => {
    const outPath = join(tmpdir(), `lazy-report-out-${Date.now()}.pdf`);

    const result = await ctx.lazyMocked(['report', '--pdf', '--out', outPath], PASSTHROUGH_MOCK, {
      env: { LAZY_REPORT_PDF_STUB: '1' },
    });

    expectSuccess(result);
    expectOutput(result, `Wrote PDF: ${outPath}`);
    const bytes = await readFile(outPath, 'utf-8');
    expect(bytes.startsWith('%PDF-1.4')).toBe(true);

    // openWithDefaultApp is gated by LAZY_TEST=1 already, but the
    // command-level contract is that --out also disables auto-open
    // regardless of test mode. We verify the more important behavior
    // here: the PDF lands at the user-specified path (no surprise
    // tmpdir copy).
    await rm(outPath, { force: true });
  });

  test('--out without --pdf is rejected with the validation error', async () => {
    const outPath = join(tmpdir(), `lazy-report-rejected-${Date.now()}.pdf`);
    const result = await ctx.lazyMocked(['report', '--out', outPath], PASSTHROUGH_MOCK);

    expect(result.exitCode).not.toBe(0);
    expectError(result, '`--out` only applies with `--pdf`');
  });
});
