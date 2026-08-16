/**
 * Credential redaction for anything lazy prints or writes to a log.
 *
 * Two seams, one rule set:
 *
 *  1. `redactSecrets(argv)` — argv about to be echoed under `[session] debug`.
 *     Container launch argv carries auth as `-e KEY=VALUE` pairs, so a raw
 *     `args.join(' ')` prints the live CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY
 *     in clear text — in the exact situation (debug on, output pasted into a bug
 *     report) where it is most likely to be shared.
 *
 *  2. `redactSecretValues(text)` — the logger boundary. Belt to the argv
 *     braces: whatever path a credential value takes into a log line, it is
 *     scrubbed on the way out.
 *
 * Redaction is driven by env var KEY NAMES, never by guessing which values look
 * secret. The keys are the ones lazy's own env builders can emit
 * (`ClaudeCodeAgent.getAuthEnvVars`, `CursorAgent.getAuthEnvVars`,
 * `QaAgent.getAuthEnvVars`, `targetEnvVars` in src/utils/role-target.ts), plus a
 * conservative name shape so a credential key added later is covered by default
 * rather than by remembering to update a list.
 *
 * Non-credential launch env (ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS,
 * DISABLE_TELEMETRY, GIT_SSH_COMMAND, …) is deliberately left intact: the debug
 * line has to stay useful, and an operator needs to see where traffic is
 * pointed and which mounts and image were used.
 */

/** The placeholder that replaces a credential value. */
export const REDACTED = '<redacted>';

/**
 * Env var keys lazy's own env builders can emit whose value is a credential.
 * Kept explicit (rather than relying on the shape rule alone) so the intent is
 * greppable from the call sites that produce them.
 */
export const CREDENTIAL_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CURSOR_API_KEY',
];

const CREDENTIAL_KEY_SET = new Set(CREDENTIAL_ENV_KEYS);

/**
 * Name shape for "this env var holds a credential".
 *
 * Matches the trailing word of an UPPER_SNAKE key: TOKEN, KEY, SECRET,
 * PASSWORD/PASSWD, CREDENTIAL(S), AUTH. That covers every key in
 * CREDENTIAL_ENV_KEYS and any future GITHUB_TOKEN / GITLAB_TOKEN / *_API_KEY
 * without a code change, and does not match the informational launch env
 * (ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, DISABLE_TELEMETRY, …).
 */
const CREDENTIAL_KEY_SHAPE = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH)$/;

/** True when `key` names an env var whose VALUE must never be logged. */
export function isCredentialEnvKey(key: string): boolean {
  if (CREDENTIAL_KEY_SET.has(key)) return true;
  return CREDENTIAL_KEY_SHAPE.test(key.toUpperCase());
}

/** `KEY=VALUE` argv element, e.g. what follows `-e` in a `docker run` argv. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Redact credential VALUES in a process argv, keeping everything else —
 * including the credential's key — visible.
 *
 * `['-e', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…']`
 *   becomes `['-e', 'CLAUDE_CODE_OAUTH_TOKEN=<redacted>']`.
 *
 * Position-independent on purpose: it rewrites any `KEY=VALUE` element with a
 * credential-shaped key, so `-e X=Y`, `--env X=Y` and a bare `X=Y` are all
 * covered and a new caller cannot reintroduce the leak by framing it
 * differently. Returns a new array; the input is untouched (the argv actually
 * passed to spawn must keep the real values).
 */
export function redactSecrets(argv: readonly string[]): string[] {
  return argv.map((arg) => {
    const match = ENV_ASSIGNMENT.exec(arg);
    if (!match) return arg;
    return isCredentialEnvKey(match[1]) ? `${match[1]}=${REDACTED}` : arg;
  });
}

/**
 * Minimum length for a live env value to be scrubbed out of free text.
 *
 * Ollama targets deliberately set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN to the
 * literal `ollama`, and the QA agent uses `none`. Substring-replacing such short
 * words across every log line would corrupt unrelated messages while protecting
 * nothing. Real tokens and API keys are far longer than this. (The argv path
 * above has no such threshold — there the key names the value, so a short dummy
 * is redacted too, which is correct and costs nothing.)
 */
const MIN_SCRUBBABLE_VALUE_LENGTH = 12;

/**
 * Credential-shaped keys currently present in process.env.
 *
 * Deliberately uncached. Any cheap invalidation signal here is an approximation
 * — an env key COUNT, for instance, is unchanged when one var is deleted and a
 * credential added in the same window, which would silently drop that credential
 * from the scrub set. This is the last line of defence on every log line, so it
 * reads the environment fresh; a filter over a few dozen short strings is far
 * cheaper than the substring work below it, let alone the log file append that
 * follows.
 */
function credentialKeysInEnv(): string[] {
  return Object.keys(process.env).filter(isCredentialEnvKey);
}

/**
 * Replace any live credential value from the environment with `<redacted>`
 * wherever it appears in `text`.
 *
 * Applied at the logger boundary, so a credential cannot reach the console or a
 * log file no matter which call site assembled the string.
 */
export function redactSecretValues(text: string): string {
  if (!text) return text;
  let out = text;
  for (const key of credentialKeysInEnv()) {
    const value = process.env[key];
    if (!value || value.length < MIN_SCRUBBABLE_VALUE_LENGTH) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}
