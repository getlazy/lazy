/**
 * JSON body parsing for the daemon's POST routes.
 *
 * WHY this exists: both POST surfaces used to read their body as
 * `await req.json().catch(() => ({}))`. That turns a truncated payload, a
 * wrong Content-Type, or a typo'd JSON literal into an EMPTY request — the
 * route then runs with no arguments and does something the caller never asked
 * for, with no error anywhere. That is the same failure class as the missing
 * `arguments` envelope: a malformed input silently becoming a valid-looking
 * empty one.
 *
 * A body that is absent or blank IS legitimately "no parameters" (the RPC
 * client sends `{}` for parameterless commands, and Bun's `req.json()` throws
 * on an empty body), so those still yield `{}`. Anything present but unparsable
 * is a 400 that names the problem.
 */

import { RpcError } from './rpc-handlers';

/** How much of a bad body to quote back. Enough to spot the typo, not a dump. */
const BODY_EXCERPT_LIMIT = 200;

function excerpt(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > BODY_EXCERPT_LIMIT
    ? `${trimmed.slice(0, BODY_EXCERPT_LIMIT)}… (${trimmed.length} bytes)`
    : trimmed;
}

/**
 * Read a request body as JSON.
 *
 * @param what - what the body is, for the error message (e.g. 'MCP tool call body')
 * @returns the parsed value; `{}` when the body is empty or absent
 * @throws RpcError 400 when the body is present but is not valid JSON
 */
export async function readJsonBody(req: Request, what: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await req.text();
  } catch (err) {
    throw new RpcError(
      400,
      `Could not read ${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (raw.trim() === '') return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RpcError(
      400,
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Received: ${excerpt(raw)}`,
    );
  }
}

/**
 * Read a request body that must be a JSON object of named parameters.
 *
 * @throws RpcError 400 for malformed JSON, or for JSON that parses to an array,
 *   a scalar, or null — none of which can carry named parameters, and all of
 *   which the old `?? {}` handling silently accepted as "no parameters".
 */
export async function readJsonObjectBody(
  req: Request,
  what: string,
): Promise<Record<string, unknown>> {
  const parsed = await readJsonBody(req, what);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`;
    throw new RpcError(
      400,
      `${what} must be a JSON object of named parameters, got ${got}.`,
    );
  }
  return parsed as Record<string, unknown>;
}
