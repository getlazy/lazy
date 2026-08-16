/**
 * Global constants used across the codebase
 */

import type { Actor } from './types';

/**
 * Co-author trailer appended to commits made by agents.
 * This ensures proper attribution to the Lazy system.
 */
export const LAZY_COAUTHOR_TRAILER = 'Co-Authored-By: Lazy <noreply@getlazy.dev>';

/**
 * Detect the current actor from the LAZY_ACTOR environment variable.
 * Defaults to 'human' (CLI usage).
 *
 * SCOPE: this is the FALLBACK for the default (CLI/human) channel. It is
 * meaningful only in the process that read it: inside the daemon — one
 * long-lived process serving every channel, where LAZY_ACTOR is never set — it
 * reports 'human' for a builder's MCP call. Lifecycle code running in the
 * daemon must therefore take the actor from its params
 * (`params.actor ?? getActor()`); the MCP boundary threads the real channel
 * through the RPC layer rather than relying on this. See {@link MCP_ACTOR}.
 *
 * Nothing in lazy sets LAZY_ACTOR any more (the MCP server used to, back when
 * it shelled out to the CLI). It survives as an override for wrappers and for
 * the daemonless in-process paths the e2e suite drives.
 */
export function getActor(): Actor {
  return process.env.LAZY_ACTOR === 'builder' ? 'builder' : 'human';
}

/**
 * The actor for commands originating at the MCP boundary (the AI builder that
 * drives lazy via MCP tools).
 *
 * INVARIANT: actor reflects WHO SUBMITTED the command (the channel), NOT the
 * ultimate source of the content. An MCP command relaying a human's words (e.g.
 * `lazy_unblock` forwarding human feedback) is still `builder` — the channel is
 * MCP, and the actor records who pressed the button, not who authored the text.
 * MCP tool handlers thread this through the RPC layer so the turn is tagged
 * correctly even though it is persisted in the daemon process (where the env-var
 * `getActor()` default would otherwise report `human`).
 *
 * The MCP channel has two callers, told apart by SCOPE, not by channel: the
 * builder (no task of its own — this constant) and a task agent driving its own
 * subtree (`AGENT_ACTOR`). See {@link AGENT_ACTOR} and `mcpActor` in
 * src/mcp/tools.ts, which picks between them from the tool context.
 */
export const MCP_ACTOR: Actor = 'builder';

/**
 * The actor for commands originating at the MCP boundary from a TASK AGENT —
 * a call whose tool context carries a task id, i.e. an agent acting inside its
 * own subtree (creating, starting, reviewing, unblocking, or accepting its own
 * subtasks).
 *
 * Same channel as {@link MCP_ACTOR}, different hand on the button: an accept
 * driven by a parent agent must not read back as the builder's (or a human's)
 * decision when someone later audits how a subtask landed.
 */
export const AGENT_ACTOR: Actor = 'agent';
