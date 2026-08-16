/**
 * Drift guard: no surface may advise a call that its own schema rejects.
 *
 * `lazy_resume`'s description used to read "use lazy_unblock with empty
 * feedback instead" while `lazy_unblock`'s schema declares
 * `feedback: { minLength: 1 }` and lists it in `required` — so the advised
 * call is rejected during argument validation and never reaches a handler.
 * The builder system prompt and `lazy resume`'s CLI notice carried the same
 * impossible advice.
 *
 * The resolution was to keep unblock strict (the CLI rejects empty feedback
 * too — `src/cli/commands/unblock.ts`) and correct the advice, so these tests
 * assert BOTH halves: the strictness stays, and nothing advertises around it.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { allTools, resumeTool, unblockTool } from '../../src/mcp/tools';

const REPO_ROOT = resolve(__dirname, '../..');

/** Phrases that would only ever mean "call unblock with no real feedback". */
const IMPOSSIBLE_ADVICE = [
  /unblock\s+with\s+empty\s+feedback/i,
  /unblock\s+with\s+no\s+feedback/i,
  /unblock\s*\([^)]*feedback\s*[:=]\s*['"]{2}/i,
  /unblock\s+.*\bwith\s+or\s+without\s+feedback/i,
  /unblock\b[^.]*\bwith\s+no\s+--message/i,
];

describe('resume/unblock advice honesty', () => {
  // INVARIANT: unblock's feedback is required and non-empty. This is the half
  // the advice has to respect — do not relax it to make some doc string true.
  test('lazy_unblock requires non-empty feedback', () => {
    const schema = unblockTool.inputSchema as {
      required?: string[];
      properties?: Record<string, { minLength?: number }>;
    };
    expect(schema.required).toContain('feedback');
    expect(schema.properties?.feedback?.minLength).toBe(1);
  });

  test('lazy_resume describes itself as the no-feedback resume', () => {
    expect(resumeTool.description).toMatch(/without new feedback/i);
  });

  test('no MCP tool description advises an empty-feedback unblock', () => {
    for (const tool of allTools) {
      for (const pattern of IMPOSSIBLE_ADVICE) {
        expect(`${tool.name}: ${tool.description}`).not.toMatch(pattern);
      }
    }
  });

  test('the builder system prompt does not advise an empty-feedback unblock', async () => {
    const prompt = await readFile(
      resolve(REPO_ROOT, 'src/prompts/builder-system-prompt.md'),
      'utf-8',
    );
    for (const pattern of IMPOSSIBLE_ADVICE) {
      expect(prompt).not.toMatch(pattern);
    }
  });

  test('the lazy resume CLI notice does not advise an empty-feedback unblock', async () => {
    const source = await readFile(
      resolve(REPO_ROOT, 'src/cli/commands/resume.ts'),
      'utf-8',
    );
    // Only the console notice matters, but scanning the whole file also catches
    // the advice migrating into help text.
    for (const pattern of IMPOSSIBLE_ADVICE) {
      expect(source).not.toMatch(pattern);
    }
  });
});
