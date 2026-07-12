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
 * MCP tool handlers set LAZY_ACTOR=builder when invoking CLI commands.
 * Defaults to 'human' (CLI usage).
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
 */
export const MCP_ACTOR: Actor = 'builder';
