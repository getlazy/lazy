import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { PROMPT_BUNDLE } from '../../src/prompts-bundle';

/**
 * These tests guard the compiled-mode source of truth for built-in prompts.
 *
 * `lazy system prompts` / `lazy show <prompt-code>` read live files from
 * src/prompts/ in dev, but a `bun build --compile` binary has no such directory
 * on disk and instead reads from the embedded PROMPT_BUNDLE (see
 * src/cli/commands/prompts.ts). The e2e suite runs in dev mode, so it can only
 * exercise the file-reading path — these unit tests cover the bundle so it
 * cannot silently drift from src/prompts/ and leave compiled binaries listing
 * stale or missing prompts.
 *
 * INVARIANT: PROMPT_BUNDLE is generated from src/prompts/*.md and must contain
 * exactly the top-level *.md files with byte-identical content. If this fails,
 * the generator (scripts/generate-prompt-bundle.ts) did not run or drifted.
 */
describe('PROMPT_BUNDLE (compiled-mode prompt source)', () => {
  const promptsDir = join(import.meta.dir, '..', '..', 'src', 'prompts');

  test('contains exactly the top-level *.md files from src/prompts/', async () => {
    const files = (await readdir(promptsDir)).filter(f => f.endsWith('.md')).sort();
    expect(Object.keys(PROMPT_BUNDLE).sort()).toEqual(files);
    // Sanity: this is a non-trivial set, not an accidentally-empty bundle.
    expect(files.length).toBeGreaterThan(0);
  });

  test('bundle content is byte-identical to the source files', async () => {
    for (const [filename, content] of Object.entries(PROMPT_BUNDLE)) {
      const onDisk = await readFile(join(promptsDir, filename), 'utf-8');
      expect(content).toBe(onDisk);
    }
  });

  test('does not include nested prompts (e.g. confirmations/*.md)', () => {
    // listBuiltinPrompts only surfaces top-level prompts; the bundle must match.
    for (const filename of Object.keys(PROMPT_BUNDLE)) {
      expect(filename).not.toContain('/');
    }
  });
});
