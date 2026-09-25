/**
 * The TUI that used to be `lazy review` now lives at `lazy browse`.
 * These are source scans so a rename revert shows up without running the TUI.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');

describe('lazy browse rename', () => {
  test('browse command is registered next to review in the dispatcher', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    expect(src).toContain("'browse':");
    expect(src).toContain('commandBrowse');
    expect(src).toContain('browseUsage');
    expect(src).toMatch(/review <task_id>\s+Run an agent review/);
    expect(src).toMatch(/browse <task_id>\s+TUI browser/);
  });

  test('browse usage still documents -i', () => {
    const src = readFileSync(join(ROOT, 'src/cli/commands/browse.ts'), 'utf8');
    expect(src).toContain('Usage: lazy browse <task_id> [-i]');
    expect(src).toContain("aliases: ['i']");
  });

  test('review usage is the agent-review verb', () => {
    const src = readFileSync(join(ROOT, 'src/cli/commands/review.ts'), 'utf8');
    expect(src).toContain('Usage: lazy review <task_id>');
    expect(src).toContain('--yes');
    expect(src).not.toContain('-i, --interactive');
  });
});
