/**
 * Assemble the proxy's credential dependencies for a running daemon.
 *
 * One place that answers "which real credential does each upstream get?", so
 * the daemon's start path stays a single call and the mapping itself is
 * reviewable in isolation. Everything here resolves LIVE, per request: a
 * credential set (or revoked) while the daemon runs takes effect on the next
 * request without a restart, the same discipline src/agent/credentials.ts
 * established for launches.
 *
 * Note what is NOT here: any notion of "if the target speaks Anthropic, send
 * the Anthropic key". Each upstream is mapped explicitly or it gets nothing.
 */

import type { ResolvedConfig } from '../config/types';
import { getAuthEnvVars } from '../capture/claude';
import { resolveAgentApiKey } from '../agent/credentials';
import { isCredentialEnvKey } from '../utils/redact';
import { lookupCredentialGrant } from './credential-broker';
import {
  TargetCredentials,
  anthropicPlacement,
  type TargetCredentialOutcome,
} from './target-credentials';
import type { ProxyCredentialDeps } from './server';
import { resolveRoleUpstreams } from './role-upstreams';
import { logger } from '../utils/logger';

/**
 * The user's own Anthropic credential, in the header form it belongs in.
 *
 * PER-USER-TOKEN BILLING: this reads the credential of whoever runs the daemon
 * — the acting user — and there is no second source to fall back to. A missing
 * or unreadable credential resolves to `missing`, which the proxy turns into a
 * 401 naming the remedy. It never degrades to "some other credential".
 */
async function resolveAnthropic(): Promise<TargetCredentialOutcome> {
  let vars: Array<{ key: string; value: string }>;
  try {
    vars = getAuthEnvVars();
  } catch (err) {
    return {
      kind: 'missing',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const cred = vars.find(v => isCredentialEnvKey(v.key) && v.value);
  if (!cred) {
    return {
      kind: 'missing',
      reason:
        'no Anthropic credential is available to the daemon. Run `claude setup-token` (or set ' +
        'ANTHROPIC_API_KEY) in the environment the daemon starts from, then: lazy daemon restart',
    };
  }
  return {
    kind: 'credential',
    placement: anthropicPlacement(cred.key, cred.value),
    label: cred.key,
  };
}

/**
 * The user's Cursor API key.
 *
 * Placement is `in-place`: cursor-agent's auth wire format is not something
 * lazy has a contract for, so the credential goes exactly where the client put
 * its placeholder — header or body — instead of a header lazy guessed at.
 */
function resolveCursor(projectRoot: string): () => Promise<TargetCredentialOutcome> {
  return async () => {
    const key = await resolveAgentApiKey(projectRoot, 'cursor');
    if (!key) {
      return {
        kind: 'missing',
        reason:
          'no Cursor API key is available to the daemon. Set one with `lazy agent key set cursor`, ' +
          'or export CURSOR_API_KEY in the environment the daemon starts from.',
      };
    }
    return { kind: 'credential', placement: { kind: 'in-place', value: key.value }, label: 'CURSOR_API_KEY' };
  };
}

/**
 * Build the proxy's credential dependencies, and log the resulting map.
 *
 * The startup log lists every upstream and which credential it will receive,
 * because "which of my keys can this fallback see?" must be answerable without
 * reading source (CLAUDE.md: transparent over terse). No secret is logged —
 * only which credential SLOT each target maps to.
 */
export function buildProxyCredentialDeps(
  projectRoot: string,
  config: ResolvedConfig,
): ProxyCredentialDeps {
  const targets = new TargetCredentials();

  targets.set(config.proxy.upstream, resolveAnthropic);
  targets.set(config.proxy.cursorUpstream, resolveCursor(projectRoot));

  const lines: string[] = [
    `${config.proxy.upstream} → anthropic`,
    `${config.proxy.cursorUpstream} → cursor`,
  ];
  for (const fb of config.proxy.fallbacks) {
    // ORIGIN COLLISION: the map is keyed by ORIGIN, so a fallback that shares an
    // origin with an already-mapped target does not get "no credential" — it
    // silently inherits that target's. Left unchecked, a fallback written as
    // `credential = "none"` would receive the user's Anthropic token while the
    // startup line below truthfully-but-uselessly printed "→ none". A config
    // that reads as one thing and behaves as another is worse than a config
    // that is rejected, so this fails loud (CLAUDE.md: errors are actionable).
    if (fb.credential !== 'anthropic' && targets.has(fb.upstream)) {
      throw new Error(
        `[[proxy.fallback]] upstream "${fb.upstream}" has credential = "${fb.credential ?? 'none'}", ` +
        `but it shares an origin with an upstream that is already mapped to a credential, so it ` +
        `would receive that credential anyway. lazy refuses to start with a proxy credential map ` +
        `that does not mean what it says.\n\n` +
        `What to do:\n` +
        `  - If this fallback SHOULD get that credential, say so: credential = "anthropic"\n` +
        `  - If it should not, give it a distinct origin (host or port) from proxy.upstream ` +
        `and proxy.cursor_upstream`,
      );
    }
    if (fb.credential === 'anthropic') {
      targets.set(fb.upstream, resolveAnthropic);
      lines.push(`${fb.upstream} → anthropic (fallback)`);
    } else {
      // Left unmapped on purpose: TargetCredentials answers `none` for an
      // unmapped upstream, so the placeholder is stripped and nothing replaces
      // it. Mapping it to an explicit "none" resolver would read the same and
      // say less.
      lines.push(`${fb.upstream} → none (fallback)`);
    }
  }
  // ROLE UPSTREAMS: a role's `endpoint` is where the proxy forwards that role's
  // traffic, so it is a target like any other and needs an explicit credential —
  // an ollama server gets none (it ignores auth, and shipping the user's token to
  // a local process leaks it), a pinned Anthropic-native endpoint gets the real
  // credential, which is what it received back when the agent dialed it directly.
  for (const entry of resolveRoleUpstreams(config)) {
    // Same ORIGIN COLLISION hazard as the fallback chain above, and the same
    // answer: the map is keyed by origin, so a role upstream sharing an origin
    // with an already-mapped target would silently inherit that target's
    // credential while this log truthfully-but-uselessly printed "→ none". A
    // config that reads as one thing and behaves as another is worse than one
    // that is rejected.
    if (entry.credential !== 'anthropic' && targets.has(entry.upstream)) {
      throw new Error(
        `[models.roles.${entry.role}] endpoint "${entry.upstream}" needs no credential, but it ` +
        `shares an origin with an upstream that is already mapped to one, so it would receive ` +
        `that credential anyway. lazy refuses to start with a proxy credential map that does ` +
        `not mean what it says.\n\n` +
        `What to do:\n` +
        `  - Give the role a distinct origin (host or port) from proxy.upstream, ` +
        `proxy.cursor_upstream and any [[proxy.fallback]]`,
      );
    }
    if (entry.credential === 'anthropic') {
      targets.set(entry.upstream, resolveAnthropic);
      lines.push(`${entry.upstream} → anthropic (role: ${entry.role})`);
    } else {
      // Left unmapped on purpose — TargetCredentials answers `none` for an
      // unmapped upstream, so the placeholder is stripped and nothing replaces it.
      lines.push(`${entry.upstream} → none (role: ${entry.role})`);
    }
  }

  logger.info(`[proxy] credential map: ${lines.join(', ')}`);

  return {
    lookup: (token: string) => lookupCredentialGrant(projectRoot, token),
    targets,
  };
}
