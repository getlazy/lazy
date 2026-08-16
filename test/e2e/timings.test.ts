/**
 * `lazy stats timings` output shape.
 *
 * Seeds a spans.jsonl directly (the CLI cannot produce a deterministic trace)
 * and asserts the rendered readout: self-time rankings are the headline, the
 * nested tree is opt-in, and a pass-through wrapper does not masquerade as the
 * slow thing.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { storageDirFor } from '../helpers/storage';

/**
 * The trace shape that motivated self-time ranking: an 8.5s `lazy.start` whose
 * "slowest span" was a 3.15s wrapper (`remote.publish_branch`) around a 3.13s
 * `git.push`. The wrapper must not be the headline; the leaves must.
 */
function liveShapedSpans(): string {
  const t0 = Date.now() - 60_000;
  const s = (
    name: string,
    id: string,
    parent: string | null,
    start: number,
    end: number,
    service = 'daemon',
  ) => ({
    trace_id: 'aaaaaaaabbbbbbbbccccccccdddddddd',
    span_id: id,
    parent_span_id: parent,
    name,
    start_ms: t0 + start,
    end_ms: t0 + end,
    duration_ms: end - start,
    status: 'ok',
    service,
    attributes: { 'lazy.task_id': 'deadbeefcafe' },
  });

  return [
    s('lazy.start', 'root', null, 0, 8500, 'cli'),
    s('daemon.start', 'dmn', 'root', 100, 8400),
    s('remote.publish_branch', 'pub', 'dmn', 200, 3350),
    s('git.push', 'push', 'pub', 210, 3340),
    s('git.worktree.create', 'wt', 'dmn', 3400, 4600),
    s('docker.launch_supervisor', 'dkr', 'dmn', 4700, 8300),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n';
}

async function seedSpans(root: string, jsonl: string): Promise<void> {
  const dir = join(storageDirFor(root), 'traces');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spans.jsonl'), jsonl, 'utf-8');
}

describe('lazy stats timings', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('reports an actionable empty state when nothing is traced', async () => {
    const result = await ctx.lazy(['stats', 'timings']);
    expectSuccess(result);
    expectOutput(result, 'No requests traced yet');
  });

  test('ranks leaves and nested own-work instead of the tree', async () => {
    await seedSpans(ctx.root, liveShapedSpans());
    const result = await ctx.lazy(['stats', 'timings']);
    expectSuccess(result);

    expectOutput(result, '1 trace(s), 6 span(s)');
    expectOutput(result, 'total 8.50s');
    expectOutput(result, 'slowest operations');
    expectOutput(result, 'slowest own work in nested spans');

    // Leaf list: the real operations, ordered by duration.
    const out = result.stdout;
    const leafHeader = out.indexOf('slowest operations');
    const branchHeader = out.indexOf('slowest own work');
    const leafSection = out.slice(leafHeader, branchHeader);
    expect(leafSection.indexOf('docker.launch_supervisor')).toBeGreaterThan(-1);
    expect(leafSection.indexOf('docker.launch_supervisor')).toBeLessThan(leafSection.indexOf('git.push'));
    expect(leafSection.indexOf('git.push')).toBeLessThan(leafSection.indexOf('git.worktree.create'));
    // Wrappers are not leaves — they must not appear in the leaf list at all.
    expect(leafSection).not.toContain('remote.publish_branch');
    expect(leafSection).not.toContain('lazy.start');

    // Branch list: ranked by own work, so the pass-through wrapper sinks and
    // its self time is reported as ~20ms rather than its 3.15s duration.
    const branchSection = out.slice(branchHeader);
    expect(branchSection).toContain('remote.publish_branch');
    expect(branchSection).toContain('20ms');
    expect(branchSection.indexOf('daemon.start')).toBeLessThan(branchSection.indexOf('remote.publish_branch'));
    expect(branchSection).toContain('in children');
  });

  test('the tree is opt-in via --tree', async () => {
    await seedSpans(ctx.root, liveShapedSpans());

    // Match the section header line itself — `git.worktree.create` also
    // contains the substring "tree".
    const hasTreeSection = (out: string) => /^\s*tree\s*$/m.test(out);

    const plain = await ctx.lazy(['stats', 'timings']);
    expectSuccess(plain);
    expect(hasTreeSection(plain.stdout)).toBe(false);

    const withTree = await ctx.lazy(['stats', 'timings', '--tree']);
    expectSuccess(withTree);
    expect(hasTreeSection(withTree.stdout)).toBe(true);
    // The tree still shows nesting AND now annotates branch self time.
    expectOutput(withTree, 'lazy.start');
    expectOutput(withTree, 'self ');
  });

  test('--top caps each ranked list', async () => {
    await seedSpans(ctx.root, liveShapedSpans());
    const result = await ctx.lazy(['stats', 'timings', '--top', '1']);
    expectSuccess(result);
    const out = result.stdout;
    const branchHeader = out.indexOf('slowest own work');
    const leafSection = out.slice(out.indexOf('slowest operations'), branchHeader);
    expect(leafSection).toContain('docker.launch_supervisor');
    expect(leafSection).not.toContain('git.push');
    expect(out.slice(branchHeader)).not.toContain('remote.publish_branch');
  });

  test('rejects invalid --top and --since values', async () => {
    const bad = await ctx.lazy(['stats', 'timings', '--top', '0']);
    expectFailure(bad);
    expectError(bad, "Invalid --top '0'");

    const badSince = await ctx.lazy(['stats', 'timings', '--since', 'yesterday']);
    expectFailure(badSince);
    expectError(badSince, "Invalid --since 'yesterday'");
  });

  // The readout moved under the stats multiplexer; there is deliberately no
  // top-level alias left behind.
  test('top-level `lazy timings` is gone', async () => {
    const result = await ctx.lazy(['timings']);
    expectFailure(result);
    expectError(result, 'Unknown command');
  });

  test('help documents the self-time ranking and its flags', async () => {
    const result = await ctx.lazy(['stats', 'timings', '--help']);
    expectSuccess(result);
    expectOutput(result, '--top');
    expectOutput(result, '--tree');
    expectOutput(result, 'SELF TIME');
  });
});
