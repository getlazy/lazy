/**
 * A LIVE ChatGPT-subscription session: the stored credential, refreshed when it
 * is about to expire, with the rotated token written back.
 *
 * The proxy calls this per request (src/proxy/credential-deps.ts). It is the
 * only thing that should call {@link refreshChatGptTokens} — one funnel, because
 * a refresh ROTATES the refresh token and two concurrent refreshes would each
 * invalidate the other's, logging the user out with nothing anywhere saying why.
 * The per-name promise chain below is what makes concurrent turns share one
 * refresh instead of racing.
 *
 * ENV OVERRIDE, AND WHERE THE REFRESHED TOKEN LIVES. `CHATGPT_AUTH` overrides
 * the store, like every other credential's env var. lazy still refreshes it when
 * it has gone stale — a turn must not fail on a token that CAN be renewed — but
 * it cannot persist the result: the environment of an already-running daemon is
 * not lazy's to rewrite, and silently moving a credential from the variable the
 * user exported into the store would be exactly the hidden side effect CLAUDE.md
 * forbids. The renewed session therefore lives in {@link renewed}, an in-memory
 * map, for this daemon's lifetime, which is why the store is the documented home.
 *
 * That map is NOT a cache in the optimisation sense — it is what makes the env
 * path work at all. A refresh RETIRES the refresh token it used. Without
 * somewhere to put the replacement, every request would re-read the same stale
 * value out of the environment and present the retired token to the OAuth
 * endpoint again: one working turn, then 401s, plus a request-rate hammering of
 * that endpoint. Keyed on the SOURCE VALUE, so re-exporting a new session
 * invalidates the entry rather than being shadowed by it.
 */

import { logger } from '../utils/logger';
import { resolveCredential, setCredential } from './store';
import {
  type ChatGptTokens,
  needsRefresh,
  parseChatGptTokens,
  refreshChatGptTokens,
  serializeChatGptTokens,
} from './chatgpt-tokens';

/** Credential name holding the ChatGPT subscription session. */
export const CHATGPT_CREDENTIAL = 'chatgpt';

/** A resolved session and where its secret came from. */
export interface ChatGptSession {
  tokens: ChatGptTokens;
  source: 'env' | 'store';
  /** True when this call refreshed the access token. */
  refreshed: boolean;
}

/**
 * Serializes refreshes per (project, credential name). Keyed rather than a
 * single global chain so one project's slow token endpoint cannot stall
 * another's requests.
 */
const refreshChains = new Map<string, Promise<unknown>>();

function chainKey(projectRoot: string, name: string): string {
  // JSON rather than a delimiter: a credential name is constrained, but a
  // project path is not, and a separator that can occur inside either half
  // would make two different pairs share one chain.
  return JSON.stringify([projectRoot, name]);
}

/**
 * Sessions this daemon has renewed, by (project, credential name).
 *
 * `from` is the SOURCE VALUE the renewal started from — the exact string read
 * out of the env var or the store. An entry is served only while the source
 * still reads that way, so a user who exports a freshly-imported session gets
 * theirs rather than the one lazy renewed from the old one. Unbounded only in
 * the number of distinct (project, name) pairs a daemon serves, which is the
 * number of projects it has, and each entry is replaced rather than appended.
 */
const renewed = new Map<string, { from: string; tokens: ChatGptTokens }>();

/** A still-usable renewed session for this exact source value, or null. */
function renewedFor(key: string, sourceValue: string): ChatGptTokens | null {
  const entry = renewed.get(key);
  if (!entry || entry.from !== sourceValue) return null;
  // A renewal that has itself aged out is no better than the source; drop it so
  // the next refresh starts from the newest refresh token we hold.
  if (needsRefresh(entry.tokens)) return null;
  return entry.tokens;
}

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = refreshChains.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  refreshChains.set(key, run.catch(() => {}));
  return run;
}

/**
 * The ChatGPT session to present upstream right now, or null when none is
 * stored.
 *
 * Null means "nothing configured" and is the caller's cue to produce the
 * actionable "run codex login" message. A credential that IS present but is
 * broken — malformed JSON, a revoked refresh token — THROWS: the two must not
 * read alike, or a user with a revoked session is told to set one up again while
 * their real problem goes unnamed.
 *
 * @param name - Credential name, so a project can hold a second subscription
 *               under a name of its own (`credential = "personal-chatgpt"`).
 * @param opts.force - Renew NOW, whatever the expiry says. For `lazy auth
 *   refresh`, which exists so the renewal round trip can be exercised on demand
 *   rather than only discovered hours later when a token first ages out.
 *   Deliberately not something the proxy ever passes: an unconditional refresh
 *   per request would retire a live refresh token every time.
 */
export async function resolveChatGptSession(
  projectRoot: string,
  name: string = CHATGPT_CREDENTIAL,
  opts: { force?: boolean } = {},
): Promise<ChatGptSession | null> {
  const stored = await resolveCredential(projectRoot, name);
  if (!stored) return null;

  const key = chainKey(projectRoot, name);
  const describe = (source: 'env' | 'store'): string =>
    source === 'env' ? `the ${stored.envVar} environment variable` : `the stored "${name}" credential`;

  // A session this daemon already renewed from exactly this source value beats
  // the source itself — for the env path it is the ONLY place the renewal went.
  const alreadyRenewed = opts.force ? null : renewedFor(key, stored.value);
  if (alreadyRenewed) {
    return { tokens: alreadyRenewed, source: stored.source, refreshed: false };
  }

  const tokens = parseChatGptTokens(stored.value, describe(stored.source));
  if (!opts.force && !needsRefresh(tokens)) {
    return { tokens, source: stored.source, refreshed: false };
  }

  return serialized(key, async () => {
    // Re-read inside the chain: a refresh that completed while this call was
    // queued has already produced a fresh token, and refreshing again would
    // retire a perfectly good refresh token for nothing.
    const current = await resolveCredential(projectRoot, name);
    const source = current?.source ?? stored.source;
    const sourceValue = current?.value ?? stored.value;

    const renewedInFlight = opts.force ? null : renewedFor(key, sourceValue);
    if (renewedInFlight) {
      return { tokens: renewedInFlight, source, refreshed: false };
    }

    // REFRESH FROM THE NEWEST TOKENS WE HOLD, not from the source. On the env
    // path the source never changes, and its refresh token was retired by our
    // own previous renewal — starting from it again would present a dead token
    // to the OAuth endpoint on every request. The entry may be past its access
    // token's expiry (that is why we are here); what matters is that its REFRESH
    // token is the live one.
    const held = renewed.get(key);
    const base = held?.from === sourceValue
      ? held.tokens
      : parseChatGptTokens(sourceValue, describe(source));
    if (!opts.force && !needsRefresh(base)) {
      return { tokens: base, source, refreshed: false };
    }

    const refreshed = await refreshChatGptTokens(base);
    // Record it BEFORE handing it out, whichever source it came from: the
    // refresh token behind `base` is already retired upstream at this point, so
    // anything that loses the replacement loses the session.
    renewed.set(key, { from: sourceValue, tokens: refreshed });

    if (source === 'store') {
      // Persisted too, so it survives this daemon. A failure here is loud rather
      // than deferred, for the same reason.
      await setCredential(projectRoot, {
        provider: name,
        kind: 'oauth',
        secret: serializeChatGptTokens(refreshed),
      });
      logger.info(`[credentials] refreshed the ChatGPT subscription token ("${name}")`);
    } else {
      logger.warn(
        `[credentials] refreshed the ChatGPT subscription token from the environment ("${name}"). ` +
        `An environment variable cannot be written back, so the renewed session lives only as long ` +
        `as this daemon — and the refresh token in ${stored.envVar} is now retired upstream. ` +
        `Store it instead, so it survives a restart: lazy auth import chatgpt`,
      );
    }
    return { tokens: refreshed, source, refreshed: true };
  });
}

/**
 * Forget every renewed session. TESTS ONLY — the map is process-lifetime state,
 * and a test that renewed one must not leak it into the next.
 */
export function __resetRenewedSessionsForTests(): void {
  renewed.clear();
}
