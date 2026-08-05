/**
 * Unit tests for the response-rewriting enforcement layer (§6.2 / §6.3 layer 1).
 *
 * The fragile part of the policy plane is re-emitting a streaming response as SSE
 * without corrupting the conversation (spike §6.5). These tests pin:
 *   - SSE parse ↔ serialize round-trips faithfully
 *   - a denied tool_use is dropped and replaced by an explanatory text block
 *   - stop_reason is recomputed correctly (tool_use kept vs downgraded to end_turn)
 *   - when NOTHING is denied, the original bytes are forwarded UNTOUCHED
 */

import { describe, test, expect } from 'bun:test';
import {
  enforceResponseBody,
  parseSSEMessage,
  serializeSSEMessage,
} from '../../src/proxy/enforce';
import { defaultPolicyConfig, type ProxyPolicyConfig } from '../../src/proxy/policy';

function cfg(overrides: Partial<ProxyPolicyConfig> = {}): ProxyPolicyConfig {
  return { ...defaultPolicyConfig(), ...overrides };
}

/** Build a realistic Anthropic tool_use SSE stream for a single tool call. */
function toolUseSSE(name: string, input: Record<string, unknown>, id = 'toolu_1'): string {
  const inputJson = JSON.stringify(input);
  return [
    `event: message_start`,
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })}`,
    ``,
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check that.' } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    ``,
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: inputJson } })}`,
    ``,
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })}`,
    ``,
    `event: message_stop`,
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ``,
  ].join('\n');
}

describe('SSE parse ↔ serialize round-trip', () => {
  test('reconstructs an assistant message from a tool_use stream', () => {
    const sse = toolUseSSE('Read', { path: '/etc/hosts' });
    const msg = parseSSEMessage(sse);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(msg!.stop_reason).toBe('tool_use');
    expect(msg!.content).toHaveLength(2);
    expect(msg!.content[0]).toMatchObject({ type: 'text', text: 'Let me check that.' });
    expect(msg!.content[1]).toMatchObject({ type: 'tool_use', name: 'Read', input: { path: '/etc/hosts' } });
  });

  test('serialize→parse preserves message semantics (round-trip)', () => {
    const original = parseSSEMessage(toolUseSSE('Bash', { command: 'ls -la' }))!;
    const reparsed = parseSSEMessage(serializeSSEMessage(original))!;
    expect(reparsed.stop_reason).toBe(original.stop_reason);
    expect(reparsed.content).toEqual(original.content);
  });

  test('serialized SSE has the expected event sequence', () => {
    const msg = parseSSEMessage(toolUseSSE('Read', { path: '/tmp/x' }))!;
    const out = serializeSSEMessage(msg);
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('event: message_stop');
    // Every data line must be valid JSON.
    for (const line of out.split('\n')) {
      if (line.startsWith('data:')) {
        expect(() => JSON.parse(line.slice('data:'.length).trim())).not.toThrow();
      }
    }
  });
});

describe('enforceResponseBody — streaming denials', () => {
  test('denies a connector tool_use and rewrites the stream', () => {
    const sse = toolUseSSE('mcp__claude_ai_gmail_create_draft', { to: 'x@y.com' }, 'toolu_gmail');
    const result = enforceResponseBody(true, sse, cfg());
    expect(result.changed).toBe(true);
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0]).toMatchObject({ name: 'mcp__claude_ai_gmail_create_draft', rule: 'connector-deny-default', toolUseId: 'toolu_gmail' });

    // The rewritten stream must NO LONGER contain the denied tool_use, and must
    // carry an explanatory text block instead so the agent course-corrects.
    const msg = parseSSEMessage(result.bodyText)!;
    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    expect(toolUses).toHaveLength(0);
    const texts = msg.content.filter((b) => b.type === 'text') as unknown as Array<{ text: string }>;
    expect(texts.some((t) => t.text.includes('blocked') && t.text.includes('mcp__claude_ai_gmail_create_draft'))).toBe(true);
  });

  test('downgrades stop_reason to end_turn when the only tool_use was denied', () => {
    const sse = toolUseSSE('mcp__claude_ai_gmail_create_draft', {}, 'toolu_g');
    const result = enforceResponseBody(true, sse, cfg());
    const msg = parseSSEMessage(result.bodyText)!;
    expect(msg.stop_reason).toBe('end_turn');
  });

  test('keeps stop_reason=tool_use when an allowed tool_use remains in the turn', () => {
    // Two tool_use blocks: one allowed (Read), one denied (connector).
    const sse = [
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: {} } })}`,
      ``,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'Read', input: {} } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: '/app/x.ts' }) } })}`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      ``,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'mcp__claude_ai_gmail_create_draft', input: {} } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}`,
      ``,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} })}`,
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
    ].join('\n');
    const result = enforceResponseBody(true, sse, cfg());
    expect(result.changed).toBe(true);
    const msg = parseSSEMessage(result.bodyText)!;
    // The allowed Read survives, so the turn is still a tool-use turn.
    expect(msg.stop_reason).toBe('tool_use');
    const toolUses = msg.content.filter((b) => b.type === 'tool_use') as unknown as Array<{ name: string }>;
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('Read');
  });

  test('forwards the ORIGINAL bytes untouched when nothing is denied', () => {
    const sse = toolUseSSE('Read', { path: '/app/src/index.ts' });
    const result = enforceResponseBody(true, sse, cfg());
    expect(result.changed).toBe(false);
    // Byte-identical passthrough — the rewrite path is never taken without a denial.
    expect(result.bodyText).toBe(sse);
  });

  test('does nothing when enforcement is disabled', () => {
    const sse = toolUseSSE('mcp__claude_ai_gmail_create_draft', {});
    const result = enforceResponseBody(true, sse, cfg({ enforce: false }));
    expect(result.changed).toBe(false);
    expect(result.bodyText).toBe(sse);
  });
});

describe('enforceResponseBody — non-streaming (JSON) denials', () => {
  test('rewrites a denied tool_use in a JSON message response', () => {
    const body = JSON.stringify({
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'z', name: 'mcp__claude_ai_gdrive_read', input: { file: 'x' } },
      ],
      stop_reason: 'tool_use',
    });
    const result = enforceResponseBody(false, body, cfg());
    expect(result.changed).toBe(true);
    const msg = JSON.parse(result.bodyText);
    expect(msg.content.filter((b: { type: string }) => b.type === 'tool_use')).toHaveLength(0);
    expect(msg.stop_reason).toBe('end_turn');
  });

  test('leaves an unparseable body untouched (fail safe)', () => {
    const result = enforceResponseBody(false, 'not json at all', cfg());
    expect(result.changed).toBe(false);
    expect(result.bodyText).toBe('not json at all');
  });
});
