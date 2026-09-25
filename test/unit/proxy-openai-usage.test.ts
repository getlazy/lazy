/**
 * OpenAI-wire usage extraction and request classification.
 *
 * The proxy counts tokens for OpenAI-compatible upstreams (api.openai.com,
 * openrouter.ai) on both inference endpoints, streaming and not, without the
 * Anthropic extractor ever seeing that traffic. The success-path shapes below
 * follow the documented OpenAI API; they are flagged for verification with
 * real keys in the task's pairing checklist.
 */

import { describe, test, expect } from 'bun:test';
import { extractUsage, teeUsageStream } from '../../src/proxy/usage';
import {
  classifyOpenAIEndpoint,
  extractOpenAIRequest,
} from '../../src/proxy/openai-extractor';

const enc = new TextEncoder();

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

describe('extractUsage — openai wire, non-streaming', () => {
  test('chat completions: prompt/completion tokens, cached subtracted into cache reads', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-1',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 80,
        total_tokens: 1080,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    });
    // INVARIANT: OpenAI's prompt_tokens INCLUDES cached tokens while lazy's
    // aggregator sums input + cacheRead for totals — recording both unsplit
    // would double-count. input = prompt - cached, cacheRead = cached.
    expect(extractUsage(false, body, 'openai')).toEqual({
      inputTokens: 400,
      outputTokens: 80,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 600,
    });
  });

  test('responses API: input/output tokens with cached details', () => {
    const body = JSON.stringify({
      id: 'resp_1',
      usage: {
        input_tokens: 500,
        output_tokens: 42,
        total_tokens: 542,
        input_tokens_details: { cached_tokens: 100 },
      },
    });
    expect(extractUsage(false, body, 'openai')).toEqual({
      inputTokens: 400,
      outputTokens: 42,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 100,
    });
  });

  test('no cached details: the whole prompt is input', () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(extractUsage(false, body, 'openai')).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  test('a body with no usage reports null', () => {
    expect(extractUsage(false, JSON.stringify({ id: 'x' }), 'openai')).toBeNull();
    expect(extractUsage(false, 'not json', 'openai')).toBeNull();
    expect(extractUsage(false, '', 'openai')).toBeNull();
  });
});

describe('extractUsage — openai wire, streaming', () => {
  test('chat completions: usage arrives on the final chunk (stream_options.include_usage)', () => {
    const sse = [
      'data: {"id":"c","choices":[{"delta":{"content":"hi"}}],"usage":null}',
      '',
      'data: {"id":"c","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":4}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(extractUsage(true, sse, 'openai')).toEqual({
      inputTokens: 16,
      outputTokens: 7,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 4,
    });
  });

  test('responses API: usage rides response.completed', () => {
    const sse = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"h"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":9,"input_tokens_details":{"cached_tokens":0}}}}',
      '',
    ].join('\n');
    expect(extractUsage(true, sse, 'openai')).toEqual({
      inputTokens: 30,
      outputTokens: 9,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  // The wire is selected per role upstream in the server (an Anthropic
  // upstream's traffic never reaches the openai scanner — that is the
  // isolation invariant, asserted in proxy-openai-server.test.ts). Here:
  // the anthropic scanner must not misread an OpenAI chat stream, whose
  // usage field names (`prompt_tokens`) it does not know.
  test('an OpenAI chat stream yields nothing on the anthropic wire', () => {
    const sse =
      'data: {"id":"c","usage":{"prompt_tokens":20,"completion_tokens":7}}\n';
    expect(extractUsage(true, sse, 'anthropic')).toBeNull();
  });
});

describe('teeUsageStream — openai wire', () => {
  test('captures usage from a streamed chat completion without altering bytes', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"x"}}],"usage":null}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n' +
      'data: [DONE]\n\n';
    let usage: unknown = 'unset';
    const teed = teeUsageStream(streamOf(sse), true, (u) => { usage = u; }, 'openai');
    const out = await new Response(teed).text();
    expect(out).toBe(sse);
    expect(usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });

  test('captures usage from a non-streaming responses body', async () => {
    const body = JSON.stringify({ usage: { input_tokens: 8, output_tokens: 2 } });
    let usage: unknown = 'unset';
    const teed = teeUsageStream(streamOf(body), false, (u) => { usage = u; }, 'openai');
    await new Response(teed).text();
    expect(usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
  });
});

describe('OpenAI request extraction', () => {
  test('classifies the two inference endpoints, query-string tolerant', () => {
    expect(classifyOpenAIEndpoint('/v1/chat/completions')).toBe('chat_completions');
    expect(classifyOpenAIEndpoint('/v1/chat/completions?x=1')).toBe('chat_completions');
    expect(classifyOpenAIEndpoint('/v1/responses')).toBe('responses');
    expect(classifyOpenAIEndpoint('/v1/responses/resp_1')).toBe('responses');
    expect(classifyOpenAIEndpoint('/v1/models')).toBe('other');
    expect(classifyOpenAIEndpoint('/v1/messages')).toBe('other');
  });

  test('extracts model and stream, and stays deliberately coarse', () => {
    const extracted = extractOpenAIRequest('/v1/responses', {
      model: 'gpt-5.2-codex',
      stream: true,
      input: 'hello',
    });
    expect(extracted.model).toBe('gpt-5.2-codex');
    expect(extracted.stream).toBe(true);
    expect(extracted.endpoint).toBe('responses');
    // Coarse on purpose: no Anthropic tier guess, no tool walking — the
    // Anthropic extractor's shape assumptions do not apply to this wire.
    expect(extracted.tier).toBeNull();
    expect(extracted.requestShape).toBeNull();
    expect(extracted.toolUses).toEqual([]);
  });

  test('tolerates a non-object body', () => {
    const extracted = extractOpenAIRequest('/v1/chat/completions', null);
    expect(extracted.model).toBeNull();
    expect(extracted.endpoint).toBe('chat_completions');
  });
});
