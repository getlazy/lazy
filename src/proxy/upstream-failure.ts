/**
 * Who failed when an upstream request threw, and the one replay that hides a
 * stale pooled connection.
 *
 * WHY: people saw `502 ECONNRESET: The socket connection was closed
 * unexpectedly. For more information, pass verbose: true …` in Claude Code,
 * then "Retrying in 8s · attempt 6/10". That text is Bun's own fetch error,
 * forwarded verbatim by the proxy — nobody could tell whether Anthropic, the
 * network, or lazy had failed.
 *
 * The cause, reproduced on Bun 1.4.4 (2026-10-25) with a local HTTP/1.1
 * upstream that closes idle keep-alive connections: a socket the upstream had
 * ALREADY closed is detected and replaced by Bun without an error, but when the
 * upstream closes a pooled socket at the moment our next request is crossing
 * it, `fetch` rejects with exactly that ECONNRESET message within ~1 ms, before
 * any response byte. The next request, on a fresh connection, succeeds. That
 * is the idle-keep-alive race every HTTP client pool has with a server (or CDN)
 * that reaps idle connections — not an upstream outage.
 *
 * So a connection reset that arrives BEFORE ANY RESPONSE HEADERS is replayed
 * ONCE, immediately, on a fresh (non-pooled) connection — and only when the
 * request body is a buffered value that can be sent again. Safe because the
 * upstream cannot have answered (fetch resolves at the headers; a throw here
 * means none arrived), and because the client already replays the very same
 * request itself a few seconds later — this replay only removes that wait.
 * Never more than once: a second reset is a real failure and is reported.
 *
 * Everything that still fails is described with the PARTY that failed —
 * "Anthropic (api.anthropic.com, …) reset the connection 3ms into the
 * request" — and never as a bare Bun message. Durations are written with no
 * space ("401ms"): the agent failure taxonomy reads a bare `401`/`403` as an
 * auth failure, and a transient reset must never stop a task as fatal.
 */

import type { ProxyUpstreamFailure } from '../storage/types';
import { describeUpstreamFailure, isUpstreamTimeout } from './upstream-timeout';

/** What kind of failure a thrown upstream fetch was. */
export type UpstreamFailureKind = 'reset' | 'timeout' | 'refused' | 'dns' | 'tls' | 'other';

/** Classify a fetch rejection. `code` is the error's own code when it has one. */
export function classifyFetchFailure(err: unknown): { kind: UpstreamFailureKind; code: string | null } {
  if (isUpstreamTimeout(err)) return { kind: 'timeout', code: 'ETIMEDOUT' };
  const code = typeof (err as { code?: unknown } | null)?.code === 'string'
    ? (err as { code: string }).code
    : null;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ECONNRESET' || code === 'EPIPE' || /closed unexpectedly|ECONNRESET|socket hang up/i.test(message)) {
    return { kind: 'reset', code: code ?? 'ECONNRESET' };
  }
  if (code === 'ECONNREFUSED' || code === 'ConnectionRefused' || /ECONNREFUSED|Unable to connect/i.test(message)) {
    return { kind: 'refused', code: code ?? 'ECONNREFUSED' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|ENOTFOUND|DNS/i.test(message)) {
    return { kind: 'dns', code: code ?? 'ENOTFOUND' };
  }
  if ((code && /CERT|SSL|TLS|SIGNATURE/i.test(code)) || /certificate|TLS|SSL/i.test(message)) {
    return { kind: 'tls', code };
  }
  return { kind: 'other', code };
}

const PROVIDERS: Array<{ name: string; match: (host: string) => boolean }> = [
  { name: 'Anthropic', match: (h) => h === 'anthropic.com' || h.endsWith('.anthropic.com') },
  { name: 'OpenAI', match: (h) => h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h.endsWith('openai.com') },
  { name: 'Cursor', match: (h) => h.endsWith('cursor.sh') || h.endsWith('cursor.com') },
];

/** The host part of an upstream URL, or the raw string when it is not a URL. */
export function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host;
  } catch {
    // A test double or a misconfigured upstream: show what we were given.
    return upstream;
  }
}

/**
 * The provider an upstream belongs to, as a person would name it: a known
 * provider by host, else the configured endpoint by name, else the host.
 * Built-in endpoint ids (`builtin:anthropic`) say nothing the host does not.
 */
export function providerName(upstream: string, endpoint?: string | null): string {
  const host = upstreamHost(upstream).replace(/:\d+$/, '').toLowerCase();
  const known = PROVIDERS.find((p) => p.match(host));
  if (known) return known.name;
  if (endpoint && !endpoint.startsWith('builtin:')) return `endpoint ${endpoint}`;
  return host || upstream;
}

/** What a failed fetch carried about its own attempts (set by {@link fetchReplayingStaleConnection}). */
export interface FetchAttemptInfo {
  /** Ms from the start of the final attempt to its failure. */
  afterMs: number;
  /** True when a first attempt was reset and this failure is the replay's. */
  replayed: boolean;
}

const attemptInfo = new WeakMap<object, FetchAttemptInfo>();

/** The attempt info a fetch failure was tagged with, if any. */
export function fetchAttemptInfo(err: unknown): FetchAttemptInfo | null {
  return err !== null && typeof err === 'object' ? attemptInfo.get(err) ?? null : null;
}

function tag(err: unknown, info: FetchAttemptInfo): unknown {
  const e = err !== null && typeof err === 'object' ? err : new Error(String(err));
  attemptInfo.set(e, info);
  return e;
}

/**
 * Run `attempt`, and when it throws a connection reset before any response,
 * run it once more on a fresh connection (`fresh: true` — the caller passes
 * `keepalive: false` so the pool's stale socket cannot be picked again).
 *
 * `replayable` must be false whenever the request body is a stream that has
 * been (partly) consumed. A client abort is never replayed. The thrown error is
 * tagged with {@link FetchAttemptInfo} either way.
 */
export async function fetchReplayingStaleConnection(
  attempt: (fresh: boolean) => Promise<Response>,
  opts: {
    replayable: boolean;
    signal?: AbortSignal;
    /** Called before the replay; and `onReplayed` once it succeeded. */
    onReplay?: (first: { code: string | null; afterMs: number }) => void;
    onReplayed?: (first: { code: string | null; afterMs: number }) => void;
  },
): Promise<Response> {
  let start = Date.now();
  try {
    return await attempt(false);
  } catch (err) {
    const afterMs = Date.now() - start;
    const { kind, code } = classifyFetchFailure(err);
    if (kind !== 'reset' || !opts.replayable || opts.signal?.aborted) throw tag(err, { afterMs, replayed: false });
    opts.onReplay?.({ code, afterMs });
    start = Date.now();
    try {
      const response = await attempt(true);
      opts.onReplayed?.({ code, afterMs });
      return response;
    } catch (again) {
      throw tag(again, { afterMs: Date.now() - start, replayed: true });
    }
  }
}

/** Who a request went to, for the message that names them. */
export interface UpstreamParty {
  upstream: string;
  /** Configured endpoint the request was routed through, when known. */
  endpoint?: string | null;
  /** Agent profile the request was made for, when known. */
  profile?: string | null;
  /** Non-secret label of the credential lazy attached, when it attached one. */
  credential?: string | null;
}

/** "Anthropic (api.anthropic.com, profile `x`, credential `Y`)". */
export function describeParty(party: UpstreamParty): string {
  const details = [upstreamHost(party.upstream)];
  if (party.endpoint && !party.endpoint.startsWith('builtin:')) details.push(`endpoint \`${party.endpoint}\``);
  if (party.profile) details.push(`profile \`${party.profile}\``);
  if (party.credential) details.push(`credential \`${party.credential}\``);
  return `${providerName(party.upstream, party.endpoint)} (${details.join(', ')})`;
}

/** The audit fields for a thrown upstream fetch. */
export type UpstreamFailureAudit = ProxyUpstreamFailure;

/**
 * The message a person sees for a thrown upstream fetch, naming the provider,
 * and the structured fields the audit record keeps beside it.
 */
export function describeAttributedFailure(
  err: unknown,
  party: UpstreamParty,
  timeoutSeconds: number,
  fallbackAfterMs: number,
  /** `mid-response`: the response had started (headers in) when the read failed. Never replayed. */
  phase: 'before-response' | 'mid-response' = 'before-response',
): { message: string; failure: UpstreamFailureAudit } {
  const { kind, code } = classifyFetchFailure(err);
  const info = fetchAttemptInfo(err);
  const afterMs = info?.afterMs ?? fallbackAfterMs;
  const replayed = info?.replayed ?? false;
  const who = describeParty(party);
  const raw = err instanceof Error ? err.message : String(err);
  const codeNote = code ? ` (${code})` : '';
  let message: string;
  switch (kind) {
    case 'timeout':
      message = `${who}: ${describeUpstreamFailure(err, party.upstream, timeoutSeconds)}`;
      break;
    case 'reset':
      message =
        `${who} reset the connection ${afterMs}ms into the request${codeNote}, ` +
        (phase === 'mid-response' ? 'after the response had started' : 'before sending any response') +
        (replayed
          ? '; lazy had already retried once on a fresh connection and that was reset too'
          : '') +
        '. This is the provider or the network between, not lazy; the client will retry.';
      break;
    case 'refused':
      message = `${who} refused the connection${codeNote}: nothing is accepting connections there — check that it is running and reachable.`;
      break;
    case 'dns':
      message = `${who}: the host name could not be resolved${codeNote}. Check the upstream address and this machine's DNS.`;
      break;
    case 'tls':
      message = `${who}: the TLS handshake failed${codeNote}: ${raw}`;
      break;
    default:
      message = `${who} failed ${afterMs}ms into the request${codeNote}` +
        `${phase === 'mid-response' ? ', after the response had started' : ''}: ${raw}`;
  }
  return {
    message,
    failure: {
      kind, code, afterMs, provider: providerName(party.upstream, party.endpoint), replayed,
      ...(phase === 'mid-response' ? { midResponse: true } : {}),
    },
  };
}

/** Prefix for failures that are lazy's own, so they are never mistaken for a provider's. */
export const LAZY_PROXY_FAILED_PREFIX = "lazy's proxy failed";
