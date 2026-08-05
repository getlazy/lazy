/**
 * Unit tests for the proxy request extractor.
 * Tests the classifyEndpoint, tierGuess, and extractRequest functions.
 */

import { describe, test, expect } from 'bun:test';
import { classifyEndpoint, tierGuess, extractRequest } from '../../src/proxy/extractor';

describe('classifyEndpoint', () => {
  test('classifies /v1/messages', () => {
    expect(classifyEndpoint('/v1/messages')).toBe('messages');
    expect(classifyEndpoint('/v1/messages?beta=true')).toBe('messages');
  });

  test('classifies count_tokens before messages', () => {
    expect(classifyEndpoint('/v1/messages/count_tokens')).toBe('count_tokens');
    expect(classifyEndpoint('/v1/messages?count_tokens')).toBe('count_tokens');
  });

  test('classifies other paths', () => {
    expect(classifyEndpoint('/v1/complete')).toBe('other');
    expect(classifyEndpoint('/health')).toBe('other');
  });
});

describe('tierGuess', () => {
  test('guesses haiku', () => expect(tierGuess('claude-haiku-4-5')).toBe('haiku'));
  test('guesses sonnet', () => expect(tierGuess('claude-sonnet-4-6')).toBe('sonnet'));
  test('guesses opus', () => expect(tierGuess('claude-opus-4-8')).toBe('opus'));
  test('returns other for unknown', () => expect(tierGuess('qwen3.5:35b')).toBe('other'));
  test('returns null for null', () => expect(tierGuess(null)).toBeNull());
  test('returns null for undefined', () => expect(tierGuess(undefined)).toBeNull());
});

describe('extractRequest', () => {
  test('handles null body', () => {
    const r = extractRequest('/v1/messages', null);
    expect(r.model).toBeNull();
    expect(r.stream).toBeNull();
    expect(r.endpoint).toBe('messages');
    expect(r.toolUses).toHaveLength(0);
    expect(r.toolResults).toHaveLength(0);
    expect(r.requestShape).not.toBeNull();
  });

  test('handles non-messages endpoint', () => {
    const r = extractRequest('/health', {});
    expect(r.endpoint).toBe('other');
    expect(r.requestShape).toBeNull();
  });

  test('extracts basic request shape', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 4096,
      system: 'You are a helpful assistant',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ name: 'Read', description: 'Read file' }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.stream).toBe(true);
    expect(r.tier).toBe('sonnet');
    expect(r.requestShape?.hasSystem).toBe(true);
    expect(r.requestShape?.systemLen).toBe('You are a helpful assistant'.length);
    expect(r.requestShape?.numMessages).toBe(1);
    expect(r.requestShape?.messageRoles).toEqual(['user']);
    expect(r.requestShape?.numTools).toBe(1);
    expect(r.requestShape?.toolNames).toEqual(['Read']);
    expect(r.requestShape?.maxTokens).toBe(4096);
    expect(r.requestShape?.bodyBytes).toBe(0); // caller fills this in
  });

  test('extracts array system block length', () => {
    const body = {
      system: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }],
      messages: [],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.requestShape?.systemLen).toBe(5); // 'abc'.length + 'de'.length
  });

  test('extracts tool_use blocks', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { path: '/tmp/test.txt' },
            },
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'echo hello' },
            },
          ],
        },
      ],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolUses).toHaveLength(2);
    expect(r.toolUses[0]).toMatchObject({
      id: 'tool-1',
      name: 'Read',
      path: '/tmp/test.txt',
      command: null,
      target: null,
      connector: false,
    });
    expect(r.toolUses[1]).toMatchObject({
      id: 'tool-2',
      name: 'Bash',
      path: null,
      command: 'echo hello',
      connector: false,
    });
  });

  test('extracts WebFetch tool target', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'wf-1',
          name: 'WebFetch',
          input: { url: 'https://example.com' },
        }],
      }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolUses[0].target).toBe('https://example.com');
  });

  test('marks mcp__claude_ai_ tools as connectors', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'conn-1',
          name: 'mcp__claude_ai__gmail__search',
          input: { query: 'from:boss' },
        }],
      }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolUses[0].connector).toBe(true);
    expect(r.toolUses[0].target).toBe('from:boss');
  });

  test('extracts tool_result blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              is_error: false,
              content: 'This is a message to the tester.',
            },
          ],
        },
      ],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolResults).toHaveLength(1);
    expect(r.toolResults[0]).toMatchObject({
      toolUseId: 'tool-1',
      isError: false,
      contentPreview: 'This is a message to the tester.',
      contentLen: 'This is a message to the tester.'.length,
    });
  });

  test('extracts tool_result with array content', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-2',
          is_error: true,
          content: [
            { type: 'text', text: 'Error: ' },
            { type: 'text', text: 'not found' },
          ],
        }],
      }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolResults[0].isError).toBe(true);
    expect(r.toolResults[0].contentPreview).toBe('Error: not found');
  });

  test('truncates long tool input previews', () => {
    const longInput = 'x'.repeat(600);
    const body = {
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 't1',
          name: 'Write',
          input: { path: '/tmp/big.txt', content: longInput },
        }],
      }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolUses[0].inputPreview.endsWith('…')).toBe(true);
    expect(r.toolUses[0].inputPreview.length).toBeLessThanOrEqual(514); // 512 + '…'
  });

  test('truncates long tool result content previews', () => {
    const longContent = 'a'.repeat(400);
    const body = {
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: longContent,
        }],
      }],
    };
    const r = extractRequest('/v1/messages', body);
    expect(r.toolResults[0].contentPreview.endsWith('…')).toBe(true);
    expect(r.toolResults[0].contentLen).toBe(400);
  });

  test('handles count_tokens endpoint', () => {
    const r = extractRequest('/v1/messages/count_tokens', { messages: [], model: 'claude-opus-4-8' });
    expect(r.endpoint).toBe('count_tokens');
    expect(r.requestShape).not.toBeNull();
    expect(r.model).toBe('claude-opus-4-8');
  });
});
