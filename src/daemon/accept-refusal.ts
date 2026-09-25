/**
 * Composing the remedy for a refused accept.
 *
 * The daemon is the only component that knows WHY an accept was refused, so it
 * is the component that says what to do about it — including composing the
 * exact command, with every file already enumerated. Clients render; they never
 * infer a remedy from the prose of a message (see src/types/accept-remedy.ts).
 *
 * `AcceptRefusedError` is an `RpcError`, so every existing route keeps mapping
 * `.status` to HTTP verbatim and nothing downstream needs to know this subclass
 * exists to keep working.
 */

import { RpcError } from './rpc-error';
import type { AcceptRemedy } from '../types';

export class AcceptRefusedError extends RpcError {
  constructor(status: number, message: string, public readonly remedy: AcceptRemedy) {
    super(status, message);
    this.name = 'AcceptRefusedError';
  }
}

/** Convenience constructor, so refusal sites read as one expression. */
export function acceptRefusal(status: number, message: string, remedy: AcceptRemedy): AcceptRefusedError {
  return new AcceptRefusedError(status, message, remedy);
}

/**
 * Quote one argument for a shell command the human will paste.
 *
 * A file path with a space or a quote in it is exactly the case where
 * hand-reconstruction goes wrong, so the composed command must survive it.
 */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `lazy accept <id> [--approve-file a --approve-file b …] [--reason "…"]`,
 * ready to paste.
 *
 * A protection-gate refusal used to print a bare `lazy accept <id>`. On a
 * conflict task that already has approved files, that command is the one that
 * would miss `--approve-file` and look like a revert — so every accept
 * remedy, including the passphrase gate, goes through here.
 */
export function acceptWithApprovedFilesCommand(
  displayId: string,
  files: readonly string[],
  options?: { reason?: string },
): string {
  const parts = [`lazy accept ${shellQuote(displayId)}`];
  for (const f of files) {
    parts.push(`--approve-file ${shellQuote(f)}`);
  }
  const reason = options?.reason?.trim();
  if (reason) {
    parts.push(`--reason ${shellQuote(reason)}`);
  }
  return parts.join(' ');
}

/**
 * `lazy accept <id> --respond-raised <id>="your response" …`, ready to paste.
 * The human must fill in the response (or switch the flag to a promote / dismiss).
 */
export function acceptWithRaisedResolutionsCommand(
  displayId: string,
  openItemIds: readonly string[],
): string {
  const flags = openItemIds
    .map((id) => `--respond-raised ${shellQuote(id)}=${shellQuote('your response')}`)
    .join(' ');
  return `lazy accept ${shellQuote(displayId)}${flags ? ` ${flags}` : ''}`;
}
