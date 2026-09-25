/**
 * Per-identity daemon MCP tokens — the `/mcp/*` view of the daemon's token
 * registry (src/daemon/actor-tokens.ts, which owns the file and the cache).
 *
 * THE BOUNDARY THIS EXISTS FOR: agents call the daemon at
 * `POST /mcp/:taskId/:toolName`. The `:taskId` segment is *claimed* by the
 * caller — it is not evidence of anything. While every agent presented the same
 * shared daemon bearer token, any agent could claim any task id and act as that
 * task: pose as its own PARENT and accept itself, unblock a sibling, close
 * someone else's work. Every server-side ownership gate (agent-subtask-mcp,
 * allow-agent-accept-subtask) was therefore advisory against a deliberately
 * malicious agent.
 *
 * The fix is to make identity cryptographic rather than claimed: each task
 * session (and each builder session) gets its OWN random token, bound
 * server-side to exactly one identity. The daemon derives the caller's identity
 * from the token it presents and REFUSES (403) when the URL-claimed task id
 * disagrees — it never silently overrides the claim, because a caller acting on
 * the wrong task while believing it acts on another is worse than a hard error.
 *
 * INVARIANT — THE MCP SURFACE ACCEPTS ONLY AGENT IDENTITIES. The same registry
 * now also holds `/rpc/*` actor tokens (control plane and per-user), and
 * `lookupMcpIdentity` returns null for those on purpose: an actor token must
 * never authenticate as an agent, or a human's CLI credential would be able to
 * act as some task's agent — the exact impersonation this module exists to
 * prevent, re-introduced from the other direction. The mirror rule lives in
 * ./rpc-auth.ts, which refuses task/builder tokens on `/rpc/*`.
 *
 * Where the tokens live, and why the file is still named `mcp-tokens.json`, is
 * documented in ./actor-tokens.ts.
 */

import {
  mintDaemonToken,
  lookupDaemonIdentity,
  revokeDaemonTokens,
  clearDaemonTokenCache,
  peekDaemonToken,
  MAX_BUILDER_TOKENS,
  type DaemonIdentity,
  type MintDaemonTokenOptions,
} from './actor-tokens';

/**
 * Re-exported so the cap remains a property of the `/mcp/*` surface for callers
 * and tests, even though the registry that enforces it now lives in
 * ./actor-tokens.ts.
 */
export { MAX_BUILDER_TOKENS };

/** Who a presented MCP token proves the caller to be. */
export type McpIdentity =
  | { kind: 'task'; taskId: string }
  | { kind: 'builder' };

/**
 * Extra facts about the session a token is being minted for.
 *
 * Structurally the `/mcp/*` view of ./actor-tokens.ts's MintDaemonTokenOptions,
 * minus `rotate` — rotation is a control-plane operation, not something an agent
 * or builder session asks for.
 */
export type MintMcpTokenOptions = Omit<MintDaemonTokenOptions, 'rotate'>;

/** Mint (or reuse) the token bound to one MCP identity. */
export function mintMcpToken(
  projectRoot: string,
  identity: McpIdentity,
  label: string,
  options: MintMcpTokenOptions = {},
): Promise<string> {
  return mintDaemonToken(projectRoot, identity, label, options);
}

/**
 * Resolve a presented bearer token to the MCP identity it is bound to, or null
 * when the token is unknown, revoked, or bound to a NON-agent identity (see the
 * invariant above).
 */
export async function lookupMcpIdentity(
  projectRoot: string,
  token: string | null | undefined,
): Promise<McpIdentity | null> {
  const identity: DaemonIdentity | null = await lookupDaemonIdentity(projectRoot, token);
  if (!identity) return null;
  if (identity.kind === 'task') return { kind: 'task', taskId: identity.taskId };
  if (identity.kind === 'builder') return { kind: 'builder' };
  return null;
}

/**
 * Revoke every token bound to a task. Called when the task's session ends
 * (accept / reject / close) — after that point the agent must not be able to
 * act, and its container is being torn down anyway.
 *
 * Returns the number of tokens revoked. Idempotent.
 */
export function revokeTaskMcpTokens(projectRoot: string, taskId: string): Promise<number> {
  return revokeDaemonTokens(projectRoot, { kind: 'task', taskId });
}

/**
 * Revoke the token bound to one builder session, identified by the label it was
 * minted with (the `builder-<id>` name that also names its MCP config file).
 *
 * Called when the builder's supervisor exits — the human closing the terminal
 * ends the session, and nothing else tells the daemon about it. Without this the
 * credential outlived the session entirely: builder tokens were bounded only by
 * MAX_BUILDER_TOKENS, so a token stayed valid until 50 later builders pushed it
 * out. A leaked config file from an exited session must not still be usable.
 *
 * Returns the number of tokens revoked (0 or 1). Idempotent.
 */
export function revokeBuilderMcpToken(projectRoot: string, label: string): Promise<number> {
  return revokeDaemonTokens(projectRoot, { kind: 'builder', label });
}

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearMcpTokenCache(): void {
  clearDaemonTokenCache();
}

/** The token currently bound to an identity, or null. Diagnostics/tests. */
export function peekMcpToken(
  projectRoot: string,
  identity: McpIdentity,
  label: string,
): Promise<string | null> {
  return peekDaemonToken(projectRoot, identity, label);
}
