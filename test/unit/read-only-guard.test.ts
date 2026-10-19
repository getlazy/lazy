/**
 * Lazy's own enforcement of read-only turns (src/supervisor/read-only-guard.ts)
 * and the "a review that inspected nothing is not a review" rule.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, realpath, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertWorktreeUnchanged,
  countingActivityStream,
  reportsCouldNotInspect,
  runnerIsExternallySandboxed,
  snapshotWorktree,
} from '../../src/supervisor/read-only-guard';
import { uninspectedReviewReason, LOW_HIGH_LOOP_APPROVED } from '../../src/supervisor/low-high-loop';
import { CodexActivityStream } from '../../src/agent/codex';

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

describe('read-only write check', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'ro-guard-')));
    git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'a\n');
    await writeFile(join(dir, 'dirty.txt'), 'base\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    // Pre-existing uncommitted state the reviewer did NOT make.
    await writeFile(join(dir, 'dirty.txt'), 'human edit\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('an untouched worktree passes, pre-existing dirt included', async () => {
    const before = await snapshotWorktree(dir);
    await assertWorktreeUnchanged(dir, before, 'This review turn');
  });

  // INVARIANT: a read-only turn that writes fails LOUDLY, naming the files,
  // and nothing is reverted — lazy cannot prove the reviewer made a change it
  // did not watch being made, so it never destroys work on that guess.
  test('a review that modifies the worktree is failed, naming the files, without reverting', async () => {
    const before = await snapshotWorktree(dir);
    await writeFile(join(dir, 'a.txt'), 'reviewer "fixed" it\n');
    await writeFile(join(dir, 'new.txt'), 'new\n');
    await writeFile(join(dir, 'dirty.txt'), 'further edit\n');
    const err = await assertWorktreeUnchanged(dir, before, 'This review turn').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('This review turn is read-only');
    expect(msg).toContain('a.txt');
    expect(msg).toContain('new.txt');
    // A further edit to an ALREADY dirty file is caught by content, not status.
    expect(msg).toContain('dirty.txt');
    expect(msg).toContain('Nothing was reverted');
    expect(await Bun.file(join(dir, 'a.txt')).text()).toBe('reviewer "fixed" it\n');
  });

  test('a commit moves HEAD and is caught', async () => {
    const before = await snapshotWorktree(dir);
    await writeFile(join(dir, 'c.txt'), 'c\n');
    git(dir, 'add', 'c.txt');
    git(dir, 'commit', '-qm', 'sneaky');
    const err = await assertWorktreeUnchanged(dir, before, 'This ask turn').catch((e: Error) => e);
    expect((err as Error).message).toContain('HEAD moved');
  });

  test('an unhashable path degrades only itself — other content edits are still caught', async () => {
    await symlink(join(dir, 'nowhere'), join(dir, 'dangling'));
    const before = await snapshotWorktree(dir);
    await writeFile(join(dir, 'dirty.txt'), 'further edit\n');
    const err = await assertWorktreeUnchanged(dir, before, 'This review turn').catch((e: Error) => e);
    expect((err as Error).message).toContain('dirty.txt');
    expect((err as Error).message).not.toContain('dangling');
  });

  test("lazy's own sandbox dir (handoff file) is not the reviewer's write", async () => {
    const before = await snapshotWorktree(dir);
    await mkdir(join(dir, '.lazy-task-sandbox'), { recursive: true });
    await writeFile(join(dir, '.lazy-task-sandbox', 'turn-handoff.jsonl'), '{}\n');
    await assertWorktreeUnchanged(dir, before, 'This review turn');
  });
});

describe('inspection evidence', () => {
  // Any line, not only the first: Codex joins every message of a turn, so a
  // narrating reviewer's final "could not inspect" message follows other text.
  test('the could-not-inspect marker is found on any line that starts with it', () => {
    expect(reportsCouldNotInspect('REVIEW_COULD_NOT_INSPECT: bwrap: no namespace')).toBe(true);
    expect(reportsCouldNotInspect('  `REVIEW_COULD_NOT_INSPECT`: tools denied')).toBe(true);
    expect(reportsCouldNotInspect('Inspecting the diff now.\n\nREVIEW_COULD_NOT_INSPECT: lazy_diff denied')).toBe(true);
    expect(reportsCouldNotInspect('The prompt mentions REVIEW_COULD_NOT_INSPECT but I read everything.')).toBe(false);
  });

  // INVARIANT: a low-high self-review approval with zero tool calls is NOT an
  // approval — the bare `LOW_HIGH_LOOP_APPROVED` that read nothing is exactly
  // what Codex reviewers produced while their sandbox blocked every tool.
  // Instructions with zero tool calls still stand (they never wave work
  // through), and an unobservable count is unknown, not zero.
  test('low-high: approval needs at least one tool call; the marker always fails', () => {
    expect(uninspectedReviewReason(LOW_HIGH_LOOP_APPROVED, 0)).toContain('without calling a single tool');
    expect(uninspectedReviewReason(LOW_HIGH_LOOP_APPROVED, 3)).toBeNull();
    expect(uninspectedReviewReason(LOW_HIGH_LOOP_APPROVED, undefined)).toBeNull();
    expect(uninspectedReviewReason('1. Fix the retry path.', 0)).toBeNull();
    expect(uninspectedReviewReason('REVIEW_COULD_NOT_INSPECT: sandbox', 5)).toContain('could not inspect');
  });

  test('the counting stream counts tool starts off a real codex stream', () => {
    const stream = countingActivityStream(new CodexActivityStream());
    stream.parseLine(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git diff' } }));
    stream.parseLine(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'git diff' } }));
    stream.parseLine(JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } }));
    expect(stream.toolCalls()).toBe(1);
  });

  test('a tool seen only on completion still counts as a call', () => {
    const stream = countingActivityStream(new CodexActivityStream());
    stream.parseLine(JSON.stringify({ type: 'item.completed', item: { id: 'i9', type: 'mcp_tool_call', server: 'lazy', tool: 'lazy_diff' } }));
    expect(stream.toolCalls()).toBe(1);
  });

  test('only the host-process runner keeps the harness sandbox', () => {
    expect(runnerIsExternallySandboxed('docker')).toBe(true);
    expect(runnerIsExternallySandboxed('podman')).toBe(true);
    expect(runnerIsExternallySandboxed('dangerously-host-process-without-any-isolation')).toBe(false);
  });
});
