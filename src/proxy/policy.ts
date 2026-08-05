/**
 * Mechanistic proxy policy rule engine — §6.3 layer 1 of the policy plane
 * (docs/spikes/model-passthrough.md).
 *
 * This is the *deterministic, injection-proof* enforcement floor. Every rule
 * here is a static predicate over a `tool_use` block's name and input — a
 * prompt-injected agent cannot *argue* its way past a static rule, and the
 * decision is identical regardless of which model (real Anthropic, Ollama, any
 * Anthropic-native backend) produced the action. This is the REAL security
 * boundary. The §6.3 layer-2 LLM judge (a separate, deferred task) only adds
 * nuance for borderline cases *on top of* this floor; it never replaces it.
 *
 * The engine is pure: no I/O, no async, no shared state. Given the same block
 * and config it always returns the same decision. The proxy server
 * (src/proxy/server.ts) is what turns a `deny` into a rewritten response
 * (src/proxy/enforce.ts) so the denied call never executes.
 *
 * DECIDED POLICY — inherited claude.ai connectors (`mcp__claude_ai_*`) are
 * denied by default, allowlist-only. An agent running under a claude.ai account
 * silently inherits that account's server-side connectors (Gmail read/draft,
 * Drive, Calendar, Spotify — verified in the spike's real-Anthropic run) as
 * callable tools that the OS sandbox and lazy's own permission model never see.
 * The proxy is the only lazy-controlled chokepoint that can deny them, so the
 * safe default is closed.
 */

/** Prefix identifying an inherited claude.ai account connector tool. */
export const CLAUDE_AI_CONNECTOR_PREFIX = 'mcp__claude_ai_';

/**
 * Default secret-path patterns. A `tool_use` whose extracted path matches any
 * of these is denied when `denySecretPathReads` is on. Matched case-sensitively
 * against the raw path string (POSIX-style; Claude Code emits POSIX paths).
 */
export const DEFAULT_SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,                 // ~/.ssh and anything under it
  /(^|\/)\.env(\.[^/]*)?$/,            // .env, .env.local, .env.production, …
  /(^|\/)\.aws\/credentials/,          // AWS credentials
  /(^|\/)\.aws\/config$/,              // AWS config (may hold sso tokens)
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, // private SSH keys
  /\.pem$/,                            // PEM private keys / certs
  /(^|\/)\.netrc$/,                    // netrc credentials
  /(^|\/)\.git-credentials$/,          // git stored credentials
  /(^|\/)\.npmrc$/,                    // npm auth tokens
  /(^|\/)\.pypirc$/,                   // PyPI upload credentials
  /(^|\/)\.docker\/config\.json$/,     // docker registry auth
  /(^|\/)\.kube\/config$/,             // kubeconfig
  /credentials\.json$/,                // generic credential files
];

/** Tools that write to the filesystem — their path is checked against deny globs. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools that read a path — their path is checked against secret patterns. */
const READ_PATH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'LS']);
/** Tools that make network egress — their target host is checked against the allowlist. */
const EGRESS_TOOLS = new Set(['WebFetch']);

/**
 * Resolved mechanistic policy. Built from `[proxy.policy]` in lazy.toml
 * (src/config/loader.ts). All fields are concrete — no optionals — so the
 * engine never has to guess a default at evaluation time.
 */
export interface ProxyPolicyConfig {
  /**
   * Master switch. When false the engine allows everything (the proxy behaves
   * as a pure passthrough/audit plane). When true the deny-rules below apply.
   */
  enforce: boolean;
  /**
   * Exact `mcp__claude_ai_*` tool names that are explicitly re-allowed despite
   * the default-deny posture. Everything else with the connector prefix is denied.
   */
  connectorAllowlist: string[];
  /** Deny reads of well-known secret paths (~/.ssh, .env, credential files, …). */
  denySecretPathReads: boolean;
  /**
   * Additional absolute-path glob-ish patterns to deny for read AND write tools.
   * Simple `*`/`**` globs, translated to anchored regexes. Empty = no extra denies.
   */
  denyPathGlobs: string[];
  /**
   * Allowlisted egress hosts for network tools (WebFetch). When null, egress is
   * NOT filtered (unrestricted). When a non-empty list, a network tool whose
   * target host is not in the list is denied. An empty list is treated as null
   * (unrestricted) to avoid a silent deny-all footgun.
   */
  egressAllowlist: string[] | null;
}

/** The default posture applied when `[proxy]` is set but `[proxy.policy]` is absent. */
export function defaultPolicyConfig(): ProxyPolicyConfig {
  return {
    // The decided policy is a closed default: enforcement on, connectors denied.
    enforce: true,
    connectorAllowlist: [],
    denySecretPathReads: true,
    denyPathGlobs: [],
    egressAllowlist: null,
  };
}

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; rule: string; reason: string };

const ALLOW: PolicyDecision = { action: 'allow' };

/** Translate a simple `*`/`**` glob into an anchored, POSIX-path regex. */
function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters except our glob wildcards, then expand them.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // NOTE: the ** placeholder is written as the \u0000 ESCAPE, never as a raw
  // NUL byte. A literal NUL makes git classify this whole file as binary --
  // no diff, no blame, no review. The runtime value is still U+0000, which is
  // exactly what makes it a safe placeholder: no glob input can contain it.
  const pattern = escaped
    .replace(/\*\*/g, '\u0000')  // placeholder for ** (matches across separators)
    .replace(/\*/g, '[^/]*')     // * matches within a path segment
    .replace(/\u0000/g, '.*');   // ** matches anything
  return new RegExp('^' + pattern + '$');
}

/** Extract the filesystem path a tool_use targets, if any. */
function pathOf(input: Record<string, unknown>): string | null {
  if (typeof input.path === 'string') return input.path;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.notebook_path === 'string') return input.notebook_path;
  return null;
}

/** Extract the egress host a network tool targets, if any. */
function egressHostOf(input: Record<string, unknown>): string | null {
  const raw = typeof input.url === 'string' ? input.url : null;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // Unparseable URL — cannot verify against the allowlist; caller decides.
    return null;
  }
}

/**
 * Evaluate a single `tool_use` block against the policy. Pure and deterministic.
 * Rules are checked in order of trust; the first matching deny wins.
 *
 * @param name  the tool name (e.g. "Read", "Bash", "mcp__claude_ai_gmail_search")
 * @param input the tool's input object (already-parsed JSON)
 */
export function evaluateToolUse(
  name: string,
  input: Record<string, unknown>,
  config: ProxyPolicyConfig,
): PolicyDecision {
  if (!config.enforce) return ALLOW;

  // Rule 1 — inherited claude.ai connectors: deny-by-default, allowlist-only.
  // This is the load-bearing reason the layer exists (see file header).
  if (name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)) {
    if (config.connectorAllowlist.includes(name)) return ALLOW;
    return {
      action: 'deny',
      rule: 'connector-deny-default',
      reason:
        `inherited claude.ai connector "${name}" is denied by default. These ` +
        `account-hosted connectors are injected server-side and bypass the OS ` +
        `sandbox and lazy's permission model; allowlist it in [proxy.policy] ` +
        `connector_allowlist if this access is intended.`,
    };
  }

  const path = pathOf(input);

  // Rule 2 — secret-path reads: deny reads of credential/key paths.
  if (config.denySecretPathReads && path && READ_PATH_TOOLS.has(name)) {
    for (const pat of DEFAULT_SECRET_PATH_PATTERNS) {
      if (pat.test(path)) {
        return {
          action: 'deny',
          rule: 'secret-path-read',
          reason: `reading secret/credential path "${path}" is denied by policy.`,
        };
      }
    }
  }

  // Rule 3 — path-boundary deny globs: apply to both read and write path tools.
  if (config.denyPathGlobs.length && path && (READ_PATH_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
    for (const glob of config.denyPathGlobs) {
      if (globToRegExp(glob).test(path)) {
        return {
          action: 'deny',
          rule: 'path-glob-deny',
          reason: `path "${path}" matches a denied path pattern "${glob}".`,
        };
      }
    }
  }

  // Rule 4 — egress allowlist: network tools may only reach allowlisted hosts.
  if (config.egressAllowlist && config.egressAllowlist.length && EGRESS_TOOLS.has(name)) {
    const host = egressHostOf(input);
    // A missing/unparseable host cannot be verified — deny closed.
    if (host === null || !config.egressAllowlist.includes(host)) {
      return {
        action: 'deny',
        rule: 'egress-allowlist',
        reason:
          `network egress to "${host ?? '(unparseable target)'}" is denied — ` +
          `only allowlisted hosts are permitted.`,
      };
    }
  }

  return ALLOW;
}
