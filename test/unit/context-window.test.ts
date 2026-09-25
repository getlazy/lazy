/**
 * The context window a Claude Code launch actually gets — lazy's model of
 * the harness's own decision, reproduced so `lazy doctor` can report it.
 *
 * The numbers and the first-party gate were read out of Claude Code 2.1.266
 * and then reproduced at runtime with `claude --model <id> -p "/context"`.
 * Evidence: docs/context-window-first-party.md.
 */

import { describe, test, expect } from 'bun:test';
import type { RoleTarget } from '../../src/config/types';
import {
  CONTEXT_WINDOW_VERIFIED_VERSION,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  LARGE_CONTEXT_WINDOW_TOKENS,
  KNOWN_200K_MODELS,
  NATIVE_1M_MODELS,
  effectiveContextWindow,
} from '../../src/agent/context-window';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { NO_CREDENTIAL } from '../../src/config/agent-profiles';

const PROXY = 'http://127.0.0.1:8766';
const ANTHROPIC = 'https://api.anthropic.com';

const claude = (over: Partial<RoleTarget> = {}): RoleTarget => ({
  ...ANTHROPIC_DEFAULT_TARGET,
  model: 'claude-fable-5-1',
  proxyUrl: PROXY,
  primaryUpstream: ANTHROPIC,
  ...over,
});

describe('effectiveContextWindow — pinned facts', () => {
  // INVARIANT: the table and the gating logic were read from one Claude Code
  // release, and nothing in lazy detects the table going stale (Dockerfile.lazy
  // installs the harness unpinned). The version is named so a wrong number is
  // findable, and changing it is a deliberate re-read of the bundle.
  test('the table is pinned to the Claude Code release it was read from', () => {
    expect(CONTEXT_WINDOW_VERIFIED_VERSION).toBe('2.1.266');
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(LARGE_CONTEXT_WINDOW_TOKENS).toBe(1_000_000);
    expect(NATIVE_1M_MODELS).toContain('claude-fable-5-1');
    expect(NATIVE_1M_MODELS).toContain('claude-opus-5');
    expect(KNOWN_200K_MODELS).toContain('claude-sonnet-4-6');
  });
});

describe('effectiveContextWindow — Claude Code, first-party Anthropic', () => {
  test('a native-1M model on a first-party launch gets 1M', () => {
    const w = effectiveContextWindow(claude({ model: 'claude-fable-5-1' }));
    expect(w).toMatchObject({
      tokens: LARGE_CONTEXT_WINDOW_TOKENS,
      known: true,
    });
    expect(w.remedy).toBeUndefined();
  });

  test('the [1m] suffix asks for 1M even when the upstream is not Anthropic', () => {
    const w = effectiveContextWindow(claude({
      model: 'claude-opus-5[1m]',
      primaryUpstream: 'https://llm.internal.example.com',
    }));
    expect(w).toMatchObject({ tokens: LARGE_CONTEXT_WINDOW_TOKENS, known: true });
    expect(w.reason).toContain('[1m]');
    expect(w.remedy).toBeUndefined();
  });

  test('a known 200k model stays at 200k even on a first-party launch', () => {
    const w = effectiveContextWindow(claude({ model: 'claude-sonnet-4-6' }));
    expect(w).toMatchObject({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: true,
    });
    // INVARIANT: a 200k model is not a failure of lazy's proxy. Reporting a
    // remedy here would tell the human to "fix" a window that is working as
    // designed.
    expect(w.remedy).toBeUndefined();
  });
});

describe('effectiveContextWindow — Claude Code, not first-party', () => {
  // INVARIANT: a native-1M model whose traffic does not land at Anthropic is
  // capped at 200k by Claude Code itself, because ANTHROPIC_BASE_URL points at
  // lazy's proxy and the harness's host allowlist is api.anthropic.com only.
  // Doctor must name that cap and say what to change — this is the bug the
  // module exists to surface, and the flag in targetEnvVars is what prevents
  // it for an Anthropic upstream.
  test('a native-1M model on a redirected primary upstream is capped, with a remedy', () => {
    const w = effectiveContextWindow(claude({
      model: 'claude-opus-5',
      primaryUpstream: 'https://llm.internal.example.com',
    }));
    expect(w).toMatchObject({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: true,
    });
    expect(w.remedy).toBeDefined();
    expect(w.reason).toContain("Anthropic's own API");
    expect(w.remedy).toContain('api.anthropic.com');
  });

  test('an unresolved primary upstream is treated as not first-party', () => {
    const w = effectiveContextWindow(claude({
      model: 'claude-fable-5-1',
      primaryUpstream: undefined,
    }));
    expect(w.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(true);
    expect(w.remedy).toBeDefined();
  });

  test('a local model server (credential none) is never first-party', () => {
    const w = effectiveContextWindow(claude({
      model: 'qwen3-coder',
      endpoint: 'http://localhost:11434',
      pinned: true,
      credential: NO_CREDENTIAL,
      primaryUpstream: ANTHROPIC,
    }));
    // Unknown model (not in either table) + not first-party → default, unverified.
    expect(w.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(false);
  });
});

describe('effectiveContextWindow — unknown models and other harnesses', () => {
  test('a short alias cannot be resolved locally, but a first-party launch says so', () => {
    const w = effectiveContextWindow(claude({ model: 'opus' }));
    expect(w.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(false);
    expect(w.reason).toContain('short alias');
    expect(w.reason).toContain('first-party');
    expect(w.remedy).toBeUndefined();
  });

  test('an unrecognized claude-* id is never claimed to be 1M', () => {
    const w = effectiveContextWindow(claude({ model: 'claude-future-9' }));
    expect(w.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(w.known).toBe(false);
    expect(w.reason).toContain(CONTEXT_WINDOW_VERIFIED_VERSION);
  });

  test('a non-Claude-Code harness reports the default as unverified', () => {
    const w = effectiveContextWindow(claude({
      harness: 'cursor',
      model: 'auto',
      wire: 'openai',
      credential: 'cursor',
    }));
    expect(w).toMatchObject({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      known: false,
    });
    expect(w.reason).toContain('cursor');
  });
});
