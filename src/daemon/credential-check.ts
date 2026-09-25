/**
 * "Does this credential actually work?" — asked on purpose, right now.
 *
 * WHY THIS EXISTS, GIVEN credential-gate.ts SAYS NOT TO PROBE: the gate runs at
 * DAEMON STARTUP, on every start, for a credential nobody asked about. Probing
 * there would tie starting a daemon to network reachability and would still say
 * nothing about an hour later, which is why it checks presence only. This is the
 * opposite situation in every respect: a human has just pressed a button that
 * says "Test credential" and is waiting for the answer. A probe is the only
 * honest way to answer it, and its cost lands on the person who asked for it.
 *
 * The passive verdict (proxy/auth-verdict.ts) remains the everyday signal — it
 * costs nothing and covers every request. This is the active one, for the two
 * cases the passive one structurally cannot serve:
 *
 *   - a credential that has never been used, so there is no evidence either way
 *     ("I pasted a token; is it any good?" — before running a turn to find out)
 *   - a credential the audit trail condemns that the owner believes is fine
 *     (a check that gets past authentication is recorded, so the verdict clears)
 *
 * WHAT IT PROVES: that the secret the DAEMON holds — not the copy the control
 * plane holds — is accepted by the same upstream the proxy forwards turns to,
 * presented in the same header shape the credential's kind implies. That whole
 * chain is what breaks in practice, and no check made anywhere else covers it.
 */

import { randomUUID } from 'crypto';
import { ANTHROPIC_OAUTH_BETA } from '../proxy/target-credentials';
import { join } from 'path';
import { loadConfig } from '../config/loader';
import { logger } from '../utils/logger';
import { REDACTED } from '../utils/redact';
import { ProxyAuditLog } from '../proxy/audit-log';
import type { ProxyAuditRecord } from '../storage/types';
import { getUserCredential, type UserCredentialKind } from './user-credentials';

/**
 * Primary probe for API keys: list models.
 *
 * Authenticated exactly like a real turn, answered by the same auth layer, and
 * names no model — so a retired model id cannot rot this check. Verified against
 * Anthropic's Models API docs (GET /v1/models, x-api-key or Bearer + version).
 */
const MODELS_PROBE_PATH = '/v1/models';

/**
 * Fallback probe for OAuth setup-tokens.
 *
 * Claude Code OAuth tokens are documented as "model requests only" — they
 * authenticate to /v1/messages (and count_tokens) but not to GET /v1/models.
 * Token counting bills nothing; max_tokens on a messages call would.
 */
const OAUTH_PROBE_PATH = '/v1/messages/count_tokens';

/** Cheap current model for the OAuth fallback; rot handled below via not_found. */
const OAUTH_PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** A probe must not be able to hang a web request that is waiting on it. */
const PROBE_TIMEOUT_MS = 15_000;

export type CredentialCheckOutcome =
  /** Upstream accepted the credential. */
  | 'ok'
  /** No credential is stored here for this principal at all. */
  | 'no-credential'
  /** Upstream answered 401/403: the token is expired, revoked or not entitled. */
  | 'rejected'
  /** The upstream could not be reached — says nothing about the credential. */
  | 'unreachable'
  /** Answered, but with a status that is neither acceptance nor rejection. */
  | 'unexpected';

export interface CredentialCheckResult {
  userId: string;
  outcome: CredentialCheckOutcome;
  /** True only for `ok`. Convenience for callers that just want a verdict. */
  ok: boolean;
  /** Upstream HTTP status, or null when there was no answer. */
  status: number | null;
  /** Stored credential kind, when one was found. Never the secret. */
  kind: UserCredentialKind | null;
  /** Stored operator label, when one was found. Never the secret. */
  label: string | null;
  /** One sentence stating what happened, safe to show a human verbatim. */
  detail: string;
  /**
   * What the upstream said, when it said anything and refused — scrubbed and
   * bounded. Separate from `detail` so a caller with its own voice (a web UI
   * that never says "daemon" to a user) can quote the useful part without
   * re-parsing a sentence.
   */
  upstreamError: string | null;
  /** Upstream that was asked. */
  upstream: string;
  /** When the check completed (unix ms). */
  checkedAt: number;
}

interface ProbeSpec {
  method: 'GET' | 'POST';
  path: string;
  endpoint: ProxyAuditRecord['endpoint'];
  model: string | null;
  body?: string;
}

/** Which upstream call exercises this credential kind without naming a rot-prone model when possible. */
function probeSpec(kind: UserCredentialKind): ProbeSpec {
  if (kind === 'api-key') {
    return { method: 'GET', path: MODELS_PROBE_PATH, endpoint: 'other', model: null };
  }
  return {
    method: 'POST',
    path: OAUTH_PROBE_PATH,
    endpoint: 'count_tokens',
    model: OAUTH_PROBE_MODEL,
    body: JSON.stringify({ model: OAUTH_PROBE_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
  };
}

/** Headers for a credential of this kind — the shape the proxy preserves. */
function probeHeaders(kind: UserCredentialKind, token: string, method: 'GET' | 'POST'): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
  }
  if (kind === 'api-key') {
    headers['x-api-key'] = token;
  } else {
    // OAuth setup-tokens go as a bearer plus the OAuth beta header, never as
    // x-api-key. Same mapping the launch path and the proxy encode — literally
    // the same constant, so a change to the flag lands in every sender at once.
    headers.authorization = `Bearer ${token}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETA;
  }
  return headers;
}

/**
 * True when Anthropic refused because the probe named a model that no longer
 * exists — auth succeeded, the probe configuration did not.
 */
function isModelNotFoundError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
    const err = parsed?.error;
    if (err?.type !== 'not_found_error') return false;
    return typeof err.message === 'string' && err.message.toLowerCase().includes('model');
  } catch {
    return body.includes('not_found_error') && body.toLowerCase().includes('model');
  }
}

/**
 * First line of an upstream error body, bounded and scrubbed.
 *
 * The body is arbitrary text from a server we do not control, and it goes
 * straight to a human's screen and into the audit log. `redactSecretValues`
 * cannot help: it scrubs credentials found in the daemon's ENVIRONMENT, and a
 * per-user credential is deliberately never there. So the one secret this call
 * had in its hands is scrubbed explicitly — an upstream that echoes the token
 * back in its error (or a misconfigured proxy standing in for one) must not be
 * able to publish it through us.
 */
function upstreamErrorText(body: string, token: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const line = trimmed.split('\n')[0]!;
  const bounded = line.length > 300 ? `${line.slice(0, 300)}…` : line;
  return token ? bounded.split(token).join(REDACTED) : bounded;
}

/**
 * Record the probe on the proxy audit trail, so the passive per-owner verdict
 * agrees with what the human was just told.
 *
 * This IS an upstream request made on that owner's credential, which is exactly
 * what the trail records — so a successful check clears their standing
 * rejection by the ordinary self-clearing rule, and a failed one raises it,
 * with no second source of truth to keep in step. `role` names the probe so a
 * reader of `lazy audit` can tell it from agent traffic.
 *
 * Best-effort by design: a telemetry write that fails must not turn an answered
 * question into an error. It is logged, not swallowed.
 */
/**
 * Append one line to the proxy audit trail for a credential verdict event.
 *
 * Exported so `putUserCredential` can clear a standing rejection the moment a
 * new secret lands — the timestamp comparison alone is not enough when a 401
 * and the replacement share a millisecond, or when the member has not yet run a
 * turn to produce a newer success.
 */
export async function appendCredentialVerdictRecord(
  dataDir: string,
  input: {
    userId: string;
    role: 'credential-check' | 'credential-replaced';
    upstream: string;
    method: 'GET' | 'POST';
    path: string;
    endpoint: ProxyAuditRecord['endpoint'];
    model: string | null;
    status: number | null;
    error: string | null;
    durationMs: number;
  },
): Promise<void> {
  const record: ProxyAuditRecord = {
    id: randomUUID(),
    seq: 0,
    ts: Date.now(),
    role: input.role,
    taskId: null,
    userId: input.userId,
    backend: 'anthropic',
    upstream: input.upstream,
    method: input.method,
    path: input.path,
    endpoint: input.endpoint,
    model: input.model,
    tier: input.model ? 'haiku' : null,
    stream: false,
    requestShape: null,
    toolUses: [],
    toolResults: [],
    status: input.status,
    usage: null,
    stopReason: null,
    error: input.error,
    durationMs: input.durationMs,
    reroute: null,
  };

  try {
    await new ProxyAuditLog(dataDir).append(record);
  } catch (err) {
    logger.warn(
      `Credential verdict record for user ${input.userId} could not be written to the proxy audit log: ` +
      `${err instanceof Error ? err.message : String(err)}. The operation itself was unaffected.`,
    );
  }
}

/** Clear a standing dead-token verdict when a new credential replaces the old one. */
export async function clearUserAuthRejection(dataDir: string, userId: string): Promise<void> {
  await appendCredentialVerdictRecord(dataDir, {
    userId,
    role: 'credential-replaced',
    upstream: 'lazy://credential-store',
    method: 'POST',
    path: '/_lazy/credential-replaced',
    endpoint: 'other',
    model: null,
    status: 200,
    error: null,
    durationMs: 0,
  });
}

/**
 * Exercise one principal's stored credential against the upstream and say what
 * happened, in terms a person can act on.
 *
 * Never throws for a credential problem — a rejection is an ANSWER, not an
 * error. It throws only if the daemon cannot read its own configuration.
 */
export async function checkUserCredential(
  projectRoot: string,
  userId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CredentialCheckResult> {
  const config = await loadConfig(projectRoot);
  // The upstream the proxy forwards to, so the probe lands where a turn would.
  // With the proxy off there is no such setting and turns go straight out, so
  // the probe follows them to the same default.
  const upstream = (
    config.proxy?.upstream ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  ).replace(/\/+$/, '');
  const dataDir = join(projectRoot, config.data.path);
  const doFetch = options.fetchImpl ?? fetch;

  const credential = await getUserCredential(projectRoot, userId);
  if (!credential) {
    return {
      userId,
      outcome: 'no-credential',
      ok: false,
      status: null,
      kind: null,
      label: null,
      detail:
        `This daemon holds no Anthropic credential for '${userId}'. Store one before ` +
        `running turns as this user.`,
      upstreamError: null,
      upstream,
      checkedAt: Date.now(),
    };
  }

  const base = {
    userId,
    kind: credential.kind,
    label: credential.label,
    upstream,
  };

  const spec = probeSpec(credential.kind);
  const kindName = credential.kind === 'api-key' ? 'API key' : 'OAuth setup-token';

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await doFetch(`${upstream}${spec.path}`, {
      method: spec.method,
      headers: probeHeaders(credential.kind, credential.token, spec.method),
      body: spec.body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable is deliberately NOT a credential verdict: telling someone
    // their token is bad because our network is down is the failure this whole
    // area exists to stop making.
    const message = err instanceof Error ? err.message : String(err);
    await appendCredentialVerdictRecord(dataDir, {
      userId,
      role: 'credential-check',
      upstream,
      method: spec.method,
      path: spec.path,
      endpoint: spec.endpoint,
      model: spec.model,
      status: null,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return {
      ...base,
      outcome: 'unreachable',
      ok: false,
      status: null,
      detail:
        `Could not reach ${upstream} to test the credential (${message}). ` +
        `This says nothing about whether the credential is valid.`,
      upstreamError: null,
      checkedAt: Date.now(),
    };
  }

  const status = response.status;
  const body = await response.text().catch(() => '');
  const upstreamError = status >= 400 ? upstreamErrorText(body, credential.token) : null;
  await appendCredentialVerdictRecord(dataDir, {
    userId,
    role: 'credential-check',
    upstream,
    method: spec.method,
    path: spec.path,
    endpoint: spec.endpoint,
    model: spec.model,
    status,
    error: upstreamError,
    durationMs: Date.now() - startedAt,
  });

  if (status >= 200 && status < 300) {
    return {
      ...base,
      outcome: 'ok',
      ok: true,
      status,
      detail: `${upstream} accepted this ${kindName}.`,
      upstreamError: null,
      checkedAt: Date.now(),
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      outcome: 'rejected',
      ok: false,
      status,
      detail:
        `${upstream} refused this ${kindName} (HTTP ${status}` +
        `${upstreamError ? `: ${upstreamError}` : ''}). It is expired, revoked, or not ` +
        `entitled to this API — replace it with a new one.`,
      upstreamError,
      checkedAt: Date.now(),
    };
  }

  // Anything else got PAST authentication — including a retired probe model.
  // That is a pass for the question asked; callers must not render it as an
  // auth failure.
  if (isModelNotFoundError(body)) {
    return {
      ...base,
      outcome: 'ok',
      ok: true,
      status,
      detail:
        `${upstream} accepted this ${kindName}. The probe model is outdated (Anthropic returned ` +
        `model not found) — please report this so we can update the probe.`,
      upstreamError,
      checkedAt: Date.now(),
    };
  }

  return {
    ...base,
    outcome: 'ok',
    ok: true,
    status,
    detail:
      `${upstream} accepted this ${kindName}. The test request returned HTTP ${status}` +
      `${upstreamError ? `: ${upstreamError}` : ''}, which is not an authentication failure.`,
    upstreamError,
    checkedAt: Date.now(),
  };
}
