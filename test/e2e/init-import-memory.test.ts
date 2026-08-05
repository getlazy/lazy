/**
 * e2e: `lazy init` offers to import Claude Code *harness memory* files as lazy
 * shared memory records, alongside the existing conversation-import offer.
 * Adopting lazy on a repo that already has harness memory should mean
 * inheriting it — not starting from scratch.
 *
 * INVARIANT: the offer is a prompt, never a silent write. It is skipped under
 * --non-interactive; on an interactive accept it imports through the store; on
 * a decline it prints the later-command hint (`lazy doctor --import-memory`).
 *
 * INVARIANT: the two halves of onboarding (conversations + memory) are ONE
 * step, under a single header — adopting lazy should feel like one "inherit
 * your history?" question, not two disjoint prompt blocks.
 *
 * Hermetic: HOME points at a temp dir seeded with a shared
 * `~/.claude/projects/<encoded-repo>/memory/<name>.md` (and optionally a
 * session `.jsonl`), so detection finds real on-disk history without touching
 * the developer's actual home. Mirrors init-import-conversation.test.ts.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { join, resolve } from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

async function runLazy(cwd: string, args: string[], envOverrides?: Record<string, string | undefined>) {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // A credential must be present for any command that may reach the daemon
    // (e.g. memory list → requireStorage). Matches the e2e harness.
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing', ...envOverrides },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function initGitRepo(cwd: string) {
  Bun.spawnSync(['git', 'init'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'Initial commit'], { cwd });
}

/** Seed a shared ~/.claude/projects session for `repoRoot` under `home`. */
async function seedSharedSession(home: string, repoRoot: string, sessionId: string): Promise<void> {
  const encoded = encodeProjectPath(repoRoot);
  const dir = join(home, '.claude', 'projects', encoded);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u0`,
      parentUuid: null,
      timestamp: '2026-07-01T10:00:00Z',
      sessionId,
      cwd: repoRoot,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: 'Inherited history from before lazy' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a0`,
      parentUuid: `${sessionId}-u0`,
      timestamp: '2026-07-01T10:00:05Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Now it is builder memory.' }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

/** Seed a shared ~/.claude/projects harness memory file for `repoRoot`. */
async function seedSharedMemory(
  home: string,
  repoRoot: string,
  name: string,
  body: string,
  description?: string,
): Promise<void> {
  const encoded = encodeProjectPath(repoRoot);
  const dir = join(home, '.claude', 'projects', encoded, 'memory');
  await mkdir(dir, { recursive: true });
  const content = [
    '---',
    `name: ${name}`,
    `description: ${description ?? `Seeded harness memory for ${name}`}`,
    'metadata:',
    '  type: project',
    '---',
    '',
    body,
    '',
  ].join('\n');
  await writeFile(join(dir, `${name}.md`), content, 'utf-8');
  // The harness's rendered index must NOT be imported as a record.
  await writeFile(join(dir, 'MEMORY.md'), `- [${name}](${name}.md) — hook\n`, 'utf-8');
}

describe('lazy init — inherit harness memory', () => {
  let tmpDir: string;
  let homeDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
  });

  test('offers conversations and harness memory as one step, and imports both on accept', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);
    await seedSharedSession(homeDir, tmpDir, 'cccccccc-2222-3333-4444-555555555555');
    await seedSharedMemory(homeDir, tmpDir, 'inherited-fact', 'The deploy script needs sudo.');

    // Interactive (forced TTY) with auto-accepted prompts.
    const result = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'accept',
      LAZY_TEST: undefined,
    });

    expect(result.exitCode).toBe(0);
    // INVARIANT: one coherent "inherit your history?" step naming both kinds,
    // not two disjoint prompt blocks.
    expect(result.stdout).toContain('This repo already has Claude Code history from before lazy.');
    expect(result.stdout).toContain('existing Claude Code session(s) for this repo');
    expect(result.stdout).toContain('1 Claude Code harness memory record(s) with no lazy counterpart');
    expect(result.stdout).toContain('Imported cccccccc');
    expect(result.stdout).toContain('Imported memory inherited-fact');
    expect(result.stdout).toContain('Imported 1 memory record(s) into lazy shared memory.');

    // Both actually reached the store.
    const convos = await runLazy(tmpDir, ['import-conversation', '--show-imported'], { HOME: homeDir });
    expect(convos.stdout).toContain('cccccccc');

    const memories = await runLazy(tmpDir, ['memory', 'list'], { HOME: homeDir });
    expect(memories.stdout).toContain('inherited-fact');
    // MEMORY.md is the harness's rendered index, not a record.
    expect(memories.stdout).not.toContain('MEMORY');
  });

  test('offers harness memory even with no conversations to import', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);
    await seedSharedMemory(homeDir, tmpDir, 'memory-only-fact', 'Prefer bun over npx here.');

    const result = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'accept',
      LAZY_TEST: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 Claude Code harness memory record(s) with no lazy counterpart');
    // No conversations on disk — that half of the offer stays silent.
    expect(result.stdout).not.toContain('existing Claude Code session(s)');
    expect(result.stdout).toContain('Imported memory memory-only-fact');

    const memories = await runLazy(tmpDir, ['memory', 'list'], { HOME: homeDir });
    expect(memories.stdout).toContain('memory-only-fact');
  });

  // INVARIANT: the memory offer is prompt-only. --non-interactive never writes.
  test('does not offer or import harness memory under --non-interactive', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);
    await seedSharedMemory(homeDir, tmpDir, 'silent-fact', 'Must not be imported silently.');

    const result = await runLazy(tmpDir, ['init', '--non-interactive'], { HOME: homeDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('harness memory record(s)');
    expect(result.stdout).not.toContain('silent-fact');

    const memories = await runLazy(tmpDir, ['memory', 'list'], { HOME: homeDir });
    expect(memories.stdout).not.toContain('silent-fact');
  });

  // INVARIANT: the importer is MECHANISTIC. Harness records were written by
  // another tool under another contract, so a description longer than lazy's
  // AUTHORING limit (200 chars, enforced by `lazy memory save` /
  // `lazy_memory_save`) must be imported VERBATIM — never rejected (that
  // discards curated knowledge — the exact loss this import repairs) and never
  // truncated (that mangles it). This shipped broken in v0.20 pre-release: five
  // real records were rejected at import for being "too long".
  test('a description over the authoring limit is imported verbatim', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);

    const longDescription =
      'This harness record carries a long, purposefully written description that runs past lazy\'s authoring limit ' +
      'because the agent that wrote it was working under a different contract, and shortening it here would destroy ' +
      'exactly the curated knowledge the import exists to rescue.';
    expect(longDescription.length).toBeGreaterThan(200);

    await seedSharedMemory(homeDir, tmpDir, 'long-desc-fact', 'The body still matters.', longDescription);

    const result = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'accept',
      LAZY_TEST: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported memory long-desc-fact');
    expect(result.stdout).toContain('Imported 1 memory record(s) into lazy shared memory.');
    // A curation hint, not a failure — the record is in the store either way.
    expect(result.stdout).toContain('descriptions longer than 200 characters');
    expect(result.stdout).toContain('long-desc-fact');

    // Stored VERBATIM: the whole description, byte for byte, not an ellipsis.
    const show = await runLazy(tmpDir, ['memory', 'show', 'long-desc-fact'], { HOME: homeDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(longDescription);
    expect(show.stdout).toContain('The body still matters.');
  });

  // INVARIANT: re-running the import is idempotent AND repairs an earlier
  // partial import — the records that previously failed must land, and the ones
  // already in the store must be skipped, not duplicated or clobbered.
  test('re-running --import-memory skips present records and imports the previously-rejected ones', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);
    await seedSharedMemory(homeDir, tmpDir, 'already-there', 'Imported on the first pass.');

    // First pass: init imports the short record.
    const init = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'accept',
      LAZY_TEST: undefined,
    });
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain('Imported memory already-there');

    // The record whose description made the old importer reject it.
    const longDescription = 'Rejected by the old importer for being ' + 'x'.repeat(200) + ' characters long.';
    await seedSharedMemory(homeDir, tmpDir, 'was-rejected', 'Never made it in.', longDescription);

    const rerun = await runLazy(tmpDir, ['doctor', '--import-memory', '--yes'], { HOME: homeDir });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toContain('Imported was-rejected');
    expect(rerun.stdout).toContain('1 imported, 1 already present');

    const show = await runLazy(tmpDir, ['memory', 'show', 'was-rejected'], { HOME: homeDir });
    expect(show.stdout).toContain(longDescription);

    // The already-present record survived untouched at revision 1.
    const first = await runLazy(tmpDir, ['memory', 'show', 'already-there'], { HOME: homeDir });
    expect(first.stdout).toContain('Imported on the first pass.');
  });

  test('declining the memory offer prints the later-command hint and imports nothing', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-init-memimport-'));
    homeDir = await mkdtemp(join(tmpdir(), 'lazy-init-memhome-'));
    initGitRepo(tmpDir);
    await seedSharedMemory(homeDir, tmpDir, 'declined-fact', 'Left on disk for later.');

    const result = await runLazy(tmpDir, ['init'], {
      HOME: homeDir,
      LAZY_FORCE_TTY: '1',
      LAZY_PROMPT_DEFAULTS: 'decline',
      LAZY_TEST: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 Claude Code harness memory record(s) with no lazy counterpart');
    expect(result.stdout).toContain('lazy doctor --import-memory');
    expect(result.stdout).not.toContain('Imported memory declined-fact');

    const memories = await runLazy(tmpDir, ['memory', 'list'], { HOME: homeDir });
    expect(memories.stdout).not.toContain('declined-fact');
  });
});
