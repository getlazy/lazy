import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CLAUDE_DEFAULT_MODEL, CODEX_LATEST_MODEL, CURSOR_DEFAULT_MODEL } from '../../src/config/default-models';
import { DEFAULT_CONFIG, getDefaultConfigTemplate } from '../../src/config/loader';
import { CodexAgent } from '../../src/agent/codex';
import { CursorAgent } from '../../src/agent/cursor';
import { startUsage } from '../../src/cli/commands/start';
import { DEFAULT_COUNT_TOKENS_MODEL } from '../../src/utils/token-count';

const ROOT = join(import.meta.dir, '..', '..');

// INVARIANT: every surface naming a built-in default model reads it from
// src/config/default-models.ts or states the same id. "Default model
// everywhere" drifted before (claude-opus-5 lingered after 5.5 shipped, and
// Anthropic does not resolve the family name to 5.5).
describe('built-in default models stay in one place', () => {
  test('config, template and token counting use the Claude default', () => {
    expect(DEFAULT_CONFIG.models.default).toBe(CLAUDE_DEFAULT_MODEL);
    expect(DEFAULT_COUNT_TOKENS_MODEL).toBe(CLAUDE_DEFAULT_MODEL);
    expect(getDefaultConfigTemplate()).toContain(`default = "${CLAUDE_DEFAULT_MODEL}"`);
  });

  test('agents declare the harness defaults', () => {
    expect(new CodexAgent().defaultModel()).toBe(CODEX_LATEST_MODEL);
    expect(new CursorAgent().defaultModel()).toBe(CURSOR_DEFAULT_MODEL);
  });

  test('lazy.toml.example states the Claude default', async () => {
    const example = await readFile(join(ROOT, 'lazy.toml.example'), 'utf-8');
    expect(example).toContain(`default = "${CLAUDE_DEFAULT_MODEL}"`);
    expect(example).toContain(`built-in default when this key is absent: "${CLAUDE_DEFAULT_MODEL}"`);
    expect(example).toContain(`a Cursor task runs \`${CURSOR_DEFAULT_MODEL}\`,\n# Cursor's own choice`);
    expect(example).toContain(`a Codex task \`${CODEX_LATEST_MODEL}\``);
  });

  test('lazy start --help names every default', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { startUsage(); } finally { console.log = orig; }
    const help = lines.join('\n');
    expect(help).toContain(`Cursor: "${CURSOR_DEFAULT_MODEL}" — Cursor picks; Codex: "${CODEX_LATEST_MODEL}"`);
    expect(help).toContain(`Built-in default (${CLAUDE_DEFAULT_MODEL})`);
  });

  test('public docs state every default', async () => {
    const doc = await readFile(join(ROOT, 'public-docs', 'lazy-toml.md'), 'utf-8');
    expect(doc).toContain(`| \`default\` | \`string\` | \`"${CLAUDE_DEFAULT_MODEL}"\``);
    expect(doc).toContain(`(Cursor: \`${CURSOR_DEFAULT_MODEL}\`, Cursor picks; Codex: \`${CODEX_LATEST_MODEL}\``);
  });
});
