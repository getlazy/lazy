/**
 * The ChatGPT-subscription OAuth credential: what lazy stores, and how it is
 * kept fresh.
 *
 * WHAT IT IS. `codex login` / `codex login --device-auth` completes an OAuth
 * flow and writes `~/.codex/auth.json` on the machine it ran on. That file is
 * the whole credential: a short-lived `access_token`, a long-lived
 * `refresh_token`, and the `account_id` the ChatGPT backend attributes usage to.
 * A task container never sees the host's file — it presents a placeholder like
 * every other credential, and the proxy swaps in a live access token upstream
 * (src/proxy/credential-deps.ts).
 *
 * WHY LAZY REFRESHES, NOT THE CONTAINER. The codex CLI will refresh the token
 * itself, but only when its auth.json carries an `account_id` — and doing so
 * ROTATES the refresh token. A container that rotated it would invalidate the
 * host's copy and then throw the replacement away with its own filesystem,
 * leaving the user logged out with nothing to show why. lazy therefore keeps the
 * account id out of the container entirely (verified: codex then logs "Skipping
 * auth reload because no account id is available" and never refreshes), and does
 * the refresh here, on the host, writing the rotated token straight back into
 * the credential store.
 *
 * WHAT IS STORED. The credential store holds one single-line secret per name, so
 * the value stored under `chatgpt` is this token set as COMPACT JSON —
 * {@link serializeChatGptTokens}. {@link parseChatGptTokens} accepts either that
 * or a verbatim `auth.json`, because the file is what a user actually has in
 * their hand after running `codex login`.
 */

import { join } from 'path';

/** Endpoint `codex login` refreshes against (verified in codex-cli 0.152.1). */
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * The codex CLI's own public OAuth client id, read out of the shipped 0.152.1
 * binary next to the token URL above.
 *
 * A refresh is only ever accepted for the client the token was ISSUED to, so
 * this is not a choice lazy gets to make — a different id would simply be
 * refused. Public by construction (it ships in every copy of the CLI); it is an
 * identifier, not a secret.
 */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * How long a refresh may take before it is abandoned.
 *
 * Generous for one HTTPS round trip, and short enough that a stalled endpoint
 * fails a turn rather than wedging the per-credential refresh chain every other
 * turn in the project queues behind.
 *
 * Overridable per call ({@link refreshChatGptTokens}) so a test can assert "it
 * gave up on its own signal" in milliseconds instead of paying the real bound in
 * wall-clock on every run. Production never passes one.
 */
export const REFRESH_TIMEOUT_MS = 20_000;

/** The ChatGPT OAuth session, as lazy stores and presents it. */
export interface ChatGptTokens {
  /** Short-lived bearer the proxy presents upstream. */
  accessToken: string;
  /** Long-lived token used to mint a new access token. Rotated on each refresh. */
  refreshToken: string;
  /** ChatGPT account this session bills, sent as the `chatgpt-account-id` header. */
  accountId: string | null;
  /** Identity token codex stores alongside the pair. Kept so a round-trip is lossless. */
  idToken: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read a JWT's payload claims without verifying the signature.
 *
 * NOT a security decision: the only thing read out of it is the expiry, to know
 * when to refresh, and the account id when the auth.json does not carry one
 * explicitly. Whether the token is genuinely valid is decided upstream, by the
 * service that issued it — a signature check here would add a key-distribution
 * problem and answer a question lazy does not act on. Returns null for anything
 * that is not a three-part JWT with a JSON payload.
 */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A token whose payload is not JSON tells us nothing about expiry, which is
    // the same answer as a token with no `exp` claim: fall through to "unknown",
    // which the caller treats as "refresh it". Never fatal — the token may still
    // authenticate perfectly well upstream.
    return null;
  }
}

/** Expiry of a JWT access token as epoch millis, or null when it does not say. */
export function accessTokenExpiry(token: string): number | null {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/** The ChatGPT account id a codex token carries in its claims, or null. */
function accountIdFromClaims(token: string): string | null {
  const auth = jwtClaims(token)?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return null;
  return asString((auth as Record<string, unknown>).chatgpt_account_id);
}

/**
 * Parse a stored ChatGPT credential, or a verbatim `~/.codex/auth.json`.
 *
 * Both shapes are accepted because both are things a user genuinely has: the
 * compact JSON lazy wrote, and the file `codex login` wrote. They differ only in
 * the wrapper — `{ auth_mode, tokens: {...} }` versus lazy's flat form — so one
 * parser reads both rather than two that can disagree.
 *
 * Throws with the reason on anything else. A credential that exists but is the
 * wrong shape must not read as "no credential": that sends a user re-running
 * `codex login` when the real problem is what they pasted.
 */
export function parseChatGptTokens(raw: string, source: string): ChatGptTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `A ChatGPT credential is the JSON that \`codex login\` writes to ~/.codex/auth.json.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object. Expected the contents of ~/.codex/auth.json.`);
  }
  const obj = parsed as Record<string, unknown>;

  const authMode = asString(obj.auth_mode);
  if (authMode !== null && authMode !== 'chatgpt') {
    throw new Error(
      `${source} is a codex auth.json in "${authMode}" mode, not a ChatGPT subscription session. ` +
      (authMode === 'apikey'
        ? `That file holds an OpenAI API key — store it with \`lazy auth set openai\` instead. ` +
          `To get a subscription session, run \`codex login\` (or \`codex login --device-auth\`).`
        : `Run \`codex login\` (or \`codex login --device-auth\`) and try again.`),
    );
  }

  // Flat (what lazy stores) or nested under `tokens` (what codex writes).
  const nested = obj.tokens;
  const tokens = (nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : obj) as Record<string, unknown>;

  const accessToken = asString(tokens.access_token);
  if (!accessToken) {
    throw new Error(
      `${source} has no access_token. Expected the contents of ~/.codex/auth.json after ` +
      `\`codex login\` (or \`codex login --device-auth\`).`,
    );
  }
  const refreshToken = asString(tokens.refresh_token);
  if (!refreshToken) {
    throw new Error(
      `${source} has an access_token but no refresh_token, so lazy could not keep it alive — a ` +
      `ChatGPT access token expires within hours. Re-run \`codex login\` and store the resulting ` +
      `~/.codex/auth.json.`,
    );
  }
  const idToken = asString(tokens.id_token);

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId:
      asString(tokens.account_id) ??
      (idToken ? accountIdFromClaims(idToken) : null) ??
      accountIdFromClaims(accessToken),
  };
}

/**
 * Serialize for the credential store: COMPACT, single-line JSON.
 *
 * `setCredential` rejects a secret containing a line break (a newline is a shell
 * hazard in the OS credential tools), and a pretty-printed auth.json is full of
 * them — so compacting is a requirement here, not a style choice.
 */
export function serializeChatGptTokens(tokens: ChatGptTokens): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
    ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
  });
}

/** True when the access token is expired, or expires soon enough to refresh now. */
export function needsRefresh(tokens: ChatGptTokens, now = Date.now()): boolean {
  const expiry = accessTokenExpiry(tokens.accessToken);
  // A token that does not say when it expires is refreshed: the cost is one
  // extra round trip, and the alternative is presenting a dead token upstream
  // and reporting an auth failure the user cannot act on.
  if (expiry === null) return true;
  return expiry - REFRESH_SKEW_MS <= now;
}

/**
 * Exchange the refresh token for a fresh access token.
 *
 * The response ROTATES the refresh token, so the caller must persist what comes
 * back — see `resolveChatGptTokens` in ./chatgpt-session.ts, which is the only
 * thing that should call this.
 */
export async function refreshChatGptTokens(
  tokens: ChatGptTokens,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<ChatGptTokens> {
  const body = new URLSearchParams({
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    scope: 'openid profile email',
  });

  let resp: Response;
  try {
    resp = await fetch(CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // BOUNDED, because refreshes are SERIALIZED per credential: a hung token
      // endpoint would otherwise hold the chain open forever and every
      // subsequent codex turn in the project would queue behind it — a transient
      // upstream stall turned into a permanently wedged daemon. One failed turn
      // is the correct blast radius.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // TimeoutError is what AbortSignal.timeout aborts with; say so, because
    // "fetch failed" sends someone looking at their own network when the answer
    // is that the endpoint did not respond in time.
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new Error(
      timedOut
        ? `${CHATGPT_TOKEN_URL} did not respond within ` +
          `${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} while refreshing ` +
          `the ChatGPT credential. Nothing was changed; the stored session is untouched. Retry the turn.`
        : `could not reach ${CHATGPT_TOKEN_URL} to refresh the ChatGPT credential: ` +
          `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
      `${CHATGPT_TOKEN_URL} refused to refresh the ChatGPT credential (HTTP ${resp.status}): ` +
      `${text.slice(0, 400)}. If the session was revoked or has been idle too long, run ` +
      `\`codex login\` again and re-import it with \`lazy auth import chatgpt\`.`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${CHATGPT_TOKEN_URL} answered HTTP ${resp.status} with a body that is not JSON ` +
      `(${err instanceof Error ? err.message : String(err)}): ${text.slice(0, 200)}`,
    );
  }

  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    throw new Error(
      `${CHATGPT_TOKEN_URL} answered HTTP ${resp.status} without an access_token. ` +
      `Nothing was changed; the stored credential is untouched.`,
    );
  }
  const idToken = asString(payload.id_token) ?? tokens.idToken;
  return {
    accessToken,
    // A refresh response that omits `refresh_token` means "keep using the one
    // you have" — dropping it would log the user out on the next refresh.
    refreshToken: asString(payload.refresh_token) ?? tokens.refreshToken,
    idToken,
    accountId:
      tokens.accountId ??
      (idToken ? accountIdFromClaims(idToken) : null) ??
      accountIdFromClaims(accessToken),
  };
}

/** Default path of the codex CLI's own auth file on this machine. */
export function codexAuthJsonPath(home: string): string {
  // CODEX_HOME relocates the whole codex state directory (verified against
  // 0.152.1), so a user who sets it keeps their auth.json there and lazy must
  // look where they actually put it.
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, 'auth.json') : join(home, '.codex', 'auth.json');
}
