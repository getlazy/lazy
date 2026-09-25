/**
 * Who is calling `/rpc/*` — derived from the token presented, never from a
 * request field.
 *
 * Today's `actor` strings on daemon writes ("human", "builder", …) are
 * caller-supplied DATA: anything holding the shared token can claim to be
 * anyone. That is fine for a single-user install, where the one token IS the
 * machine owner, and not fine once a control plane mediates several humans
 * against one daemon. So identity moves into the credential: the registry that
 * already binds one token to one agent identity (./actor-tokens.ts) gains two
 * more kinds, and this module maps a presented token to the actor it proves.
 *
 * BACK-COMPAT IS LOAD-BEARING. The legacy shared token
 * (`~/.lazy/daemon/<slug>/token`) keeps working and resolves to
 * `{kind:'control'}` — the most privileged actor — so every existing CLI, MCP
 * client, supervisor and script is unaffected, and a single-user install
 * behaves exactly as before, including its freedom to pass `actor` explicitly.
 *
 * The two token surfaces stay disjoint: `task`/`builder` tokens are refused
 * here (they authenticate `/mcp/*` only), and `control`/`user` tokens are
 * refused there. Neither kind of caller can borrow the other's reach.
 */

import { isManagedMode } from '../config/managed';
import { lookupDaemonIdentity, type ActorIdentity } from './actor-tokens';

/** Why a presented token was refused, when it was. */
export type RpcAuthFailure =
  /** No `Authorization: Bearer …` header at all, or an unparsable one. */
  | { reason: 'missing' }
  /** A well-formed token that is not in the registry (or was revoked). */
  | { reason: 'unknown' }
  /** A valid MCP session token presented on the wrong surface. */
  | { reason: 'mcp-token' }
  /** A per-user token on an install that has no control plane behind it. */
  | { reason: 'user-token-unmanaged' };

export type RpcAuthResult =
  | { ok: true; actor: ActorIdentity; legacyShared: boolean }
  | { ok: false; failure: RpcAuthFailure };

/** The bearer value from an Authorization header, or null. */
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer (.+)$/.exec(authHeader);
  return match ? match[1]! : null;
}

/**
 * Resolve the actor behind an `/rpc/*` request.
 *
 * @param projectRoot the project this daemon serves
 * @param sharedToken the daemon's legacy shared bearer token
 * @param authHeader  the request's raw Authorization header
 */
export async function resolveRpcActor(
  projectRoot: string,
  sharedToken: string,
  authHeader: string | null | undefined,
): Promise<RpcAuthResult> {
  const presented = bearerToken(authHeader);
  if (!presented) return { ok: false, failure: { reason: 'missing' } };

  // The legacy shared token IS the control plane on a single-user install.
  // Checked first and by exact compare, exactly as before this module existed.
  if (presented === sharedToken) {
    return { ok: true, actor: { kind: 'control' }, legacyShared: true };
  }

  const identity = await lookupDaemonIdentity(projectRoot, presented);
  if (!identity) return { ok: false, failure: { reason: 'unknown' } };

  // An agent's MCP token must not reach the RPC surface. Distinguished from
  // "unknown" because the fix is completely different — the caller has a valid
  // credential and is using the wrong endpoint with it.
  if (identity.kind === 'task' || identity.kind === 'builder') {
    return { ok: false, failure: { reason: 'mcp-token' } };
  }

  // OUTSIDE MANAGED MODE, IDENTITY IS THE ENVIRONMENT AND A REQUEST NEVER
  // CARRIES ONE (docs/design/actor-identity-and-remote-clients.md §3.4). A
  // user-kind token is the other way identity could arrive, and on a laptop
  // nothing mints one and nothing presents one — so leaving the path open would
  // mean two identity paths with only one of them ever exercised. `mintActorToken`
  // refuses to mint these here; this refuses one minted before that rule existed.
  if (identity.kind === 'user' && !isManagedMode()) {
    return { ok: false, failure: { reason: 'user-token-unmanaged' } };
  }

  return { ok: true, actor: identity, legacyShared: false };
}

/** The message a refused caller sees. Actionable, and never echoes the token. */
export function rpcAuthErrorMessage(failure: RpcAuthFailure): string {
  switch (failure.reason) {
    case 'missing':
      return 'Unauthorized';
    case 'unknown':
      return 'Unauthorized';
    case 'mcp-token':
      return 'Unauthorized: this is an MCP session token, which authenticates POST /mcp/* only. ' +
        'The /rpc/* surface takes the daemon token or an actor token minted with mintActorToken.';
    case 'user-token-unmanaged':
      return 'Unauthorized: this is a per-user token, which only a managed-mode deployment accepts. ' +
        'This daemon takes the acting identity from its own git config, so /rpc/* accepts the daemon token alone.';
  }
}

/** Short, log-safe description of an actor. Never includes the token. */
export function describeActor(actor: ActorIdentity): string {
  if (actor.kind === 'control') return 'control';
  return actor.name ? `user ${actor.name} <${actor.email}>` : `user ${actor.email}`;
}
