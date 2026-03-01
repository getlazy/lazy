/**
 * Extract agent response from Claude Code container output.
 *
 * When Claude Code runs with --output-format json, the stdout contains
 * a JSON object with the response. This module parses that output from
 * either the container logs or the raw stdout.
 */

import { logger } from './logger';
import type { ClaudeResponse } from '../types';

/**
 * Parse Claude Code's JSON output from container logs.
 * Returns the ClaudeResponse if valid, null otherwise.
 */
export function extractClaudeResponse(output: string): ClaudeResponse | null {
  if (!output || !output.trim()) {
    return null;
  }

  try {
    // Claude Code with --output-format json outputs a single JSON object on stdout
    const parsed = JSON.parse(output.trim()) as ClaudeResponse;

    // Validate it has the expected shape
    if (parsed && typeof parsed.result === 'string' && typeof parsed.session_id === 'string') {
      return parsed;
    }

    logger.debug('Parsed JSON but missing expected fields (result, session_id)');
    return null;
  } catch {
    // Output might contain non-JSON lines before the JSON output
    // Try to find the JSON object in the output
    const lines = output.trim().split('\n');

    // Try the last line first (most likely to be the JSON output)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as ClaudeResponse;
          if (parsed && typeof parsed.result === 'string' && typeof parsed.session_id === 'string') {
            return parsed;
          }
        } catch {
          continue;
        }
      }
    }

    logger.debug('Could not extract Claude response from output');
    return null;
  }
}
