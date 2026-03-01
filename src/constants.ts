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
