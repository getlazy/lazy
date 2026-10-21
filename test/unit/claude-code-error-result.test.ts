import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'claude-code', 'api-error-400.jsonl');

describe('Claude Code error-terminated result', () => {
  // INVARIANT: a result line with `is_error: true` is a FAILED turn, never a
  // successful one whose summary is the error text. The fixture is a real
  // `claude -p --output-format stream-json --verbose` run (2.1.300) against an
  // upstream answering 400 — note it reports `subtype: "success"`.
  test('the captured stream throws with the provider error text', async () => {
    const stdout = await readFile(FIXTURE, 'utf8');
    expect(() => new ClaudeCodeAgent().parseResponse(stdout)).toThrow(
      'Claude Code turn ended in error (HTTP 400): API Error: 400 upstream said no: model not served here',
    );
  });

  test('the isolated result line throws too', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n');
    expect(() => new ClaudeCodeAgent().parseResponse(lines[lines.length - 1]!)).toThrow('HTTP 400');
  });

  test('a successful result still parses', () => {
    const r = new ClaudeCodeAgent().parseResponse(
      JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's1' }),
    );
    expect(r.result).toBe('done');
  });
});
