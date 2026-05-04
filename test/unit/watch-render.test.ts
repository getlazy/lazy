/**
 * Unit tests for the JSONL rendering logic in lazy watch.
 *
 * Tests every exported function from watch-renderer.ts: separators,
 * shortenPath, formatToolCall (each tool type), formatToolResult
 * (success/error/long), and renderEntry (assistant, user, tool_result,
 * thinking, skipped types).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { stripAnsi } from '../../src/cli/theme';
import {
  thinkingSeparatorOpen,
  thinkingSeparatorClose,
  responseSeparatorOpen,
  responseSeparatorClose,
  shortenPath,
  formatToolCall,
  formatToolResult,
  renderEntry,
  type RawContentBlock,
  type RawLogEntry,
} from '../../src/cli/watch-renderer';

// ── Console capture helper ──────────────────────────────────────────────

let captured: string[] = [];
const originalLog = console.log;

function startCapture() {
  captured = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
}

function stopCapture(): string[] {
  console.log = originalLog;
  const result = captured;
  captured = [];
  return result;
}

/** Stop capturing and return all output joined, with ANSI stripped. */
function capturedPlain(): string {
  return stopCapture().map(stripAnsi).join('\n');
}

afterEach(() => {
  // Safety net: always restore console.log even if a test fails mid-capture
  console.log = originalLog;
});

// ── Separator tests ─────────────────────────────────────────────────────

describe('separators', () => {
  test('thinkingSeparatorOpen contains "Thinking" label', () => {
    const plain = stripAnsi(thinkingSeparatorOpen());
    expect(plain).toContain('Thinking');
    expect(plain).toContain('───');
  });

  test('thinkingSeparatorClose is a solid line', () => {
    const plain = stripAnsi(thinkingSeparatorClose());
    expect(plain).toMatch(/^─+$/);
    expect(plain.length).toBe(60);
  });

  test('responseSeparatorOpen contains "Response" label', () => {
    const plain = stripAnsi(responseSeparatorOpen());
    expect(plain).toContain('Response');
    expect(plain).toContain('───');
  });

  test('responseSeparatorClose is a solid line', () => {
    const plain = stripAnsi(responseSeparatorClose());
    expect(plain).toMatch(/^─+$/);
    expect(plain.length).toBe(60);
  });
});

// ── shortenPath tests ───────────────────────────────────────────────────

describe('shortenPath', () => {
  test('returns short paths unchanged', () => {
    expect(shortenPath('src/foo.ts')).toBe('src/foo.ts');
    expect(shortenPath('a/b/c')).toBe('a/b/c');
  });

  test('truncates long paths to last 3 segments', () => {
    expect(shortenPath('/Users/me/prg/lazy-dev/src/cli/watch.ts')).toBe('.../src/cli/watch.ts');
  });

  test('handles exactly 3 segments', () => {
    expect(shortenPath('a/b/c')).toBe('a/b/c');
  });

  test('handles 4 segments', () => {
    expect(shortenPath('a/b/c/d')).toBe('.../b/c/d');
  });
});

// ── formatToolCall tests ────────────────────────────────────────────────

describe('formatToolCall', () => {
  test('Read tool shows file path', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/Users/me/prg/project/src/foo.ts' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('▶');
    expect(plain).toContain('Read');
    expect(plain).toContain('.../project/src/foo.ts');
  });

  test('Read tool without path shows (file)', () => {
    const block: RawContentBlock = { type: 'tool_use', name: 'Read', input: {} };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Read');
    expect(plain).toContain('(file)');
  });

  test('Write tool shows file path', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Write',
      input: { file_path: 'src/new-file.ts' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Write');
    expect(plain).toContain('src/new-file.ts');
  });

  test('Edit tool shows path and old/new strings', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: 'src/cli/watch.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Edit');
    expect(plain).toContain('src/cli/watch.ts');
    expect(plain).toContain('- const x = 1;');
    expect(plain).toContain('+ const x = 2;');
  });

  test('Edit tool without old/new strings omits diff', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: 'src/foo.ts' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Edit');
    expect(plain).not.toContain('- ');
    expect(plain).not.toContain('+ ');
  });

  test('MultiEdit tool shows path', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'MultiEdit',
      input: { file_path: 'src/foo.ts' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('MultiEdit');
    expect(plain).toContain('src/foo.ts');
  });

  test('Bash tool shows command', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'bun test test/unit/' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Bash');
    expect(plain).toContain('bun test test/unit/');
  });

  test('Bash tool truncates long commands', () => {
    const longCmd = 'a'.repeat(100);
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Bash',
      input: { command: longCmd },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('...');
    expect(plain.length).toBeLessThan(100);
  });

  test('Bash tool without command', () => {
    const block: RawContentBlock = { type: 'tool_use', name: 'Bash', input: {} };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Bash');
  });

  test('Grep tool shows pattern and path', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Grep',
      input: { pattern: 'TODO', path: 'src/' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Grep');
    expect(plain).toContain('"TODO"');
    expect(plain).toContain('src/');
  });

  test('Glob tool shows pattern', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Glob');
    expect(plain).toContain('**/*.ts');
  });

  test('Agent tool shows description', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Agent',
      input: { description: 'Explore codebase' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Agent');
    expect(plain).toContain('Explore codebase');
  });

  test('Task tool shows description (aliases to Agent display)', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'Task',
      input: { description: 'Run tests' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('Agent');
    expect(plain).toContain('Run tests');
  });

  test('TodoWrite tool', () => {
    const block: RawContentBlock = { type: 'tool_use', name: 'TodoWrite', input: {} };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('TodoWrite');
  });

  test('WebFetch tool shows URL', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'WebFetch',
      input: { url: 'https://example.com/api' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('WebFetch');
    expect(plain).toContain('https://example.com/api');
  });

  test('WebSearch tool shows query', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'WebSearch',
      input: { query: 'bun test runner' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('WebSearch');
    expect(plain).toContain('bun test runner');
  });

  test('MCP lazy tool strips prefix', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'mcp__lazy__lazy_search',
      input: { query: 'watch' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('lazy:lazy_search');
    expect(plain).not.toContain('mcp__lazy__');
  });

  test('unknown tool shows name and JSON input', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'CustomTool',
      input: { key: 'value' },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('CustomTool');
    expect(plain).toContain('"key"');
  });

  test('unknown tool truncates long JSON input', () => {
    const block: RawContentBlock = {
      type: 'tool_use',
      name: 'CustomTool',
      input: { key: 'x'.repeat(100) },
    };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('...');
  });

  test('tool with no name shows "unknown"', () => {
    const block: RawContentBlock = { type: 'tool_use', input: { foo: 1 } };
    const plain = stripAnsi(formatToolCall(block));
    expect(plain).toContain('unknown');
  });
});

// ── formatToolResult tests ──────────────────────────────────────────────

describe('formatToolResult', () => {
  test('returns null for empty content', () => {
    const block: RawContentBlock = { type: 'tool_result', content: '' };
    expect(formatToolResult(block)).toBeNull();
  });

  test('returns null when no content field', () => {
    const block: RawContentBlock = { type: 'tool_result' };
    expect(formatToolResult(block)).toBeNull();
  });

  test('shows short string results in full', () => {
    const block: RawContentBlock = {
      type: 'tool_result',
      content: 'line 1\nline 2\nline 3',
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('line 1');
    expect(plain).toContain('line 2');
    expect(plain).toContain('line 3');
  });

  test('shows medium results (under threshold) in full', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const block: RawContentBlock = {
      type: 'tool_result',
      content: lines.join('\n'),
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('line 1');
    expect(plain).toContain('line 50');
    expect(plain).not.toContain('omitted');
  });

  test('truncates very long results with head/tail and omission count', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const block: RawContentBlock = {
      type: 'tool_result',
      content: lines.join('\n'),
    };
    const plain = stripAnsi(formatToolResult(block)!);
    // Should show first 50 lines
    expect(plain).toContain('line 1');
    expect(plain).toContain('line 50');
    // Should show last 10 lines
    expect(plain).toContain('line 191');
    expect(plain).toContain('line 200');
    // Should show omission indicator
    expect(plain).toContain('140 lines omitted');
    // Should NOT show lines from the middle
    expect(plain).not.toContain('line 100\n');
  });

  test('shows error results with error marker', () => {
    const block: RawContentBlock = {
      type: 'tool_result',
      content: 'ENOENT: file not found',
      is_error: true,
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('✗ error');
    expect(plain).toContain('ENOENT: file not found');
  });

  test('shows full multi-line error text', () => {
    const block: RawContentBlock = {
      type: 'tool_result',
      content: 'Error: something broke\n  at foo.ts:10\n  at bar.ts:20',
      is_error: true,
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('something broke');
    expect(plain).toContain('foo.ts:10');
    expect(plain).toContain('bar.ts:20');
  });

  test('handles array content blocks (tool_result with nested text)', () => {
    const block: RawContentBlock = {
      type: 'tool_result',
      content: [
        { type: 'text', text: 'first part' },
        { type: 'text', text: 'second part' },
      ],
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('first part');
    expect(plain).toContain('second part');
  });

  test('skips non-text blocks in array content', () => {
    const block: RawContentBlock = {
      type: 'tool_result',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'tool_use', name: 'Read' } as RawContentBlock,
      ],
    };
    const plain = stripAnsi(formatToolResult(block)!);
    expect(plain).toContain('visible');
  });
});

// ── renderEntry tests ───────────────────────────────────────────────────

describe('renderEntry', () => {
  test('renders assistant thinking block', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me analyze this code...' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('Thinking');
    expect(plain).toContain('Let me analyze this code...');
  });

  test('renders assistant text response', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The bug is on line 42.' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('Response');
    expect(plain).toContain('The bug is on line 42.');
  });

  test('renders plain string assistant content', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: 'Simple text response',
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('Response');
    expect(plain).toContain('Simple text response');
  });

  test('renders tool_use in assistant message', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('▶');
    expect(plain).toContain('Read');
    expect(plain).toContain('src/foo.ts');
  });

  test('renders tool_result in assistant message', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_result', content: 'file contents here' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('file contents here');
  });

  test('renders mixed assistant content (thinking + tool + text)', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read the file first.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/main.ts' } },
          { type: 'text', text: 'Here is my analysis.' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('Thinking');
    expect(plain).toContain('I should read the file first.');
    expect(plain).toContain('Read');
    expect(plain).toContain('src/main.ts');
    expect(plain).toContain('Response');
    expect(plain).toContain('Here is my analysis.');
  });

  test('closes thinking separator before tool call', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking...' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture().map(stripAnsi);
    // The close separator (solid line) should appear before the tool call
    const closeSepIdx = lines.findIndex(l => /^─{60}$/.test(l));
    const toolIdx = lines.findIndex(l => l.includes('Bash'));
    expect(closeSepIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(closeSepIdx);
  });

  test('closes response separator before tool call', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'some text' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'f.ts' } },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture().map(stripAnsi);
    const responseSepOpenIdx = lines.findIndex(l => l.includes('Response'));
    const closeSepIdx = lines.findIndex((l, i) => i > responseSepOpenIdx && /^─{60}$/.test(l));
    const toolIdx = lines.findIndex(l => l.includes('Read'));
    expect(closeSepIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(closeSepIdx);
  });

  test('renders user tool_result messages', () => {
    const entry: RawLogEntry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'result from tool' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('result from tool');
  });

  test('renders plain text user messages in full', () => {
    const entry: RawLogEntry = {
      type: 'user',
      message: {
        role: 'user',
        content: 'Fix the authentication bug in accept.ts',
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    expect(plain).toContain('▷');
    expect(plain).toContain('Fix the authentication bug in accept.ts');
  });

  test('renders long user messages without truncation', () => {
    const longMessage = 'A'.repeat(1000);
    const entry: RawLogEntry = {
      type: 'user',
      message: {
        role: 'user',
        content: longMessage,
      },
    };
    startCapture();
    renderEntry(entry);
    const plain = capturedPlain();
    // The full 1000-char message should be present — no truncation
    expect(plain).toContain(longMessage);
  });

  test('skips empty user messages', () => {
    const entry: RawLogEntry = {
      type: 'user',
      message: {
        role: 'user',
        content: '   ',
      },
    };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('skips progress entries silently', () => {
    const entry: RawLogEntry = { type: 'progress', timestamp: '2025-01-01' };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('skips queue-operation entries silently', () => {
    const entry: RawLogEntry = { type: 'queue-operation', timestamp: '2025-01-01' };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('skips assistant entries with no message', () => {
    const entry: RawLogEntry = { type: 'assistant' };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('skips empty thinking blocks', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '   ' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('skips empty text blocks', () => {
    const entry: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
        ],
      },
    };
    startCapture();
    renderEntry(entry);
    const lines = stopCapture();
    expect(lines.length).toBe(0);
  });

  test('thinking block uses "thinking" field first, falls back to "text"', () => {
    const entryWithThinking: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'from thinking field' }],
      },
    };
    startCapture();
    renderEntry(entryWithThinking);
    let plain = capturedPlain();
    expect(plain).toContain('from thinking field');

    const entryWithText: RawLogEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'from text field' }],
      },
    };
    startCapture();
    renderEntry(entryWithText);
    plain = capturedPlain();
    expect(plain).toContain('from text field');
  });
});

// ── watchUsage tests (via watch.ts) ─────────────────────────────────────

describe('watchUsage', () => {
  test('watch module exports commandWatch and watchUsage', async () => {
    const watchModule = await import('../../src/cli/commands/watch');
    expect(typeof watchModule.commandWatch).toBe('function');
    expect(typeof watchModule.watchUsage).toBe('function');
  });

  test('does not require tmux', async () => {
    const { watchUsage } = await import('../../src/cli/commands/watch');
    startCapture();
    watchUsage();
    const output = capturedPlain();
    expect(output).not.toContain('tmux must be installed');
    expect(output).toContain('real-time');
    expect(output).toContain('JSONL');
  });

  test('mentions Ctrl-C', async () => {
    const { watchUsage } = await import('../../src/cli/commands/watch');
    startCapture();
    watchUsage();
    const output = capturedPlain();
    expect(output).toContain('Ctrl-C');
  });
});
