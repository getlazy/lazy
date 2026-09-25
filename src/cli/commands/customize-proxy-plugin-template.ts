/**
 * Source templates emitted by `lazy customize proxy-plugin`.
 *
 * These are CODE scaffolds, not prompts — the guide prompt that ships alongside
 * them lives in src/prompts/customize-proxy-plugin-guide.md per CLAUDE.md. They
 * are kept here, apart from the command, so the command file stays about
 * argument handling and the templates stay readable as the files they become.
 *
 * `{{name}}` is the plugin name, `{{module}}` the module basename.
 */

export const PLUGIN_TEMPLATE = `/**
 * Proxy request plugin: {{name}}
 *
 * WHAT THIS CHANGES:  <describe exactly which request fields this rewrites>
 * WHAT IT NEVER TOUCHES:  <messages, input_schema, cache_control, ...>
 *
 * Loaded automatically by lazy's proxy from .lazy/plugins/ — presence is the
 * enable switch, there is no lazy.toml key. Plugins run in sorted-filename
 * order and the chain is a fold: each sees the previous one's output.
 *
 * THE CONTRACT (breaking any of these is a bug, not a style choice):
 *   - PURE, SYNCHRONOUS, DETERMINISTIC. Same body in, same body out. No I/O, no
 *     clock, no random, no state between calls — the upstream caches on the
 *     request prefix, and a transform that varies per turn destroys that cache.
 *   - NEVER MUTATE \`body\` IN PLACE. Build and return a new object.
 *   - RETURN null WHEN THERE IS NOTHING TO DO. That is the cheap path, and it is
 *     what keeps uninteresting requests forwarded byte-for-byte.
 *   - FAIL OPEN AT RUN TIME. If this throws, lazy logs it and forwards the
 *     original body. A bug degrades to passthrough, never to a failed request.
 *   - FAIL LOUD AT LOAD TIME. If this file will not import, or does not export
 *     the shape below, the daemon's proxy startup fails rather than silently
 *     skipping it.
 *
 * DANGEROUS TO TOUCH: \`messages\` is the conversation transcript (rewriting it
 * falsifies the record and invalidates the prompt cache every request);
 * \`tools[].input_schema\` is machine-read JSON Schema; \`cache_control\`,
 * \`model\`, \`max_tokens\` and \`stream\` are protocol, not content.
 *
 * Plugin code runs INSIDE the lazy daemon process, on the host, unsandboxed.
 */

/** Read-only request facts, mirroring lazy's ProxyRequestContext. */
interface RequestContext {
  /** HTTP method of the inbound request. */
  method: string;
  /** Path + query, as received (e.g. "/v1/messages"). */
  path: string;
  /** "messages" | "count_tokens" | "other" — see src/proxy/extractor.ts. */
  endpoint: string;
}

export default {
  name: '{{name}}',

  /**
   * Transform a parsed JSON request body.
   *
   * @returns a NEW body to forward instead, or null for "no change".
   */
  transformRequest(body: unknown, ctx: RequestContext): unknown | null {
    // Only \`messages\` requests carry a prompt. Drop everything else early.
    if (ctx.endpoint !== 'messages') return null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;

    // ---------------------------------------------------------------------
    // TODO: implement the transform.
    //
    // The stub below is a deliberate no-op: it inspects the body and declines.
    // Replace it, keeping the "return null when nothing changed" shape — that
    // is what preserves byte-identical forwarding for requests you skip.
    // ---------------------------------------------------------------------
    const request = body as { system?: unknown };
    if (typeof request.system !== 'string') return null;

    return null;
  },
};
`;

export const TEST_TEMPLATE = `/**
 * Smoke test for the "{{name}}" proxy request plugin.
 *
 * Run with:  bun test ./.lazy/plugins/{{module}}.test.ts
 *            (the leading ./ matters — bun reads a dot-leading filter as a
 *            pattern, not a path)
 *
 * This file is NOT loaded as a plugin — lazy's loader skips *.test.* in the
 * plugin directory — so it can live right next to the plugin it covers.
 *
 * Add a test per behaviour the plugin promises. The two below are the floor:
 * they encode the contract, not the feature, and should keep passing whatever
 * the plugin ends up doing.
 */

import { describe, test, expect } from 'bun:test';
import plugin from './{{module}}';

const CTX = { method: 'POST', path: '/v1/messages', endpoint: 'messages' };

describe('{{name}}', () => {
  test('exports the shape the loader requires', () => {
    expect(typeof plugin.name).toBe('string');
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(typeof plugin.transformRequest).toBe('function');
  });

  // CONTRACT: the plugin must not mutate the caller's body in place — a later
  // plugin throwing must not be able to leave a half-applied transform behind.
  test('does not mutate the body it is given', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      system: 'You are an agent working in a repository.',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const before = JSON.stringify(body);
    plugin.transformRequest(body, CTX);
    expect(JSON.stringify(body)).toBe(before);
  });

  // CONTRACT: same input, same output. A transform that varies between calls
  // invalidates the upstream prompt cache on every single request.
  test('is deterministic', () => {
    const body = { model: 'm', system: 'A prompt that is long enough to be interesting.' };
    const first = JSON.stringify(plugin.transformRequest(body, CTX));
    const second = JSON.stringify(plugin.transformRequest(body, CTX));
    expect(first).toBe(second);
  });

  // TODO: add a test for what this plugin actually does, and one asserting the
  // fields it must never touch are carried through identically.
});
`;
