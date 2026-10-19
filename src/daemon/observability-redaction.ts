/**
 * Redaction for everything a Lazy Teams project admin can READ about the
 * machine: live image-build log lines, a failed build's output, the guest
 * services' logs (src/daemon/image-build-job.ts, src/daemon/image-state.ts,
 * src/daemon/machine-observation.ts).
 *
 * WHY A SECOND LAYER. The daemon's logger already scrubs env credentials
 * (src/utils/redact.ts), but these paths read text the logger never wrote —
 * docker's own output, dockerd's log, the forwarder's — and the daemon holds
 * secrets that never sit in its environment: members' real credentials pushed
 * by the control plane, the placeholders it minted for task containers, the
 * bearer tokens it issued. A build log is exactly where one surfaces (a
 * Dockerfile that echoes its env, a failing `curl` printing its headers).
 *
 * WHAT IS SCRUBBED, by KNOWLEDGE, not by guessing which strings look secret:
 *   - every secret value the daemon holds: env credentials and per-task env
 *     values (redactSecretValues), the per-user credential store, the proxy's
 *     placeholder grants, the session placeholder bindings (revoked ones too),
 *     the daemon's bearer-token registry and its own shared token;
 *   - lazy's OWN placeholder formats (known prefix + the exact hex length lazy
 *     mints), so a placeholder revoked long ago is still recognised in old text;
 *   - the one credential FORMAT lazy routes everything through, Anthropic's
 *     `sk-ant-<kind><nn>-…`, as a backstop for a credential that reached a log
 *     without ever passing through this daemon.
 *
 * WHERE: at the RPC boundary (`redactAnswer`), applied to the WHOLE answer of
 * every observation command, so no field added later can bypass it — and again
 * as lines enter a build log, so memory holds as little as possible. The
 * secret set is read FRESH for every answer: a credential pushed after a line
 * was captured is still scrubbed from it on the way out.
 *
 * FAIL CLOSED. If a registry cannot be read, nothing can be proven clean, so
 * every string is replaced by a notice saying so — the page still renders, the
 * log does not leak. The only strings kept are the structural fields the
 * schemas name explicitly (STRUCTURAL_FIELDS: states, enums, timestamps, image
 * names), each checked against its exact shape.
 */
import { logger } from '../utils/logger';
import { REDACTED, redactSecretValues } from '../utils/redact';

/** Values shorter than this are never substring-replaced (see MIN_SCRUBBABLE_VALUE_LENGTH in redact.ts). */
const MIN_VALUE_LENGTH = 12;

/** What replaces a string when the secret set could not be loaded. */
export const REDACTION_UNAVAILABLE =
  '[withheld: lazy could not load the secrets it must remove from this text, so it is not shown]';

/** Anthropic API keys, OAuth tokens and admin keys: `sk-ant-api03-…`, `sk-ant-oat01-…`. */
const ANTHROPIC_CREDENTIAL_PATTERN = /sk-ant-[a-z]{2,6}\d{2}-[A-Za-z0-9_-]{16,}/g;


/**
 * The ONLY strings an incomplete redactor lets through: answer fields the
 * observation schemas declare structural, by field NAME, each with the exact
 * shape its value must have (src/daemon/image-state.ts, image-build-job.ts,
 * machine-observation.ts). A closed enum, a timestamp, an image name lazy
 * built — never free text, and never chosen by what a value looks like alone:
 * a whitespace-free string is exactly what a bare credential is. A value under
 * a listed name that does not have its shape is withheld like everything else,
 * and a field this table does not name is withheld — so a schema change fails
 * CLOSED (the page shows a withheld notice) rather than open.
 *
 * Array elements are checked under their array's name (`actions: [...]`).
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * A docker image reference: optional registry host, lowercase path
 * components, optional tag and digest. Only on `image`/`defaultImage`, whose
 * values are the tags lazy itself builds and launches — never parsed log text.
 */
const IMAGE_REFERENCE =
  /^(?:[a-z0-9.-]+(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;
const oneOf = (...values: string[]) => {
  const set = new Set(values);
  return (v: string) => set.has(v);
};
const SERVICE_NAMES = ['dockerd', 'forwarder', 'daemon', 'proxy'];
export const STRUCTURAL_FIELDS: Readonly<Record<string, (value: string) => boolean>> = {
  // Image state, service state, a restart's state.
  state: oneOf(
    'adoption_in_progress', 'adoption_failed', 'building', 'failed', 'adopted_in_force', 'ready',
    'running', 'unresponsive', 'crash_loop', 'stopped', 'not_started', 'not_applicable',
    'succeeded',
  ),
  phase: oneOf('checking', 'building'),
  outcome: oneOf('running', 'succeeded', 'failed', 'cancelled'),
  status: oneOf('pending', 'running', 'done', 'cached', 'failed', 'cancelled'),
  kind: oneOf('project', 'adoption', 'lazy', 'docker', 'microvm', 'local-docker', 'host'),
  source: oneOf('lazy', 'docker'),
  restart: oneOf('guest', 'fleet', 'none'),
  to: oneOf('admin', 'maintainer'),
  resource: oneOf('cpu', 'memory', 'disk'),
  actions: oneOf('rebuild', 'adopt', 'create_fix_task', 'switch_back', 'dismiss'),
  name: oneOf(...SERVICE_NAMES),
  service: oneOf(...SERVICE_NAMES),
  startedAt: (v) => ISO_TIMESTAMP.test(v),
  finishedAt: (v) => ISO_TIMESTAMP.test(v),
  observedAt: (v) => ISO_TIMESTAMP.test(v),
  failedAt: (v) => ISO_TIMESTAMP.test(v),
  adoptedAt: (v) => ISO_TIMESTAMP.test(v),
  at: (v) => ISO_TIMESTAMP.test(v),
  image: (v) => v.length <= 255 && IMAGE_REFERENCE.test(v),
  defaultImage: (v) => v.length <= 255 && IMAGE_REFERENCE.test(v),
};

function isStructural(field: string | null, value: string): boolean {
  if (field === null || !Object.prototype.hasOwnProperty.call(STRUCTURAL_FIELDS, field)) return false;
  return STRUCTURAL_FIELDS[field]!(value);
}

export interface Redactor {
  redact(text: string): string;
  /**
   * `redact` for a string found under answer field `field` (null: no field,
   * e.g. a bare string). The same as `redact` when complete; when incomplete,
   * the one way a string survives — see {@link STRUCTURAL_FIELDS}.
   */
  redactField(field: string | null, text: string): string;
  /** False when the secret set could not be loaded; `redact` then withholds everything. */
  readonly complete: boolean;
}

/** String leaves of a JSON-encoded secret (a ChatGPT session holds its tokens inside one). */
function jsonLeaves(value: string): string[] {
  if (!value.startsWith('{')) return [];
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') { if (v.length >= 20) out.push(v); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(value));
    return out;
  } catch (err) {
    // Not JSON after all: the whole value is still scrubbed as itself.
    logger.debug(`observability redaction: a stored secret starting with "{" is not JSON (${(err as Error).message})`);
    return [];
  }
}

/** Every secret value the daemon holds for `projectRoot`, longest first. */
async function heldSecretValues(projectRoot: string): Promise<string[]> {
  const [{ storedUserSecretValues }, { knownPlaceholderValues }, { knownSessionPlaceholderValues }, { knownDaemonTokenValues }, ctx] =
    await Promise.all([
      import('./user-credentials'),
      import('../proxy/credential-broker'),
      import('./session-credentials'),
      import('./actor-tokens'),
      import('./context'),
    ]);
  const lists = await Promise.all([
    storedUserSecretValues(projectRoot),
    knownPlaceholderValues(projectRoot),
    knownSessionPlaceholderValues(projectRoot),
    knownDaemonTokenValues(projectRoot),
  ]);
  const values = new Set<string>();
  for (const list of lists) {
    for (const v of list) {
      values.add(v);
      for (const leaf of jsonLeaves(v)) values.add(leaf);
    }
  }
  if (ctx.hasDaemonContext()) values.add(ctx.getDaemonContext().token);
  return [...values].filter((v) => v.length >= MIN_VALUE_LENGTH).sort((a, b) => b.length - a.length);
}

/** Build a redactor over the daemon's CURRENT secret set. Never throws. */
export async function daemonRedactor(projectRoot: string): Promise<Redactor> {
  const { PLACEHOLDER_VALUE_PATTERN, DERIVED_PLACEHOLDER_PATTERN } = await import('../proxy/credential-broker');
  const { SESSION_TOKEN_PREFIX } = await import('./session-credentials');
  const sessionPattern = new RegExp(`${SESSION_TOKEN_PREFIX}[0-9a-f]{64}`, 'g');
  const byShape = (text: string) => redactSecretValues(text)
    .replace(PLACEHOLDER_VALUE_PATTERN, REDACTED)
    .replace(sessionPattern, REDACTED)
    .replace(DERIVED_PLACEHOLDER_PATTERN, REDACTED)
    .replace(ANTHROPIC_CREDENTIAL_PATTERN, REDACTED);

  let values: string[];
  try {
    values = await heldSecretValues(projectRoot);
  } catch (err) {
    logger.warn(
      `Observability: could not load the secrets to redact from machine logs, so they are withheld: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    // Nothing can be proven clean, so EVERY string is withheld — a log line,
    // an error, and equally a single word: a bare credential has no
    // whitespace, and neither does `token=<value>`. The answer's structure
    // survives only through the fields the schemas name as structural
    // (STRUCTURAL_FIELDS), each checked against its exact shape and still put
    // through every rule that does not need the registries. Empty stays empty.
    const withheld = (text: string) => (text ? REDACTION_UNAVAILABLE : text);
    return {
      complete: false,
      redact: withheld,
      redactField: (field, text) => (isStructural(field, text) ? byShape(text) : withheld(text)),
    };
  }
  const redact = (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const v of values) {
      if (out.includes(v)) out = out.split(v).join(REDACTED);
    }
    return byShape(out);
  };
  return { complete: true, redact, redactField: (_field, text) => redact(text) };
}

/**
 * Every string in `value`, recursively, through `redactor`. Returns a copy.
 * Each string is redacted under the name of the field holding it (an array's
 * elements under the array's), which is what lets an incomplete redactor keep
 * the structural fields it names.
 */
export function redactDeep<T>(value: T, redactor: Redactor, field: string | null = null): T {
  if (typeof value === 'string') return redactor.redactField(field, value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor, field)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, redactor, k);
    return out as T;
  }
  return value;
}

/**
 * The one exit for an observation RPC's answer: every string in it scrubbed
 * against the daemon's secret set as it is NOW.
 */
export async function redactAnswer<T>(projectRoot: string, answer: T): Promise<T> {
  return redactDeep(answer, await daemonRedactor(projectRoot));
}
