/**
 * Credential redaction for anything lazy prints or writes to a log.
 *
 * Two shapes, one rule set:
 *
 *  1. `redactSecrets(argv)` — argv about to be echoed under `[session] debug`.
 *     Container launch argv carries auth as `-e KEY=VALUE` pairs, so a raw
 *     `args.join(' ')` prints the live CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY
 *     in clear text — in the exact situation (debug on, output pasted into a bug
 *     report) where it is most likely to be shared.
 *
 *  2. `redactSecretValues(text)` — free text. Belt to the argv braces: whatever
 *     path a credential value takes into something a human reads, it is
 *     scrubbed on the way out.
 *
 * Applied at every boundary that writes text a human can paste into
 * a bug report:
 *
 *  - the `[session] debug` argv echoes (src/capture/claude.ts, the two runners)
 *  - `Logger` (src/utils/logger.ts), covering every level
 *  - the supervisor's own logger (src/supervisor/log.ts) — a SEPARATE logger
 *    that `Logger` has no reach into, and the one that writes the builder log
 *  - the proxy audit log's free-text fields (src/proxy/audit-log.ts), where the
 *    agent's own Bash commands and tool results are recorded verbatim
 *  - agent turn rows (src/daemon/turn-owner.ts), which are durable
 *  - the content of every record written to the store (turns — content, recorded
 *    prompt, check output — comments, journal, raised items), at the write
 *    boundary (normalizeRecordContent, src/utils/turn-content.ts, and
 *    FileStorage.createTurn), and the whole `show` answer (handleShow)
 *  - everything a Teams admin reads about the machine — build logs, failure
 *    output, service logs — through src/daemon/observability-redaction.ts,
 *    which adds the secrets the daemon holds outside its environment
 *
 * Beyond env credentials, the value set includes per-task `lazy env set`
 * values: registered in-process by the daemon (setRegisteredSecretValues) and
 * named by key to a launched supervisor through TASK_ENV_KEYS_VAR. Secret
 * FILES are registered by the strings secretStringsForFile
 * (src/utils/secret-file-strings.ts) picks out of them. Each registered value
 * is matched in every spelling scrubVariantsOf derives (lines, base64,
 * URL-encoding, JSON-escaping), longest first; trivial values never are.
 *
 * Deliberately NOT applied to the proxy's per-request handling path or to
 * captured agent stdout/stderr beyond what `Logger` already scrubs: those are
 * high-volume, a substring scan per credential per call is not free there, and
 * rewriting captured content could alter text a human is reading for other
 * reasons.
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
  'FIREWORKS_API_KEY',
  'OLLAMA_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
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

/**
 * Namespace lazy GENERATES env var names in, for credentials it does not know
 * by name (`namedCredentialEnvVar`, src/credentials/providers.ts).
 *
 * Matched as a PREFIX because the trailing word is the user's credential name —
 * `LAZY_CREDENTIAL_WORK_OPENAI` ends in OPENAI and `…_OAUTH` in OAUTH, neither
 * of which the shape rule below covers, so every named credential's env var was
 * exempt from redaction. The prefix is the part lazy controls and is by
 * construction only ever put on a credential.
 */
const CREDENTIAL_KEY_PREFIX = 'LAZY_CREDENTIAL_';

/** True when `key` names an env var whose VALUE must never be logged. */
export function isCredentialEnvKey(key: string): boolean {
  if (CREDENTIAL_KEY_SET.has(key)) return true;
  const upper = key.toUpperCase();
  if (upper.startsWith(CREDENTIAL_KEY_PREFIX)) return true;
  return CREDENTIAL_KEY_SHAPE.test(upper);
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
 *
 * `alwaysRedactKeys` extends the rule set for one call with keys whose values
 * are known to be secret regardless of NAME shape. Per-task env vars
 * (`lazy env set`, src/daemon/task-env.ts) are the case this exists for: the
 * user supplied them precisely because they are sensitive, and `STRIPE_SANDBOX`
 * is every bit as secret as `STRIPE_API_KEY` while matching no name shape.
 */
export function redactSecrets(
  argv: readonly string[],
  alwaysRedactKeys?: Iterable<string>,
): string[] {
  const always = alwaysRedactKeys ? new Set(alwaysRedactKeys) : undefined;
  return argv.map((arg) => {
    const match = ENV_ASSIGNMENT.exec(arg);
    if (!match) return arg;
    const key = match[1];
    return (always?.has(key) || isCredentialEnvKey(key)) ? `${key}=${REDACTED}` : arg;
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
export const MIN_SCRUBBABLE_VALUE_LENGTH = 12;

/**
 * Fewest DISTINCT characters a scrubbable value must contain. A 12-character
 * run of one or two characters (`============`, `000000000000`, `-----...-----`
 * framing a PEM block) is formatting, not a secret, and replacing it everywhere
 * would mangle unrelated text.
 */
const MIN_DISTINCT_CHARS = 4;

/**
 * Longest single value matched as a whole. A registered secret FILE may be
 * large; scrubbing a megabyte substring from every log line costs a megabyte
 * comparison per line for no gain — text that big never reaches a log line
 * intact. Longer MULTI-LINE values are matched by their lines instead (see
 * scrubVariantsOf); a single-line value is always matched whole, so the bound
 * narrows WHAT is matched, never whether the secret is covered.
 */
export const MAX_WHOLE_VALUE_LENGTH = 16 * 1024;

/**
 * Cap on registered values per source, and so on the scrub set. Generous for
 * every real source (a task's handful of env vars, a few secret files' lines),
 * and the reason a registry fed from user input stays bounded by construction.
 * Exceeding it throws: silently dropping secrets would be a leak.
 */
export const MAX_REGISTERED_VALUES_PER_SOURCE = 4096;

/**
 * True when `value` is distinctive enough to be substring-replaced across all
 * free text: long enough (MIN_SCRUBBABLE_VALUE_LENGTH) and not a run of a few
 * repeated characters. Trivial values — `1`, `true`, `production` — are held
 * but never applied. Leading/trailing whitespace does not count towards it.
 */
export function isScrubbableSecretValue(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SCRUBBABLE_VALUE_LENGTH) return false;
  return new Set(trimmed).size >= MIN_DISTINCT_CHARS;
}

/**
 * Every spelling of one secret that the scrubber looks for, each itself
 * scrubbable (isScrubbableSecretValue):
 *
 *  - the value as given, and trimmed;
 *  - for a MULTI-LINE value (a PEM key, a JSON blob): each line, trimmed — a
 *    log line holds one line of it, never the whole — and the value as a JSON
 *    string body (`\n` escaped), the shape it takes in a JSON log or RPC body;
 *  - base64 (standard, unpadded and URL-safe) — a Basic auth header, a k8s
 *    secret manifest, a `docker login` config;
 *  - URL-encoded, when that differs — a password inside a connection string
 *    or query parameter.
 *
 * A multi-line value over MAX_WHOLE_VALUE_LENGTH is matched by its lines only.
 * A single-line value is ALWAYS matched whole, however long: it has no lines
 * to fall back on, and dropping it would leave it unscrubbed.
 *
 * Only WHOLE-value encodings are generated: base64 of a substring does not
 * align with the encoding of the text around it, so it could not be found by
 * substring search anyway.
 */
export function scrubVariantsOf(value: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => { if (isScrubbableSecretValue(v)) out.add(v); };
  const multiLine = /[\r\n]/.test(value);
  const whole = !multiLine || value.length <= MAX_WHOLE_VALUE_LENGTH;
  if (whole) {
    add(value);
    add(value.trim());
  }
  if (multiLine) {
    for (const line of value.split(/\r?\n|\r/)) {
      const t = line.trim();
      if (!PEM_ARMOUR.test(t)) add(t);
    }
    if (whole) add(JSON.stringify(value).slice(1, -1));
  }
  if (whole && isScrubbableSecretValue(value)) {
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    add(b64);
    add(b64.replace(/=+$/, ''));
    add(Buffer.from(value, 'utf8').toString('base64url'));
    try {
      add(encodeURIComponent(value));
    } catch (err) {
      // URIError: a lone UTF-16 surrogate has no URL encoding, so no URL can
      // carry this spelling — there is nothing to match. Every other variant
      // still applies; throwing here would break the logger on every line.
      if (!(err instanceof URIError)) throw err;
    }
  }
  return [...out];
}

/** PEM armour lines name a format shared by every key file, not a secret. */
export const PEM_ARMOUR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;

/** Memo for env-sourced values, whose variants are recomputed otherwise on every log line. */
const variantCache = new Map<string, string[]>();
const VARIANT_CACHE_LIMIT = 256;
function cachedVariants(value: string): string[] {
  let v = variantCache.get(value);
  if (!v) {
    v = scrubVariantsOf(value);
    if (variantCache.size >= VARIANT_CACHE_LIMIT) variantCache.clear();
    variantCache.set(value, v);
  }
  return v;
}

const byLengthDesc = (a: string, b: string) => b.length - a.length;

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
 * Every string to scrub, from all sources, LONGEST FIRST: a shorter secret
 * inside a longer one (a password inside a DATABASE_URL, a line inside a
 * registered file) replaced first would break the longer match and leave the
 * rest of it in the text.
 *
 * The registered half is precomputed and sorted whenever a source changes
 * (registeredSorted); only the few env-derived variants are read per call, and
 * merged in only when there are any.
 *
 * The threshold (isScrubbableSecretValue) is what keeps
 * `ANTHROPIC_API_KEY=ollama` and the QA agent's `none` from being
 * substring-replaced across unrelated text. Every value-based scrub reads this,
 * so the rule lives in exactly one place.
 */
function scrubbableCredentialValues(): readonly string[] {
  const env = new Set<string>();
  const push = (value: string | undefined) => {
    if (value) for (const v of cachedVariants(value)) env.add(v);
  };
  for (const key of credentialKeysInEnv()) push(process.env[key]);
  // Per-task env keys this process was launched with (the supervisor and the
  // agent's process tree): secret whatever they are NAMED — see TASK_ENV_KEYS_VAR.
  const taskKeys = process.env[TASK_ENV_KEYS_VAR];
  if (taskKeys) {
    for (const key of taskKeys.split(',')) if (key) push(process.env[key]);
  }
  if (env.size === 0) return registeredSorted;
  for (const v of registeredSorted) env.add(v);
  return [...env].sort(byLengthDesc);
}

/**
 * Env var through which a launched supervisor learns which of its env vars are
 * per-task values (`lazy env set`), as a comma-separated KEY list — never the
 * values, which it already has. Needed because the supervisor is a separate
 * process (usually in a container) with no access to the daemon's task-env
 * file, and those keys need not match any credential name shape.
 */
export const TASK_ENV_KEYS_VAR = 'LAZY_TASK_ENV_KEYS';

/**
 * Secret values registered by an in-process SOURCE that knows them without
 * them being in process.env — the daemon's per-task env registry
 * (src/daemon/task-env.ts, one `task-env:<taskId>` source per task), which
 * re-registers on every read and write of its file so an unset or cleared
 * value stops being scrubbed, and whatever delivers secret FILES (register
 * their secretStringsForFile, src/utils/secret-file-strings.ts). Held as the
 * precomputed scrub variants (scrubVariantsOf) of each value.
 */
const registeredSecretValues = new Map<string, readonly string[]>();

/** Every registered variant from every source, deduplicated, longest first. */
let registeredSorted: readonly string[] = [];

function rebuildRegisteredSorted(): void {
  const all = new Set<string>();
  for (const variants of registeredSecretValues.values()) for (const v of variants) all.add(v);
  registeredSorted = [...all].sort(byLengthDesc);
}

/** The sources currently registered — so a source family can drop members it no longer has. */
export function registeredSecretSources(): string[] {
  return [...registeredSecretValues.keys()];
}

function scrubbableValues(source: string, values: Iterable<string>): Map<string, string[]> {
  // A value counts when it yields any variant: a multi-line value may be
  // trivial as a whole and still carry secret lines.
  const scrubbable = new Map<string, string[]>();
  for (const value of new Set(values)) {
    const variants = scrubVariantsOf(value);
    if (variants.length > 0) scrubbable.set(value, variants);
  }
  if (scrubbable.size > MAX_REGISTERED_VALUES_PER_SOURCE) {
    throw new Error(
      `Refusing to register ${scrubbable.size} secret values for '${source}': the limit is ` +
      `${MAX_REGISTERED_VALUES_PER_SOURCE} per source. Deliver fewer or smaller secrets.`,
    );
  }
  return scrubbable;
}

/**
 * Throw exactly as setRegisteredSecretValues would, registering nothing — so a
 * caller can refuse input BEFORE persisting anything it could then not
 * register on every later read.
 */
export function assertRegistrableSecretValues(source: string, values: Iterable<string>): void {
  scrubbableValues(source, values);
}

/**
 * Replace the full set of secret values known to `source`. An empty set drops
 * the source. Trivial values (isScrubbableSecretValue) are accepted but never
 * applied, and do not count towards MAX_REGISTERED_VALUES_PER_SOURCE; past it
 * this throws, leaving the source's previous set in place.
 */
export function setRegisteredSecretValues(source: string, values: Iterable<string>): void {
  const scrubbable = scrubbableValues(source, values);
  if (scrubbable.size === 0) {
    if (registeredSecretValues.delete(source)) rebuildRegisteredSorted();
    return;
  }
  const variants = new Set<string>();
  for (const vs of scrubbable.values()) for (const v of vs) variants.add(v);
  registeredSecretValues.set(source, [...variants]);
  rebuildRegisteredSorted();
}

/**
 * True when the environment currently holds at least one credential value that
 * `redactSecretValues` could actually replace.
 *
 * For callers that must build a scrubbed COPY of a structured value: this says
 * up front whether the copy is worth making, so the common case (no live
 * credential in env, e.g. an ollama-only setup) costs one env scan instead of a
 * per-field walk. Never use it to skip scrubbing a single string —
 * `redactSecretValues` is already a no-op there and the guard would only add
 * work.
 */
export function hasScrubbableCredentials(): boolean {
  return scrubbableCredentialValues().length > 0;
}

function redactWith(text: string, values: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const value of values) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}

/**
 * Replace any live credential value from the environment, and every registered
 * secret value, with `<redacted>` wherever it appears in `text`.
 *
 * Applied at the logger boundary, so a credential cannot reach the console or a
 * log file no matter which call site assembled the string.
 */
export function redactSecretValues(text: string): string {
  if (!text) return text;
  return redactWith(text, scrubbableCredentialValues());
}

/**
 * `redactSecretValues` over every string inside a JSON-shaped value — for a
 * structured answer (an RPC result) whose free-text fields are too many, and
 * change too often, to scrub one by one. Returns a copy; object KEYS are kept,
 * since they name fields, not values. Returns the input itself when nothing is
 * scrubbable, so the common case allocates nothing. The scrub set is read once
 * for the whole walk.
 */
export function redactSecretValuesDeep<T>(value: T): T {
  const values = scrubbableCredentialValues();
  if (values.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactWith(v, values);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
