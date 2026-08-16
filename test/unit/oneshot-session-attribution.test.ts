/**
 * Unit tests: lazy's own `claude -p` housekeeping sessions must never be
 * mistaken for a human's interactive session.
 *
 * THE BUG THIS ENCODES
 * --------------------
 * A fidelity summary (accept-time housekeeping, run via `runClaudeOneshot`)
 * appeared as a user turn inside a live builder conversation. The delivery path
 * is session ATTRIBUTION, not synthesis: `runClaudeOneshot` inherits the
 * daemon's cwd, so its JSONL lands in exactly the projects dir every
 * session-ownership rule scans — and being brand new it is by construction the
 * newest "created since launch" file, which is the whole of `pickLaunchSessionId`
 * and rule 1 of `pickActiveSessionFile`. The resolved id is then stamped as the
 * builder's resume target, so the next builder resumes INTO the housekeeping
 * conversation, and capture stores it as a conversation.
 *
 * The marker existed already and was honoured in exactly one place (reimport /
 * sweep discovery). These tests pin it down in the ownership and capture paths
 * too, and pin the execution path a one-shot takes.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, utimes, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ONESHOT_MARKER,
  markMachineOneshotPrompt,
  excludeMachineOneshots,
} from '../../src/import/machine-oneshot';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { detectBuilderLaunchSessionId } from '../../src/builder/session-detect';
import { detectInteractiveSessionId } from '../../src/supervisor/interactive';
import {
  snapshotSessionFiles,
  captureNewOrModifiedConversations,
} from '../../src/import/capture-session';
import { buildOneshotArgs } from '../../src/capture/claude';
import type { Storage } from '../../src/storage';

/** One JSONL line shaped like Claude Code's first user entry. */
function userLine(content: string, cwd: string): string {
  return JSON.stringify({
    parentUuid: null,
    type: 'user',
    cwd,
    sessionId: 'x',
    version: '1.0.0',
    message: { role: 'user', content },
    timestamp: new Date(0).toISOString(),
  });
}

describe('excludeMachineOneshots', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-osa-excl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, firstLine: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, `${firstLine}\n`);
    return p;
  }

  test('drops marked one-shots and keeps real sessions', async () => {
    const oneshot = await write('a.jsonl', userLine(markMachineOneshotPrompt('summarize this'), dir));
    const real = await write('b.jsonl', userLine('what does accept do?', dir));

    const kept = await excludeMachineOneshots([{ filePath: oneshot }, { filePath: real }]);
    expect(kept.map(f => f.filePath)).toEqual([real]);
  });

  // INVARIANT: the match is head-anchored and structural, never a content
  // heuristic. A conversation that merely QUOTES the marker (this file being
  // read aloud, a task prompt about the marker) is a real conversation and must
  // survive. Do not relax this to a substring scan of the file.
  test('keeps a real conversation that merely mentions the marker', async () => {
    const quoting = await write('c.jsonl', userLine(`why is ${ONESHOT_MARKER} needed?`, dir));
    const kept = await excludeMachineOneshots([{ filePath: quoting }]);
    expect(kept.map(f => f.filePath)).toEqual([quoting]);
  });

  // INVARIANT: unreadable → KEPT. Erring towards "this is a real session" costs
  // a redundant capture; erring the other way silently loses a human's
  // conversation and can hand their resume target away.
  test('keeps a file it cannot read', async () => {
    const unreadable = await write('d.jsonl', userLine(markMachineOneshotPrompt('x'), dir));
    await chmod(unreadable, 0o000);
    try {
      const kept = await excludeMachineOneshots([{ filePath: unreadable }]);
      expect(kept.map(f => f.filePath)).toEqual([unreadable]);
    } finally {
      await chmod(unreadable, 0o644);
    }
  });

  test('preserves order and passes extra fields through', async () => {
    const a = await write('e.jsonl', userLine('one', dir));
    const b = await write('f.jsonl', userLine(markMachineOneshotPrompt('housekeeping'), dir));
    const c = await write('g.jsonl', userLine('two', dir));

    const kept = await excludeMachineOneshots([
      { filePath: a, sessionId: 'a' },
      { filePath: b, sessionId: 'b' },
      { filePath: c, sessionId: 'c' },
    ]);
    expect(kept.map(f => f.sessionId)).toEqual(['a', 'c']);
  });
});

describe('session ownership ignores machine one-shots', () => {
  let root: string;
  let home: string;
  let isolated: string;

  /**
   * Write a session JSONL for `lazyRoot` under `projectsDir`, with an explicit
   * mtime and a chosen first user message.
   */
  async function writeSession(
    projectsDir: string,
    lazyRoot: string,
    sessionId: string,
    mtimeMs: number,
    firstMessage: string,
  ): Promise<void> {
    const dir = join(projectsDir, encodeProjectPath(lazyRoot));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, `${userLine(firstMessage, lazyRoot)}\n`);
    const secs = mtimeMs / 1000;
    await utimes(file, secs, secs);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-osa-root-'));
    home = await mkdtemp(join(tmpdir(), 'lazy-osa-home-'));
    isolated = await mkdtemp(join(tmpdir(), 'lazy-osa-iso-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
      rm(isolated, { recursive: true, force: true }),
    ]);
  });

  // INVARIANT: a housekeeping one-shot is never a builder's resume target, even
  // when it is the newest post-launch file — which it always is, because an
  // accept made DURING the builder session writes it after the builder started.
  // Resuming onto it is exactly how a fidelity prompt appeared inside a live
  // builder conversation.
  test('detectBuilderLaunchSessionId skips a newer one-shot in the isolation dir', async () => {
    const launchedAtMs = Date.now();
    await writeSession(isolated, root, 'builder-session', launchedAtMs + 1_000, 'hello');
    await writeSession(
      isolated,
      root,
      'fidelity-oneshot',
      launchedAtMs + 9_000,
      markMachineOneshotPrompt('You are writing the description that will land…'),
    );

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('builder-session');
  });

  test('detectBuilderLaunchSessionId skips a newer one-shot in the shared dir', async () => {
    const launchedAtMs = Date.now();
    const shared = join(home, '.claude', 'projects');
    await writeSession(shared, root, 'builder-session', launchedAtMs + 1_000, 'hello');
    await writeSession(
      shared,
      root,
      'fidelity-oneshot',
      launchedAtMs + 9_000,
      markMachineOneshotPrompt('housekeeping'),
    );

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('builder-session');
  });

  // A one-shot alone must not invent an owner. Reporting null (or the resume id)
  // is correct: the launch wrote nothing of its own.
  test('a lone one-shot yields the resume id, not the one-shot', async () => {
    const launchedAtMs = Date.now();
    await writeSession(
      isolated,
      root,
      'fidelity-oneshot',
      launchedAtMs + 5_000,
      markMachineOneshotPrompt('housekeeping'),
    );

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: 'human-session',
      homeDirAbs: home,
    });
    expect(id).toBe('human-session');
  });

  // Same rule for `lazy pair` / `lazy chat`: the human is sitting in that
  // terminal, and an accept they trigger from it fires a fidelity one-shot into
  // the same shared dir.
  test('detectInteractiveSessionId skips a newer one-shot', async () => {
    const launchedAtMs = Date.now();
    const shared = join(home, '.claude', 'projects');
    await writeSession(shared, root, 'pair-session', launchedAtMs + 1_000, 'hello');
    await writeSession(
      shared,
      root,
      'fidelity-oneshot',
      launchedAtMs + 9_000,
      markMachineOneshotPrompt('housekeeping'),
    );

    const id = await detectInteractiveSessionId({
      cwd: root,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('pair-session');
  });
});

describe('capture ignores machine one-shots', () => {
  let root: string;
  let home: string;
  let prevHome: string | undefined;

  async function writeSession(
    lazyRoot: string,
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    const dir = join(home, '.claude', 'projects', encodeProjectPath(lazyRoot));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), `${userLine(firstMessage, lazyRoot)}\n`);
  }

  /** Minimal Storage stand-in recording what capture tried to persist. */
  function fakeStorage(saved: string[]): Storage {
    return {
      saveConversation: async (c: { sessionId: string }) => {
        saved.push(c.sessionId);
      },
    } as unknown as Storage;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-osa-cap-root-'));
    home = await mkdtemp(join(tmpdir(), 'lazy-osa-cap-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ]);
  });

  // INVARIANT: housekeeping is not a conversation and is not this run's session.
  // Both halves matter — `newestSessionId` is what callers stamp as the resume
  // target, so a one-shot winning it hands the human's next builder to it.
  test('a one-shot is neither captured nor reported as newestSessionId', async () => {
    const before = await snapshotSessionFiles(root);
    await writeSession(root, 'real-session', 'hello there');
    await writeSession(root, 'fidelity-oneshot', markMachineOneshotPrompt('housekeeping'));

    const saved: string[] = [];
    const result = await captureNewOrModifiedConversations(root, before, fakeStorage(saved));

    expect(result.captured).toEqual(['real-session']);
    expect(result.newestSessionId).toBe('real-session');
    expect(saved).toEqual(['real-session']);
  });

  // The before-snapshot must not list one-shots either: a snapshot entry makes a
  // later pass treat the file as "pre-existing", which is a different bug class,
  // and both sides of the diff must agree on what a session is.
  test('snapshotSessionFiles omits one-shots', async () => {
    await writeSession(root, 'real-session', 'hello there');
    await writeSession(root, 'fidelity-oneshot', markMachineOneshotPrompt('housekeeping'));

    const snap = await snapshotSessionFiles(root);
    expect([...snap.keys()]).toEqual(['real-session']);
  });
});

describe('one-shot execution path', () => {
  // INVARIANT: a one-shot runs as its own `claude -p` process and NEVER attaches
  // to an existing session. `--resume`/`--continue` are the only flags that could
  // make housekeeping execute inside a human's conversation, so their absence is
  // the contract worth pinning — not an implementation detail.
  test('is always `claude -p` and never resumes a session', () => {
    const args = buildOneshotArgs('summarize the task', 'opus', { readOnly: true });
    expect(args[0]).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--session-id');
  });

  // The marker is applied at the source, by the one-shot runner itself. If it
  // ever stops being applied, every housekeeping run silently becomes a
  // "conversation" again — and every filter above goes blind at once.
  test('marks its prompt at the head', () => {
    const args = buildOneshotArgs('summarize the task');
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt.startsWith(ONESHOT_MARKER)).toBe(true);
  });

  // INVARIANT: the fidelity summarizer's ONLY agent entry point is the one-shot
  // runner. Source-level because the seam is which function it calls, and a
  // module mock of src/capture/claude leaks process-wide across test files.
  // If this ever needs to change, the question to answer first is "whose session
  // does the summary now run in?".
  test('ClaudeSummarizer calls runClaudeOneshot and nothing else', async () => {
    const src = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'synthesis', 'summarizer.ts'),
      'utf-8',
    );
    expect(src).toContain('runClaudeOneshot');
    // `runClaude(` / `runClaudeInteractive` / `--resume` would each put the
    // summary inside somebody's existing session.
    expect(src).not.toMatch(/\brunClaude\s*\(/);
    expect(src).not.toContain('runClaudeInteractive');
    expect(src).not.toContain('--resume');
  });
});
