/**
 * CLI helpers for raised-item resolution flags and the interactive walk-through.
 *
 * Accept requires an all-or-nothing resolution set (daemon refuses otherwise);
 * unblock may resolve a subset. `--yes` does NOT skip the interactive walk —
 * same philosophy as the protection passphrase (friction, not an automatable
 * checkbox). See docs/design/structural-agent-questions.md.
 */

import type { RaisedItem, RaisedItemResolution } from '../types';
import type { FlagDefinition } from './helpers';
import { isTTY, promptChoice, promptLine, PromptCancelledError } from './editor';
import { theme, dim } from '../render/theme';
import { acceptWithRaisedResolutionsCommand } from '../daemon/accept-refusal';
import { openRaisedItems } from '../daemon/raised-items';

/** Flag table entries shared by `lazy accept` and `lazy unblock`. */
export const RAISED_RESOLUTION_FLAGS: FlagDefinition[] = [
  { name: 'respond-raised', takesValue: true, accumulate: true },
  { name: 'promote-raised-subtask', takesValue: true, accumulate: true },
  { name: 'promote-raised-peer', takesValue: true, accumulate: true },
  { name: 'dismiss-raised', takesValue: true, accumulate: true },
  // Peer of --dismiss-raised: same act, opposite valence ("maybe later" vs
  // "will not act"), and it counts toward the all-or-nothing gate the same way.
  { name: 'acknowledge-raised', takesValue: true, accumulate: true },
];

/**
 * Parse `--respond-raised id=text` / `--dismiss-raised id=reason` values.
 * Splits on the first `=` so the response body may contain further `=` signs.
 */
export function parseIdEqualsValue(raw: string, flagLabel: string): { id: string; response: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(
      `${flagLabel} expects <id>=<text> (got ${JSON.stringify(raw)}). ` +
      `Example: ${flagLabel} abc12345=ship option 2`,
    );
  }
  const id = raw.slice(0, eq).trim();
  const response = raw.slice(eq + 1);
  if (!id) {
    throw new Error(`${flagLabel} id must not be empty`);
  }
  if (!response.trim()) {
    throw new Error(`${flagLabel} requires non-empty text after '='`);
  }
  return { id, response };
}

/**
 * Parse `--promote-raised-subtask <id>` / `--promote-raised-peer <id>[=<note>]`.
 * The note after `=` is optional.
 */
export function parseIdOrIdEquals(raw: string, flagLabel: string): { id: string; response?: string } {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    const id = raw.trim();
    if (!id) {
      throw new Error(`${flagLabel} requires a raised-item id`);
    }
    return { id };
  }
  if (eq === 0) {
    throw new Error(`${flagLabel} id must not be empty`);
  }
  const id = raw.slice(0, eq).trim();
  const response = raw.slice(eq + 1);
  if (!id) {
    throw new Error(`${flagLabel} id must not be empty`);
  }
  return {
    id,
    ...(response.trim() ? { response } : {}),
  };
}

/**
 * Build a RaisedItemResolution[] from parsed CLI flags.
 * Returns undefined when none of the raised flags were supplied.
 */
export function resolutionsFromFlags(flags: Map<string, string | boolean | string[]>): RaisedItemResolution[] | undefined {
  const respond = (flags.get('respond-raised') as string[] | undefined) ?? [];
  const subtask = (flags.get('promote-raised-subtask') as string[] | undefined) ?? [];
  const peer = (flags.get('promote-raised-peer') as string[] | undefined) ?? [];
  const dismiss = (flags.get('dismiss-raised') as string[] | undefined) ?? [];
  const acknowledge = (flags.get('acknowledge-raised') as string[] | undefined) ?? [];

  if (
    respond.length === 0 && subtask.length === 0 && peer.length === 0
    && dismiss.length === 0 && acknowledge.length === 0
  ) {
    return undefined;
  }

  const out: RaisedItemResolution[] = [];
  for (const raw of respond) {
    const { id, response } = parseIdEqualsValue(raw, '--respond-raised');
    out.push({ id, action: 'respond', response });
  }
  for (const raw of subtask) {
    const { id, response } = parseIdOrIdEquals(raw, '--promote-raised-subtask');
    out.push({ id, action: 'promote_subtask', ...(response ? { response } : {}) });
  }
  for (const raw of peer) {
    const { id, response } = parseIdOrIdEquals(raw, '--promote-raised-peer');
    out.push({ id, action: 'promote_peer', ...(response ? { response } : {}) });
  }
  for (const raw of dismiss) {
    const { id, response } = parseIdEqualsValue(raw, '--dismiss-raised');
    out.push({ id, action: 'dismiss', response });
  }
  // The note is optional: "seen, maybe later" needs no words, unlike a
  // dismissal, which owes the agent a reason.
  for (const raw of acknowledge) {
    const { id, response } = parseIdOrIdEquals(raw, '--acknowledge-raised');
    out.push({ id, action: 'acknowledge', ...(response ? { response } : {}) });
  }
  return out;
}

/** True when any raised-resolution flag appears on the argv (forces imperative unblock). */
export function argsHaveRaisedFlags(args: string[]): boolean {
  return (
    args.includes('--respond-raised')
    || args.includes('--promote-raised-subtask')
    || args.includes('--promote-raised-peer')
    || args.includes('--dismiss-raised')
    || args.includes('--acknowledge-raised')
  );
}

/**
 * Interactive TTY walk: present each open raised item and collect a resolution.
 *
 * INVARIANT: `--yes` must NOT call this away — the caller still walks when a
 * TTY is available and no flags were given. Non-interactive callers use flags.
 */
export async function walkRaisedItemsInteractive(
  open: RaisedItem[],
): Promise<RaisedItemResolution[]> {
  if (open.length === 0) return [];

  console.log(theme.separator(
    `\n${open.length} open raised item${open.length === 1 ? '' : 's'} — each must be ` +
    `responded to, promoted, dismissed, or acknowledged before accept.`,
  ));
  console.log(dim(
    '(--yes does not skip this; use --respond-raised / --promote-raised-subtask / ' +
    '--promote-raised-peer / --dismiss-raised / --acknowledge-raised for non-interactive.)\n',
  ));

  const resolutions: RaisedItemResolution[] = [];

  for (let i = 0; i < open.length; i++) {
    const item = open[i]!;
    const short = item.id.slice(0, 8);
    console.log(theme.label(`Raised item ${i + 1}/${open.length} (${short}):`));
    console.log(`  ${item.content}`);
    if (item.options && item.options.length > 0) {
      console.log(dim('  Options:'));
      for (const opt of item.options) {
        console.log(`    - ${opt}`);
      }
    }
    console.log('');

    let choice: number;
    try {
      choice = await promptChoice(
        'Resolve this raised item',
        [
          'Respond to agent — schedule a comment quoting this item',
          'Promote to subtask — create a child task under this one (on unblock/accept)',
          'Promote to peer task — create a sibling task (on unblock/accept)',
          'Dismiss — drop it and tell the agent ("will not act")',
          'Acknowledge — note it and move on ("seen, maybe later")',
        ],
      );
    } catch (err) {
      if (err instanceof PromptCancelledError) {
        console.error('Accept cancelled.');
        process.exit(1);
      }
      throw err;
    }

    if (choice === 0) {
      let answer: string;
      try {
        answer = await promptLine('Your response', undefined);
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        throw err;
      }
      if (!answer.trim()) {
        console.error('Error: a response is required. Re-run accept to try again.');
        process.exit(1);
      }
      resolutions.push({ id: item.id, action: 'respond', response: answer.trim() });
      console.log(theme.success(`  Will respond on ${short} (comment pending until unblock/accept).\n`));
    } else if (choice === 1) {
      let note = '';
      try {
        note = await promptLine('Optional note for the subtask (Enter to skip)', '');
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        throw err;
      }
      resolutions.push({
        id: item.id,
        action: 'promote_subtask',
        ...(note.trim() ? { response: note.trim() } : {}),
      });
      console.log(theme.success(`  Will promote ${short} to a subtask on unblock/accept.\n`));
    } else if (choice === 2) {
      let note = '';
      try {
        note = await promptLine('Optional note for the peer task (Enter to skip)', '');
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        throw err;
      }
      resolutions.push({
        id: item.id,
        action: 'promote_peer',
        ...(note.trim() ? { response: note.trim() } : {}),
      });
      console.log(theme.success(`  Will promote ${short} to a peer task on unblock/accept.\n`));
    } else if (choice === 3) {
      let reason: string;
      try {
        reason = await promptLine('Dismiss reason', undefined);
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        throw err;
      }
      if (!reason.trim()) {
        console.error('Error: a dismiss reason is required. Re-run accept to try again.');
        process.exit(1);
      }
      resolutions.push({ id: item.id, action: 'dismiss', response: reason.trim() });
      console.log(theme.success(`  Will dismiss ${short}.\n`));
    } else {
      // Same act as dismiss, different valence — so the note is optional here
      // and required there: "seen, maybe later" needs no words, a refusal does.
      let note = '';
      try {
        note = await promptLine('Optional note (Enter to skip)', '');
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          console.error('Accept cancelled.');
          process.exit(1);
        }
        throw err;
      }
      resolutions.push({
        id: item.id,
        action: 'acknowledge',
        ...(note.trim() ? { response: note.trim() } : {}),
      });
      console.log(theme.success(`  Will acknowledge ${short}.\n`));
    }
  }

  return resolutions;
}

/**
 * Collect raised resolutions for accept:
 * - flags win when supplied
 * - TTY + no flags → interactive walk (even under `--yes`)
 * - non-TTY + no flags + open items → refuse with pasteable command
 *
 * Returns undefined when there are no open items and no flags.
 */
export async function collectRaisedResolutionsForAccept(opts: {
  flags: Map<string, string | boolean | string[]>;
  openItems: RaisedItem[];
  displayId: string;
}): Promise<RaisedItemResolution[] | undefined> {
  let fromFlags: RaisedItemResolution[] | undefined;
  try {
    fromFlags = resolutionsFromFlags(opts.flags);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (fromFlags !== undefined) {
    return fromFlags;
  }

  const open = openRaisedItems(opts.openItems);
  if (open.length === 0) {
    return undefined;
  }

  // INVARIANT: --yes does NOT skip raised-item resolution. A TTY still walks;
  // a non-TTY without flags gets the pasteable refuse (daemon would too).
  if (isTTY()) {
    return walkRaisedItemsInteractive(open);
  }

  const ids = open.map(i => i.id.slice(0, 8));
  const summary = open
    .map(i => `  - ${i.id.slice(0, 8)}: ${i.content.slice(0, 80)}${i.content.length > 80 ? '…' : ''}`)
    .join('\n');
  console.error(
    `Error: Task ${opts.displayId} has ${open.length} open raised item(s) that must be ` +
    `responded to, promoted, dismissed, or acknowledged before accept:\n${summary}\n\n` +
    `Non-interactive accept needs explicit flags, e.g.:\n  ${acceptWithRaisedResolutionsCommand(opts.displayId, ids)}\n` +
    `Or run \`lazy accept ${opts.displayId}\` from a terminal to walk each item.`,
  );
  process.exit(1);
}

/**
 * Collect optional raised resolutions for unblock.
 * Flags only — interactive unblock may walk later; imperative without flags
 * leaves items open (next accept still gates).
 */
export function collectRaisedResolutionsForUnblock(
  flags: Map<string, string | boolean | string[]>,
): RaisedItemResolution[] | undefined {
  try {
    return resolutionsFromFlags(flags);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
