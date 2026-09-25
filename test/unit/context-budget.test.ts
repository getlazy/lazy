/**
 * What a session costs before its first message — the measurement half.
 *
 * The rendering lives in `lazy doctor` and is covered end-to-end in
 * test/e2e/doctor.test.ts; these tests pin the parts a display layer must not
 * be allowed to re-derive: which files count for which role, where Claude
 * Code's per-file limit sits and what it means, and the nesting rule that keeps
 * the shared-memory index from being charged twice.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  CLAUDE_MD_CHAR_LIMIT,
  CLAUDE_MD_LIMIT_CHARS_PER_TOKEN,
  CLAUDE_MD_LIMIT_FLOOR,
  CLAUDE_MD_LIMIT_VERIFIED_VERSION,
  CLAUDE_MD_LIMIT_WINDOW_FRACTION,
  CONTEXT_BUDGET_WARN_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  claudeMdCharLimit,
  contextBudgetRemedy,
  contextBudgetWarnTokens,
  findClaudeMemoryFiles,
  largestTrimmable,
  measureText,
  serializedToolSurface,
  summarizeContextBudgetRole,
  windowForRole,
  type ContextContributor,
} from '../../src/context-budget';
import { toolNamesForRole } from '../../src/mcp/tool-surface';
import { LARGE_CONTEXT_WINDOW_TOKENS } from '../../src/agent/context-window';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import type { ResolvedConfig, RoleTarget } from '../../src/config/types';

describe('context budget — Claude Code memory file limit', () => {
  // INVARIANT: the limit is the FORMULA read out of the shipped Claude Code
  // bundle — max(40000, round(window * 0.05 * 4)) — not the 40,000 that formula
  // happens to produce today. The version is pinned alongside it because the
  // formula was read from one release and nothing in lazy detects a change:
  // Dockerfile.lazy installs Claude Code unpinned. If any of these four values
  // changes, it changes because someone re-read the bundle.
  test('the formula and the release it was verified against are pinned together', () => {
    expect(CLAUDE_MD_LIMIT_VERIFIED_VERSION).toBe('2.1.266');
    expect(CLAUDE_MD_LIMIT_FLOOR).toBe(40_000);
    expect(CLAUDE_MD_LIMIT_WINDOW_FRACTION).toBe(0.05);
    expect(CLAUDE_MD_LIMIT_CHARS_PER_TOKEN).toBe(4);
  });

  test('at lazy’s assumed 200k window the formula lands on the 40,000 floor', () => {
    expect(claudeMdCharLimit(200_000)).toBe(40_000);
    expect(CLAUDE_MD_CHAR_LIMIT).toBe(40_000);
  });

  // INVARIANT: the limit is derived from the window, never hardcoded. A 1M
  // window raises Claude Code's limit to 200,000 — a doctor that warned "over
  // the 40,000-char limit" there would be reporting a warning the harness never
  // emits, on the one line this section exists to surface early.
  test('a larger window raises the limit rather than leaving it at 40,000', () => {
    expect(claudeMdCharLimit(1_000_000)).toBe(200_000);
    expect(claudeMdCharLimit(500_000)).toBe(100_000);
  });

  test('the floor holds for windows small enough to fall below it', () => {
    expect(claudeMdCharLimit(100_000)).toBe(40_000);
    expect(claudeMdCharLimit(0)).toBe(40_000);
  });

  test('the advisory is a fifth of the reported window', () => {
    expect(CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(CONTEXT_BUDGET_WARN_TOKENS).toBe(40_000);
    expect(contextBudgetWarnTokens(1_000_000)).toBe(200_000);
  });
});

describe('context budget — CLAUDE.md discovery', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-context-budget-'));
    root = join(base, 'project');
    home = join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  test('reports nothing when the project has no memory files', async () => {
    expect(await findClaudeMemoryFiles('agent', { lazyRoot: root, home })).toEqual([]);
  });

  test('finds project, .claude/ and local memory files with exact sizes', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'a'.repeat(120));
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude', 'CLAUDE.md'), 'b'.repeat(30));
    await writeFile(join(root, 'CLAUDE.local.md'), 'c'.repeat(7));

    const found = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });
    expect(found.map(f => f.label)).toEqual([
      'CLAUDE.md (project)',
      'CLAUDE.md (project, .claude/)',
      'CLAUDE.local.md (project)',
    ]);
    expect(found.map(f => f.content.length)).toEqual([120, 30, 7]);
    expect(found.every(f => !f.overLimit)).toBe(true);
  });

  // INVARIANT: the builder container mounts the human's ~/.claude, task
  // containers are handed a fresh one. Charging an agent for the user-level
  // CLAUDE.md would invent a cost it does not pay.
  test('only the builder is charged for the user-level CLAUDE.md', async () => {
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'user memory');

    const builder = await findClaudeMemoryFiles('builder', { lazyRoot: root, home });
    const agent = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });

    expect(builder.map(f => f.label)).toContain('CLAUDE.md (user, ~/.claude)');
    expect(agent).toEqual([]);
  });

  test('flags a file over the limit, and one exactly at it is not over', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(CLAUDE_MD_CHAR_LIMIT));
    let [file] = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });
    expect(file!.overLimit).toBe(false);

    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(CLAUDE_MD_CHAR_LIMIT + 1));
    [file] = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });
    expect(file!.overLimit).toBe(true);
  });

  // INVARIANT: the limit is per FILE, not a sum. Two 30k files are both fine
  // even though they total 60k — Claude Code compares each file on its own.
  test('the limit applies per file, never to the sum', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(30_000));
    await writeFile(join(root, 'CLAUDE.local.md'), 'y'.repeat(30_000));

    const found = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });
    expect(found).toHaveLength(2);
    expect(found.every(f => !f.overLimit)).toBe(true);
  });

  // INVARIANT: each file carries the limit it was judged against, and that
  // limit follows the window. A caller rendering "over the N-char limit" must
  // read N off the file rather than off a constant that assumed 200k.
  test('the reported limit follows the window the caller asked about', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(120_000));

    const [atDefault] = await findClaudeMemoryFiles('agent', { lazyRoot: root, home });
    expect(atDefault!.limit).toBe(40_000);
    expect(atDefault!.overLimit).toBe(true);

    const [atMillion] = await findClaudeMemoryFiles('agent', {
      lazyRoot: root,
      home,
      windowTokens: 1_000_000,
    });
    expect(atMillion!.limit).toBe(200_000);
    expect(atMillion!.overLimit).toBe(false);
  });
});

describe('context budget — measurement', () => {
  test('characters are exact and tokens come from the shared estimator', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    const measured = await measureText(text);

    expect(measured.chars).toBe(text.length);
    expect(measured.method).toBe('bpe');
    // A real tokenizer, not chars/4: prose costs well under a quarter-token
    // per character, which is the whole reason the heuristic was replaced.
    expect(measured.tokens).toBeGreaterThan(0);
    expect(measured.tokens).toBeLessThan(text.length / 4);
  });

  test('empty text costs nothing', async () => {
    expect(await measureText('')).toMatchObject({ chars: 0, tokens: 0 });
  });

  test('the tool surface is a real, non-trivial payload', async () => {
    const tools = serializedToolSurface('builder');
    expect(tools.count).toBeGreaterThan(10);
    // The tool schemas are the largest single thing lazy adds; if this ever
    // measured as tiny, the serialization stopped seeing the descriptions.
    expect(tools.text.length).toBeGreaterThan(10_000);
  });

  // The two roles are advertised different tool lists, so a single shared
  // measurement would misreport both. Neither is served the other's tools.
  //
  // Compared as NAME SETS, not as counts: the two exclusive lists happen to be
  // the same length today (7 each), so a count comparison says "shared list"
  // about two genuinely different surfaces. The sets catch that and also catch
  // everything differing counts would have.
  test('each role is measured on its own tool list', async () => {
    const builder = serializedToolSurface('builder');
    const agent = serializedToolSurface('agent');
    expect(new Set(toolNamesForRole('builder'))).not.toEqual(
      new Set(toolNamesForRole('agent')),
    );
    expect(builder.text).not.toBe(agent.text);
    expect(builder.text).not.toContain('"lazy_report"');
    expect(agent.text).not.toContain('"lazy_memory_save"');
  });
});

describe('context budget — totals', () => {
  const contributor = (over: Partial<ContextContributor>): ContextContributor => ({
    label: 'thing',
    chars: 100,
    tokens: 25,
    ...over,
  });

  // INVARIANT: a `nested` contributor breaks down a line already counted (the
  // shared-memory index inside the system prompt). Adding it to the total
  // would charge that memory twice and inflate every reported percentage.
  test('nested contributors are shown but never added to the total', () => {
    const role = summarizeContextBudgetRole(
      'agent',
      [
        contributor({ label: 'lazy system prompt', chars: 1000, tokens: 250 }),
        contributor({ label: 'of which shared memory index', chars: 400, tokens: 100, nested: true }),
        contributor({ label: 'MCP tool schemas (5 tools)', chars: 600, tokens: 150 }),
      ],
      'bpe',
    );

    expect(role.totalChars).toBe(1600);
    expect(role.totalTokens).toBe(400);
    expect(role.contributors).toHaveLength(3);
  });

  test('the advisory fires only above the threshold', () => {
    const at = summarizeContextBudgetRole(
      'builder',
      [contributor({ tokens: CONTEXT_BUDGET_WARN_TOKENS })],
      'bpe',
    );
    expect(at.overAdvisory).toBe(false);

    const over = summarizeContextBudgetRole(
      'builder',
      [contributor({ tokens: CONTEXT_BUDGET_WARN_TOKENS + 1 })],
      'bpe',
    );
    expect(over.overAdvisory).toBe(true);
  });

  // INVARIANT: the advisory is a fifth of THIS role's window, not of a
  // hardcoded 200k. A 40,001-token injection is over a fifth of a 200k session
  // and four percent of a 1M one — only the first is worth a line.
  test('the advisory follows the role window, not a 200k constant', () => {
    const injection = [contributor({ tokens: 40_001 })];
    const at200k = summarizeContextBudgetRole('builder', injection, 'bpe');
    expect(at200k.windowTokens).toBe(200_000);
    expect(at200k.overAdvisory).toBe(true);

    const at1m = summarizeContextBudgetRole('builder', injection, 'bpe', {
      tokens: LARGE_CONTEXT_WINDOW_TOKENS,
      known: true,
      reason: 'test',
    });
    expect(at1m.windowTokens).toBe(1_000_000);
    expect(at1m.overAdvisory).toBe(false);
  });
});

describe('context budget — per-role window', () => {
  const configFor = (over: {
    default?: string;
    builder?: RoleTarget;
    agent?: RoleTarget;
    upstream?: string;
  } = {}): ResolvedConfig =>
    ({
      models: {
        default: over.default ?? 'claude-opus-5',
        roles: {
          builder: over.builder ?? { ...ANTHROPIC_DEFAULT_TARGET },
          agent: over.agent ?? { ...ANTHROPIC_DEFAULT_TARGET },
        },
      },
      proxy: { upstream: over.upstream ?? 'https://api.anthropic.com' },
    }) as unknown as ResolvedConfig;

  // INVARIANT: doctor reports the window the launch will actually get, not
  // the 200k constant it used to hardcode. The default Anthropic model is a
  // native-1M model and `[proxy] upstream` defaults to api.anthropic.com, so
  // after the first-party flag lands both roles get 1M. A doctor that still
  // printed 200k would be reporting the bug, not the session.
  test('the default Anthropic roles report a known 1M window', () => {
    const config = configFor();
    for (const role of ['builder', 'agent'] as const) {
      const w = windowForRole(role, config);
      expect(w.tokens).toBe(LARGE_CONTEXT_WINDOW_TOKENS);
      expect(w.known).toBe(true);
      expect(w.remedy).toBeUndefined();
    }
  });

  test('a 200k model is reported as 200k, not as a capped 1M', () => {
    const w = windowForRole('agent', configFor({ default: 'claude-sonnet-4-6' }));
    expect(w.tokens).toBe(CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(true);
    expect(w.remedy).toBeUndefined();
  });

  test('a redirected [proxy] upstream caps a native-1M model and names a remedy', () => {
    const w = windowForRole(
      'builder',
      configFor({ upstream: 'https://llm.internal.example.com' }),
    );
    expect(w.tokens).toBe(CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(true);
    expect(w.remedy).toBeDefined();
  });
});

describe('context budget — remedies', () => {
  const role = (contributors: ContextContributor[]) =>
    summarizeContextBudgetRole('agent', contributors, 'bpe');

  // INVARIANT: the remedy names something the human can actually change. The
  // MCP schemas and lazy's own prompt are lazy's surface — pointing at them
  // would be advice nobody can take.
  test('never points at lazy’s own prompt or tool schemas', () => {
    const budget = role([
      { label: 'lazy system prompt', chars: 90_000, tokens: 20_000 },
      { label: 'MCP tool schemas (50 tools)', chars: 80_000, tokens: 20_000 },
    ]);

    expect(largestTrimmable(budget)).toBeNull();
    expect(contextBudgetRemedy(budget)).toContain('nothing to do here');
  });

  test('names the biggest CLAUDE.md when that is the largest thing owned', () => {
    const budget = role([
      { label: 'CLAUDE.md (project)', chars: 42_000, tokens: 11_000 },
      { label: 'CLAUDE.local.md (project)', chars: 900, tokens: 200 },
      { label: 'of which shared memory index', chars: 4_000, tokens: 1_000, nested: true },
      { label: 'MCP tool schemas (50 tools)', chars: 80_000, tokens: 20_000 },
    ]);

    expect(largestTrimmable(budget)!.label).toBe('CLAUDE.md (project)');
    expect(contextBudgetRemedy(budget)).toContain('CLAUDE.md (project)');
  });

  test('points at the memory commands when shared memory is the largest', () => {
    const budget = role([
      { label: 'CLAUDE.md (project)', chars: 1_000, tokens: 250 },
      { label: 'of which shared memory index', chars: 30_000, tokens: 7_500, nested: true },
    ]);

    expect(contextBudgetRemedy(budget)).toContain('lazy memory compact');
  });

  // INVARIANT: LAZY.md is the PROJECT's own text, so it is trimmable — the
  // remedy may name it. Only lazy's own prompt and tool schemas are off limits,
  // because nobody can act on advice to shrink those.
  test('names LAZY.md when the project’s lazy instructions are the largest', () => {
    const budget = role([
      { label: 'CLAUDE.md (project)', chars: 1_000, tokens: 250 },
      { label: 'of which LAZY.md (project instructions)', chars: 30_000, tokens: 7_500, nested: true },
    ]);

    expect(largestTrimmable(budget)!.label).toContain('LAZY.md');
  });
});
