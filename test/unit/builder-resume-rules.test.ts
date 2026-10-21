import { describe, test, expect } from 'bun:test';
import { decideBuilderResume } from '../../src/builder/resume-rules';
import type { BuilderSummary } from '../../src/storage/types';

function builder(over: Partial<BuilderSummary> = {}): BuilderSummary {
  return {
    memberEmail: 'alice@example.com',
    id: 'seg-1',
    title: 'Plan the release',
    startedAt: null,
    endedAt: null,
    gitBranch: null,
    segments: ['seg-1', 'seg-2'],
    stats: { messageCount: 2, userMessageCount: 1, assistantMessageCount: 1, subagentCount: 0, totalTokens: 0 },
    importedAt: 0,
    run: null,
    ...over,
  };
}

describe('decideBuilderResume', () => {
  // INVARIANT: a resume continues the Builder's NEWEST segment. Resuming the
  // first one would branch the conversation from where it began, dropping every
  // later turn the member had.
  test('your own Builder resumes from its newest segment', () => {
    expect(decideBuilderResume(builder(), 'Alice@Example.com', true)).toEqual({ kind: 'own', sessionId: 'seg-2' });
  });

  // INVARIANT: a teammate's Builder is refused, naming its owner. Its session
  // file carries every command it ran and their output, which the transcript the
  // Builders page shows does not — copying it would expose more than the page.
  test("a teammate's Builder is refused and the refusal says whose it is and why", () => {
    const d = decideBuilderResume(builder(), 'bob@example.com', true);
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.status).toBe(403);
    expect(d.message).toContain("alice@example.com's");
    expect(d.message).toContain('commands it ran');
  });

  test('a Builder nobody owns is not yours on a multi-member daemon', () => {
    const d = decideBuilderResume(builder({ memberEmail: null }), 'bob@example.com', true);
    expect(d).toMatchObject({ kind: 'refuse', status: 403 });
  });

  test('with nobody else on the daemon every Builder is yours', () => {
    expect(decideBuilderResume(builder({ memberEmail: null }), null, false)).toEqual({ kind: 'own', sessionId: 'seg-2' });
  });

  test('a Builder with no segment cannot be resumed', () => {
    expect(decideBuilderResume(builder({ segments: [] }), 'alice@example.com', true)).toMatchObject({ kind: 'refuse', status: 409 });
  });
});

describe('holdsBuilderSessionFile', () => {
  const { mkdtemp, mkdir, writeFile, rm } = require('fs/promises') as typeof import('fs/promises');
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const { holdsBuilderSessionFile } = require('../../src/builder/projects-isolation') as typeof import('../../src/builder/projects-isolation');
  const { encodeProjectPath } = require('../../src/import/claude-code-logs') as typeof import('../../src/import/claude-code-logs');

  // INVARIANT: the check asks every place a resume launch would find the file —
  // a run dir under the member's root AND the member home's own projects dir —
  // or a conversation still on the server is refused as gone.
  test('finds a session in a run dir, in the home projects dir, and nowhere else', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-holds-session-'));
    try {
      const lazyRoot = '/repo/project';
      const enc = encodeProjectPath(lazyRoot);
      const home = join(base, 'home');
      const root = join(home, 'builder-projects');
      await mkdir(join(root, 'run1', enc), { recursive: true });
      await writeFile(join(root, 'run1', enc, 'in-run.jsonl'), '{}\n');
      await mkdir(join(home, '.claude', 'projects', enc), { recursive: true });
      await writeFile(join(home, '.claude', 'projects', enc, 'in-home.jsonl'), '{}\n');

      expect(await holdsBuilderSessionFile(root, lazyRoot, 'in-run', home)).toBe(true);
      expect(await holdsBuilderSessionFile(root, lazyRoot, 'in-home', home)).toBe(true);
      expect(await holdsBuilderSessionFile(root, lazyRoot, 'gone', home)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
