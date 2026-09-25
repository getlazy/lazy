/**
 * Request-body extraction for OpenAI-wire traffic (an `openai` role upstream:
 * api.openai.com, openrouter.ai).
 *
 * DELIBERATELY SEPARATE from src/proxy/extractor.ts: the Anthropic extractor
 * must never see OpenAI traffic — its message/tool walking assumes Anthropic
 * content blocks, and audit records built from a misread body would be
 * confidently wrong. This module is also deliberately COARSER: model, stream
 * flag and endpoint classification only, the same posture the cursor
 * passthrough takes. Tool-call auditing for the OpenAI wire is a separate
 * decision for whichever task first needs it, not a shape to guess at here.
 */

import type { ExtractedRequest } from './extractor';

/** OpenAI-wire endpoint classification, as recorded on the audit record. */
export type OpenAIClassifiedEndpoint = 'chat_completions' | 'responses' | 'other';

/**
 * Both spellings of each path are classified the same.
 *
 * The `/v1`-less forms are what the ChatGPT subscription backend serves Codex at
 * (`https://chatgpt.com/backend-api/codex/responses`). Classification is what
 * decides whether usage is extracted from a response, so a subscription turn
 * matched only by the prefixed spelling would be forwarded correctly and then
 * audited with no token counts at all — a silent hole in exactly the reporting
 * the proxy exists to provide.
 */
export function classifyOpenAIEndpoint(path: string): OpenAIClassifiedEndpoint {
  const p = path.startsWith('/v1/') ? path.slice(3) : path;
  if (p.startsWith('/chat/completions')) return 'chat_completions';
  if (p.startsWith('/responses')) return 'responses';
  return 'other';
}

/** What the server keeps per OpenAI-wire request — ExtractedRequest's shape
 *  with the OpenAI endpoint vocabulary, so both wires feed one audit path. */
export type OpenAIExtractedRequest = Omit<ExtractedRequest, 'endpoint'> & {
  endpoint: OpenAIClassifiedEndpoint;
};

/**
 * Extract audit-relevant fields from a parsed OpenAI-wire request body. Both
 * the Chat Completions and the Responses API spell `model` and `stream` the
 * same way at the top level.
 */
export function extractOpenAIRequest(path: string, body: unknown): OpenAIExtractedRequest {
  const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    model: typeof b?.model === 'string' ? b.model : null,
    stream: typeof b?.stream === 'boolean' ? b.stream : null,
    endpoint: classifyOpenAIEndpoint(path),
    // Anthropic-tier guessing has no meaning for arbitrary OpenAI/OpenRouter
    // model names; the model itself is recorded verbatim above.
    tier: null,
    requestShape: null,
    toolUses: [],
    toolResults: [],
  };
}
