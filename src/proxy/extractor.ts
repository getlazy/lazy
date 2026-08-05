/**
 * Request body extractor for the Anthropic passthrough proxy.
 *
 * Parses the Anthropic /v1/messages body and extracts:
 *   - coarse request shape (model, streaming, system size, message roles, tools)
 *   - tool_use blocks (intended actions — file paths, bash commands, network targets)
 *   - tool_result blocks (action results — bounded content preview)
 *
 * All fields are extracted from the request body only — the response is
 * streamed through untouched so nothing here touches the upstream response.
 */

import type { ProxyRequestShape, ProxyToolUseAudit, ProxyToolResultAudit } from '../storage/types';

const TOOL_INPUT_PREVIEW_BYTES = 512;
const TOOL_RESULT_PREVIEW_BYTES = 256;
const MAX_TOOL_NAMES = 40;

export type ClassifiedEndpoint = 'messages' | 'count_tokens' | 'other';

export function classifyEndpoint(path: string): ClassifiedEndpoint {
  // /v1/messages/count_tokens must be checked before /v1/messages
  if (path.includes('count_tokens')) return 'count_tokens';
  if (path.startsWith('/v1/messages')) return 'messages';
  return 'other';
}

export function tierGuess(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return 'other';
}

function extractToolUse(block: unknown): ProxyToolUseAudit {
  const b = block as Record<string, unknown>;
  const name: string = typeof b?.name === 'string' ? b.name : '';
  const input: Record<string, unknown> = (b?.input !== null && typeof b?.input === 'object' ? b.input : {}) as Record<string, unknown>;

  // Extract security-relevant fields by tool kind
  let path: string | null = null;
  let command: string | null = null;
  let target: string | null = null;

  // Read/Write/Edit/Glob/LS tools carry a 'path' or 'file_path'
  if (typeof input?.path === 'string') path = input.path;
  else if (typeof input?.file_path === 'string') path = input.file_path;

  // Bash tool carries a 'command'
  if (typeof input?.command === 'string') command = input.command;

  // WebFetch carries a 'url'; WebSearch carries a 'query'
  if (typeof input?.url === 'string') target = input.url;
  else if (typeof input?.query === 'string') target = input.query;

  // Bounded JSON preview of the full input
  const inputStr = JSON.stringify(input);
  const inputPreview = inputStr.length > TOOL_INPUT_PREVIEW_BYTES
    ? inputStr.slice(0, TOOL_INPUT_PREVIEW_BYTES) + '…'
    : inputStr;

  return {
    id: typeof b?.id === 'string' ? b.id : null,
    name,
    path,
    command,
    target,
    connector: name.startsWith('mcp__claude_ai_'),
    inputPreview,
  };
}

function extractToolResult(block: unknown): ProxyToolResultAudit {
  const b = block as Record<string, unknown>;
  const content = b?.content;

  let contentStr = '';
  if (typeof content === 'string') {
    contentStr = content;
  } else if (Array.isArray(content)) {
    // Array of content blocks — join text parts
    contentStr = (content as unknown[])
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && (c as Record<string, unknown>)?.type === 'text')
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join('');
  }

  const contentLen = contentStr.length;
  const contentPreview = contentLen > TOOL_RESULT_PREVIEW_BYTES
    ? contentStr.slice(0, TOOL_RESULT_PREVIEW_BYTES) + '…'
    : contentStr;

  return {
    toolUseId: typeof b?.tool_use_id === 'string' ? b.tool_use_id : null,
    isError: b?.is_error === true,
    contentPreview,
    contentLen,
  };
}

export interface ExtractedRequest {
  model: string | null;
  stream: boolean | null;
  endpoint: ClassifiedEndpoint;
  tier: string | null;
  /** Null for non-messages endpoints. bodyBytes is always 0 here — caller fills it in. */
  requestShape: ProxyRequestShape | null;
  toolUses: ProxyToolUseAudit[];
  toolResults: ProxyToolResultAudit[];
}

/**
 * Extract audit-relevant fields from a parsed Anthropic request body.
 * `bodyBytes` in the returned `requestShape` is always 0 — the caller
 * must set it to the actual raw body byte count.
 */
export function extractRequest(path: string, body: unknown): ExtractedRequest {
  const endpoint = classifyEndpoint(path);

  const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const model: string | null = typeof b?.model === 'string' ? b.model : null;
  const stream: boolean | null = typeof b?.stream === 'boolean' ? b.stream : null;
  const tier = tierGuess(model);

  if (endpoint === 'other') {
    return { model, stream, endpoint, tier, requestShape: null, toolUses: [], toolResults: [] };
  }

  const messages: unknown[] = Array.isArray(b?.messages) ? b.messages : [];
  const tools: unknown[] = Array.isArray(b?.tools) ? b.tools : [];

  const systemLen = typeof b?.system === 'string'
    ? b.system.length
    : Array.isArray(b?.system)
      ? (b.system as unknown[]).reduce<number>((n, s) => {
          const block = s as Record<string, unknown>;
          return n + (typeof block?.text === 'string' ? block.text.length : 0);
        }, 0)
      : 0;

  const messageRoles: string[] = messages.map((m) => {
    const msg = m as Record<string, unknown>;
    return typeof msg?.role === 'string' ? msg.role : 'unknown';
  });

  const toolNames: string[] = tools
    .slice(0, MAX_TOOL_NAMES)
    .map((t) => {
      const tool = t as Record<string, unknown>;
      return typeof tool?.name === 'string' ? tool.name : '';
    });

  const requestShape: ProxyRequestShape = {
    hasSystem: b?.system != null,
    systemLen,
    numMessages: messages.length,
    messageRoles,
    numTools: tools.length,
    toolNames,
    maxTokens: typeof b?.max_tokens === 'number' ? b.max_tokens : null,
    bodyBytes: 0, // caller fills this in
  };

  // Scan messages for tool_use and tool_result content blocks
  const toolUses: ProxyToolUseAudit[] = [];
  const toolResults: ProxyToolResultAudit[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content as unknown[]) {
      const blk = block as Record<string, unknown>;
      if (blk?.type === 'tool_use') toolUses.push(extractToolUse(block));
      if (blk?.type === 'tool_result') toolResults.push(extractToolResult(block));
    }
  }

  return { model, stream, endpoint, tier, requestShape, toolUses, toolResults };
}
