/**
 * How large a context window a launch actually gets.
 *
 * WHY THIS EXISTS. The window is not a property of the model alone, and it is
 * not something lazy can ask for: Claude Code computes it locally, from a model
 * table compiled into its own bundle, and the biggest models' 1M window is
 * additionally gated on the harness believing it is talking to Anthropic's
 * first-party API. Lazy points `ANTHROPIC_BASE_URL` at its own proxy, so that
 * gate is exactly the kind of thing a project can fail silently — the session
 * simply starts with a fifth of the room and nothing says why.
 *
 * So the number is reproduced here, from the same three inputs the harness
 * uses, and reported by `lazy doctor` beside the context budget it is the
 * denominator of. Anything that reads {@link effectiveContextWindow} is reading
 * lazy's model of Claude Code's decision — see the honesty caveats below.
 *
 * VERIFIED AGAINST CLAUDE CODE {@link CONTEXT_WINDOW_VERIFIED_VERSION}, by
 * reading the shipped bundle and then reproducing the result at runtime with
 * `claude --model <id> -p "/context"`. The decision, in the order the bundle
 * applies it:
 *
 *   1. A literal `[1m]` suffix on the model id → 1M, unconditionally. This is
 *      the documented escape hatch and it bypasses the first-party check
 *      entirely (`claude --model "claude-opus-5[1m]"` reports 1m through
 *      lazy's proxy even with no other change).
 *   2. The `context-1m` beta header on an eligible model → 1M. Lazy sets no
 *      such header, so this branch never fires for a lazy launch.
 *   3. A model the table marks `native_1m` AND a first-party base URL → 1M.
 *      This is the branch lazy launches take, and the one that used to fail.
 *   4. Otherwise the 200k default.
 *
 * WHAT THIS CANNOT KNOW, and why it is a floor rather than a guess:
 *   - The table is compiled into the harness BINARY, and `Dockerfile.lazy`
 *     installs Claude Code unpinned, so a container built later may know models
 *     this list does not. An unrecognized `claude-*` id is reported as the 200k
 *     default with `known: false` — a model whose window we cannot vouch for is
 *     never claimed to be 1M.
 *   - Another harness (codex, cursor, pi) has its own table and its own rules.
 *     Those are reported `known: false` too; the number is lazy's default
 *     assumption, not a read of anything.
 *
 * The evidence trail — which bundle symbols encode which branch, and the
 * `/context` probes that confirm each one — is in
 * docs/context-window-first-party.md.
 */

import type { RoleTarget } from '../config/types';
import { assumesFirstPartyBaseUrl } from '../utils/role-target';

/**
 * The Claude Code release the model table and the gating logic below were read
 * out of.
 *
 * Named for the same reason {@link import('../context-budget').CLAUDE_MD_LIMIT_VERIFIED_VERSION}
 * is: nothing in lazy detects the table going stale, so the only defence is
 * saying what it was checked against.
 */
export const CONTEXT_WINDOW_VERIFIED_VERSION = '2.1.266';

/** The window every model falls back to when nothing else applies. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** The window a native-1M model reaches on a first-party base URL. */
export const LARGE_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * Models the bundled table marks `native_1m` — the ones whose window is 1M
 * without a beta header, given a first-party base URL.
 *
 * Deliberately NOT "everything new": `claude-sonnet-4-6`, `claude-opus-4-6` and
 * `claude-sonnet-4-0` sit in the same table at 200k with `supports_1m_beta`,
 * and reporting them as 1M would be a worse error than reporting nothing. Short
 * aliases (`opus`, `fable`, …) resolve server-side and are not in the table, so
 * they take the unknown path rather than being mapped optimistically here.
 */
export const NATIVE_1M_MODELS: readonly string[] = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
];

/**
 * Models the same table pins at the 200k default — listed so a known-200k
 * answer can be reported as knowledge rather than as a fallback.
 *
 * They carry `supports_1m_beta` / `supports_1m_suffix`, meaning a caller can
 * opt into 1M explicitly, but their DEFAULT window is 200k and lazy opts into
 * nothing on the human's behalf.
 */
export const KNOWN_200K_MODELS: readonly string[] = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-0',
  'claude-haiku-4-5',
];

/** The `[1m]` suffix Claude Code reads as "give me the million-token window". */
const LARGE_WINDOW_SUFFIX = '[1m]';

export interface EffectiveContextWindow {
  /** Tokens the harness will report on its own `/context` screen. */
  tokens: number;
  /**
   * True when the number was READ — from the model table above, for a harness
   * whose rules are the ones reproduced here. False means it is lazy's
   * conservative default for a model or harness this module does not know, and
   * a human comparing it against `/context` may legitimately see more.
   */
  known: boolean;
  /** One clause naming why it is this number, for the surface that prints it. */
  reason: string;
  /**
   * Set when the window is smaller than the model's own maximum and lazy is the
   * reason — today, exactly one case: a native-1M model whose launch does not
   * present a first-party base URL. Never set for a model that is simply a
   * 200k model.
   */
  remedy?: string;
}

/** Strip the `[1m]` suffix and normalize, the way the harness parses the id. */
function normalizeModel(model: string): { id: string; suffix1m: boolean } {
  const trimmed = model.trim().toLowerCase();
  if (trimmed.endsWith(LARGE_WINDOW_SUFFIX)) {
    return { id: trimmed.slice(0, -LARGE_WINDOW_SUFFIX.length), suffix1m: true };
  }
  return { id: trimmed, suffix1m: false };
}

/**
 * The context window a launch on this target will actually get.
 *
 * @param target the role target as the launch will use it — post
 *   `applyLiveProxyUrl`, so `proxyUrl` and `primaryUpstream` are filled in.
 *   Those two are what decide the first-party question, and a target missing
 *   them takes the conservative branch (see {@link assumesFirstPartyBaseUrl}).
 * @param model the model the launch resolves to, when it is not the target's
 *   own — a task's model, or the `[models] default` an unpinned profile falls
 *   back to. Defaults to `target.model`.
 */
export function effectiveContextWindow(
  target: RoleTarget,
  model: string = target.model,
): EffectiveContextWindow {
  if (target.harness !== 'claude-code') {
    return {
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: false,
      reason: `${target.harness} decides its own window — lazy reports the common default`,
    };
  }

  const { id, suffix1m } = normalizeModel(model);
  if (suffix1m) {
    return {
      tokens: LARGE_CONTEXT_WINDOW_TOKENS,
      known: true,
      reason: 'the model id carries the [1m] suffix, which asks for it explicitly',
    };
  }

  if (NATIVE_1M_MODELS.includes(id)) {
    if (assumesFirstPartyBaseUrl(target)) {
      return {
        tokens: LARGE_CONTEXT_WINDOW_TOKENS,
        known: true,
        reason: `${id} is a 1M-window model and this launch presents a first-party base URL`,
      };
    }
    return {
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: true,
      reason:
        `${id} has a 1M window, but Claude Code only grants it when its base URL is ` +
        `Anthropic's own API, and this launch's upstream is not`,
      remedy:
        `Traffic for this profile does not reach api.anthropic.com — it is pinned to another ` +
        `endpoint, or \`[proxy] upstream\` points elsewhere. Point it at Anthropic to get the ` +
        `1M window, or pass the model as "${id}[1m]" if the upstream serves it.`,
    };
  }

  if (KNOWN_200K_MODELS.includes(id)) {
    return {
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: true,
      reason: `${id} is a 200k-window model`,
    };
  }

  // Not in the table: a short alias the API resolves server-side (`opus`,
  // `fable`), or a model newer than the version this table was read from.
  //
  // The window cannot be stated, but the half of it lazy owns can — and that
  // half is the whole point of this line. Whether the launch presents a
  // first-party base URL decides whether a 1M-capable model gets 1M, and it is
  // true or false regardless of which model the name resolves to. Saying it
  // turns "unverified 200k" from a shrug into an answer: the reader learns
  // either "if this is a 1M model you are getting 1M" or "whatever this
  // resolves to, it is capped".
  const firstParty = assumesFirstPartyBaseUrl(target);
  const which = model
    ? `${model} is not in the model table lazy read from Claude Code ${CONTEXT_WINDOW_VERIFIED_VERSION}` +
      (isShortAlias(id) ? ' (a short alias the API resolves server-side)' : '')
    : 'no model is pinned for this role';
  return {
    tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    known: false,
    reason: firstParty
      ? `${which}, so this is the default — but the launch does present a first-party base URL, ` +
        `so a 1M-window model gets its full window`
      : `${which}, so this is the default`,
    ...(firstParty
      ? {}
      : {
          remedy:
            `This launch does not present a first-party base URL, so whatever the model resolves ` +
            `to is capped at ${DEFAULT_CONTEXT_WINDOW_TOKENS.toLocaleString('en-US')} tokens. Its ` +
            `traffic does not reach api.anthropic.com — the profile is pinned to another endpoint, ` +
            `or \`[proxy] upstream\` points elsewhere.`,
        }),
  };
}

/**
 * A short model alias (`opus`, `fable`, …) rather than a full model id.
 *
 * Worth naming in the reason line: an unrecognized full id might be a typo,
 * while an alias is a perfectly ordinary configuration whose window simply
 * cannot be known locally — the API picks the model it points at.
 */
function isShortAlias(id: string): boolean {
  return id.length > 0 && !id.includes('-');
}
