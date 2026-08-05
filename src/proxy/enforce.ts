/**
 * Active enforcement (§6.2 / §6.3 layer 1) — the response-rewriting half of the
 * mechanistic policy plane.
 *
 * The policy engine (src/proxy/policy.ts) decides *whether* a `tool_use` is
 * allowed; this module is what makes a `deny` stick: it inspects the assistant
 * response (the fresh `tool_use` the model just proposed, BEFORE Claude Code
 * executes it) and, on a violation, rewrites the response so the call never
 * runs. A denied `tool_use` block is dropped and replaced by an assistant
 * `text` block explaining the denial, so the agent learns why and can
 * course-correct rather than silently losing a turn.
 *
 * Why a text block and not a literal `tool_result`: under the Anthropic Messages
 * API a `tool_result` is user-role content — it cannot live inside the assistant
 * turn we are rewriting, and the proxy cannot make Claude Code's *client* inject
 * one (that is the client's own permission path, which we are deliberately
 * independent of). Removing the `tool_use` is what actually prevents execution;
 * the replacement text is how the denial is surfaced to the model. `stop_reason`
 * is recomputed: it stays `tool_use` when other (allowed) tool calls remain in
 * the same turn, otherwise it becomes `end_turn`.
 *
 * FRAGILITY (see spike §6.5): re-emitting a streaming response as SSE must match
 * Claude Code's expected event sequence exactly or it corrupts the conversation.
 * We mitigate the risk two ways: (1) when NOTHING is denied we forward the
 * original upstream bytes UNTOUCHED — the rewrite path is only ever taken on an
 * actual violation; (2) the SSE (de)serialization is round-trip tested. This is
 * the mechanistic floor; the LLM-judge layer (§6.3 layer 2) is a separate task.
 */

import type { ProxyPolicyConfig, PolicyDecision } from './policy';
import { evaluateToolUse } from './policy';

/** A minimal view of an Anthropic assistant message we care about rewriting. */
interface AnthropicMessage {
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: string | null;
  // Preserved verbatim through the round-trip:
  [k: string]: unknown;
}

interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

/** One denial applied to a response, surfaced for audit + logging. */
export interface EnforcementAction {
  toolUseId: string | null;
  name: string;
  rule: string;
  reason: string;
}

export interface EnforceResult {
  /** True if any tool_use was denied and the body was rewritten. */
  changed: boolean;
  /** The (possibly rewritten) response body. Identical to input when unchanged. */
  bodyText: string;
  /** Denials applied (empty when nothing changed). */
  denials: EnforcementAction[];
  /** stop_reason observed on the (parsed) response, if any. Null when unparsed. */
  stopReason: string | null;
}

const NOOP = (bodyText: string): EnforceResult => ({
  changed: false,
  bodyText,
  denials: [],
  stopReason: null,
});

/**
 * Enforce policy over a buffered `/v1/messages` response body.
 *
 * @param isStream    whether the upstream sent an SSE stream (text/event-stream)
 * @param bodyText    the full buffered response body
 * @param config      resolved mechanistic policy
 */
export function enforceResponseBody(
  isStream: boolean,
  bodyText: string,
  config: ProxyPolicyConfig,
): EnforceResult {
  if (!config.enforce || !bodyText) return NOOP(bodyText);

  const message = isStream ? parseSSEMessage(bodyText) : parseJSONMessage(bodyText);
  // If we cannot parse it as an assistant message, do not touch it — forwarding
  // the original bytes untouched is always safe; corrupting them is not.
  if (!message) return NOOP(bodyText);

  const { rewritten, denials } = applyPolicyToMessage(message, config);
  if (denials.length === 0) {
    // Nothing denied — forward original bytes verbatim (never re-serialize a
    // passthrough; that is the only way to guarantee zero corruption).
    return { changed: false, bodyText, denials: [], stopReason: message.stop_reason };
  }

  const out = isStream ? serializeSSEMessage(rewritten) : JSON.stringify(rewritten);
  return { changed: true, bodyText: out, denials, stopReason: rewritten.stop_reason };
}

/**
 * Apply the policy engine to every tool_use block in an assistant message.
 * Denied blocks are replaced with a text block; stop_reason is recomputed.
 * Returns a shallow-cloned message so the input is never mutated.
 */
export function applyPolicyToMessage(
  message: AnthropicMessage,
  config: ProxyPolicyConfig,
): { rewritten: AnthropicMessage; denials: EnforcementAction[] } {
  const denials: EnforcementAction[] = [];
  const content: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type !== 'tool_use') {
      content.push(block);
      continue;
    }
    const name = typeof block.name === 'string' ? block.name : '';
    const input =
      block.input !== null && typeof block.input === 'object'
        ? (block.input as Record<string, unknown>)
        : {};
    const decision: PolicyDecision = evaluateToolUse(name, input, config);
    if (decision.action === 'allow') {
      content.push(block);
      continue;
    }
    // Denied: drop the tool_use, inject an explanatory assistant text block.
    denials.push({
      toolUseId: typeof block.id === 'string' ? block.id : null,
      name,
      rule: decision.rule,
      reason: decision.reason,
    });
    content.push({
      type: 'text',
      text:
        `⛔ lazy proxy blocked tool "${name}" (${decision.rule}): ${decision.reason} ` +
        `The action did NOT run. Choose a different approach that complies with policy.`,
    });
  }

  const rewritten: AnthropicMessage = { ...message, content };

  // Recompute stop_reason: if any executable tool_use remains, the turn is still
  // a tool-use turn; otherwise the model has effectively ended its turn.
  if (denials.length > 0) {
    const stillHasToolUse = content.some((b) => b.type === 'tool_use');
    if (!stillHasToolUse && message.stop_reason === 'tool_use') {
      rewritten.stop_reason = 'end_turn';
    }
  }

  return { rewritten, denials };
}

// --- JSON (non-streaming) parsing ---

function parseJSONMessage(bodyText: string): AnthropicMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  if (m?.type !== 'message' || m?.role !== 'assistant' || !Array.isArray(m?.content)) {
    return null;
  }
  return m as unknown as AnthropicMessage;
}

// --- SSE (streaming) parsing + serialization ---

/**
 * Assemble a complete assistant message from a buffered Anthropic SSE stream.
 * We dispatch purely on each `data:` payload's own `type` field (the `event:`
 * lines are redundant with it), accumulating content blocks and their deltas.
 * Returns null if the stream isn't a well-formed message stream.
 */
export function parseSSEMessage(bodyText: string): AnthropicMessage | null {
  let message: AnthropicMessage | null = null;
  const blocks: ContentBlock[] = [];
  // Per-index accumulator for streamed tool_use input JSON (input_json_delta).
  const partialJson: Record<number, string> = {};

  for (const line of bodyText.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      // A malformed data line means we cannot faithfully reconstruct — bail so
      // the caller forwards the original bytes untouched.
      return null;
    }

    switch (data.type) {
      case 'message_start': {
        const msg = data.message as Record<string, unknown> | undefined;
        if (!msg || msg.type !== 'message' || msg.role !== 'assistant') return null;
        message = { ...(msg as unknown as AnthropicMessage), content: [] };
        break;
      }
      case 'content_block_start': {
        const idx = typeof data.index === 'number' ? data.index : blocks.length;
        blocks[idx] = { ...(data.content_block as ContentBlock) };
        break;
      }
      case 'content_block_delta': {
        const idx = typeof data.index === 'number' ? data.index : blocks.length - 1;
        const delta = data.delta as Record<string, unknown>;
        const block = blocks[idx];
        if (!block || !delta) break;
        switch (delta.type) {
          case 'text_delta':
            block.text = (typeof block.text === 'string' ? block.text : '') + (delta.text ?? '');
            break;
          case 'input_json_delta':
            partialJson[idx] = (partialJson[idx] ?? '') + (delta.partial_json ?? '');
            break;
          case 'thinking_delta':
            block.thinking = (typeof block.thinking === 'string' ? block.thinking : '') + (delta.thinking ?? '');
            break;
          case 'signature_delta':
            block.signature = delta.signature;
            break;
          default:
            break;
        }
        break;
      }
      case 'content_block_stop': {
        const idx = typeof data.index === 'number' ? data.index : blocks.length - 1;
        const block = blocks[idx];
        if (block?.type === 'tool_use') {
          const raw = partialJson[idx];
          if (raw != null && raw.length > 0) {
            try {
              block.input = JSON.parse(raw);
            } catch {
              // Leave whatever start provided (usually {}) if the JSON is partial.
            }
          } else if (block.input === undefined) {
            block.input = {};
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (message && delta) {
          if ('stop_reason' in delta) message.stop_reason = (delta.stop_reason as string | null) ?? null;
          if ('stop_sequence' in delta) message.stop_sequence = delta.stop_sequence;
        }
        if (message && data.usage) {
          message.usage = { ...(message.usage as object), ...(data.usage as object) };
        }
        break;
      }
      case 'message_stop':
      default:
        break;
    }
  }

  if (!message) return null;
  message.content = blocks.filter((b) => b != null);
  return message;
}

/**
 * Serialize an assistant message back into Anthropic's SSE event sequence. Only
 * ever used on the rewrite path (an actual denial), so it must faithfully
 * reproduce the shape Claude Code expects: message_start → per-block
 * start/delta/stop → message_delta (stop_reason) → message_stop.
 */
export function serializeSSEMessage(message: AnthropicMessage): string {
  const parts: string[] = [];
  const emit = (event: string, data: unknown) => {
    parts.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Strip content out of the message_start snapshot — content streams block by
  // block, exactly as the real API does.
  const { content, stop_reason, stop_sequence, usage, ...rest } = message;
  emit('message_start', {
    type: 'message_start',
    message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: usage ?? {} },
  });

  content.forEach((block, index) => {
    if (block.type === 'text') {
      emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length) {
        emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
      }
      emit('content_block_stop', { type: 'content_block_stop', index });
    } else if (block.type === 'tool_use') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const inputJson = JSON.stringify(block.input ?? {});
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      });
      emit('content_block_stop', { type: 'content_block_stop', index });
    } else {
      // Any other block type (thinking, etc.) — emit start/stop with the block
      // as-is so we never drop content we didn't explicitly handle.
      emit('content_block_start', { type: 'content_block_start', index, content_block: block });
      emit('content_block_stop', { type: 'content_block_stop', index });
    }
  });

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop_reason ?? 'end_turn', stop_sequence: stop_sequence ?? null },
    usage: usage ?? {},
  });
  emit('message_stop', { type: 'message_stop' });

  return parts.join('');
}
