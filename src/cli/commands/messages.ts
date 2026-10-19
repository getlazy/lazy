/**
 * `lazy messages <subcommand>` — the human's inbox of system messages.
 *
 * System messages are proactive system-to-human reports: scheduled analyses
 * (post-mortems, tool-call patterns, token usage), daemon notices (version
 * changes), environment blockers an agent hit and cannot fix — anything the
 * system wrote FOR the human. Unread messages are injected compactly into the
 * builder's launch prompt; this command is the direct surface.
 *
 * NOT lazy's own diagnosis channel: config/health warnings about lazy itself
 * stay in `lazy doctor`.
 *
 * Subcommands:
 *   list              — the inbox (default; --all includes dismissed)
 *   read <id>         — one message in full; marks it read
 *   dismiss <id>      — hide a message from default surfaces (never deletes)
 *   dismiss --all | --source <s> | --title <text>
 *                     — the same, for every open message matching; the store
 *                       applies the filter, this only shows and confirms it
 */

import { requireStorage, parseFlags } from '../helpers';
import { formatDate } from '../../utils/format';
import { theme } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import { getActor } from '../../constants';
import { shortMessageId, systemMessageState } from '../../messages';
import { isTTY, promptYesNo } from '../editor';
import type { SystemMessage, SystemMessageDismissFilter } from '../../types';

/** "×37, last 2026-10-13 09:12" for a collapsed message; '' otherwise. */
function repeatSuffix(m: SystemMessage): string {
  if (!m.repeat_count || m.repeat_count < 2) return '';
  return ` (×${m.repeat_count}${m.last_seen_at ? `, last ${formatDate(m.last_seen_at)}` : ''})`;
}

/**
 * Validate an id argument at this boundary: ids are UUIDs (or prefixes of
 * one), so anything outside hex-and-dashes is a typo — reject it loudly here
 * rather than letting it fall through to a storage lookup (where a stray `%`
 * would even act as a wildcard on the Postgres backend).
 */
function requireMessageId(sub: string, id: string | undefined): string {
  if (!id || !/^[0-9a-fA-F-]+$/.test(id)) {
    console.error(
      id
        ? `Invalid message id '${id}' — ids are hex UUIDs (or a unique prefix), e.g. 3f9a01b2.`
        : `Usage: lazy messages ${sub} <id>`,
    );
    console.error(`List ids with: ${theme.command('lazy messages list')}`);
    process.exit(1);
  }
  return id;
}

export async function commandMessages(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case undefined:
    case 'list':
    case 'ls':
      await commandMessagesList(subArgs);
      break;
    case 'read':
    case 'show':
      await commandMessagesRead(subArgs);
      break;
    case 'dismiss':
      await commandMessagesDismiss(subArgs);
      break;
    default:
      console.error(`Unknown messages subcommand: ${subcommand}`);
      messagesUsage();
      process.exit(1);
  }
}

export const messagesSubcommandUsage: Record<string, () => void> = {
  'list': messagesUsage,
  'read': messagesUsage,
  'dismiss': messagesUsage,
};

async function commandMessagesList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'all', aliases: ['a'], takesValue: false },
  ], 'messages');
  const includeDismissed = parsed.flags.get('all') === true;

  const storage = await requireStorage();
  try {
    const messages = await storage.listSystemMessages({ includeDismissed });
    if (messages.length === 0) {
      console.log(includeDismissed ? 'No system messages.' : 'No system messages (dismissed ones hidden — try --all).');
      return;
    }

    console.log(`${messages.length} system message(s):\n`);
    console.log(
      `${theme.header('ID'.padEnd(9))} ${theme.header('KIND'.padEnd(7))} ${theme.header('STATUS'.padEnd(10))} ${theme.header('CREATED'.padEnd(18))} ${theme.header('SOURCE'.padEnd(24))} ${theme.header('TITLE')}`,
    );
    for (const m of messages) {
      console.log(
        `${shortMessageId(m.id).padEnd(9)} ${m.kind.padEnd(7)} ${systemMessageState(m).padEnd(10)} ${formatDate(m.created_at).padEnd(18)} ${m.source.padEnd(24)} ${m.title}${repeatSuffix(m)}`,
      );
    }
    console.log(`\nRead one with: ${theme.command('lazy messages read <id>')}`);
  } finally {
    await storage.close();
  }
}

async function commandMessagesRead(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'messages');
  const id = requireMessageId('read', parsed.positional[0]);

  const storage = await requireStorage();
  try {
    const existing = await storage.getSystemMessage(id);
    if (!existing) {
      console.error(`No system message matches '${id}'.`);
      console.error(`List them with: ${theme.command('lazy messages list --all')}`);
      process.exit(1);
    }
    // Reading IS the human seeing it — mark read (idempotent; first read wins).
    const message = await storage.markSystemMessageRead(existing.id);

    console.log(`${theme.header(message.title)}`);
    console.log(
      `${shortMessageId(message.id)} · ${message.kind} · from ${message.source} · ${formatDate(message.created_at)}` +
      (message.dismissed_at ? ` · dismissed ${formatDate(message.dismissed_at)}` : ''),
    );
    if (message.repeat_count && message.repeat_count > 1) {
      console.log(
        `Happened ${message.repeat_count} times` +
        (message.last_seen_at ? `, most recently ${formatDate(message.last_seen_at)}` : '') +
        ' — repeats are counted here instead of filed as new messages.',
      );
    }
    console.log('');
    console.log(message.body);
    if (!message.dismissed_at) {
      console.log(`\nDismiss with: ${theme.command(`lazy messages dismiss ${shortMessageId(message.id)}`)}`);
    }
  } finally {
    await storage.close();
  }
}

async function commandMessagesDismiss(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'all', aliases: ['a'], takesValue: false },
    { name: 'source', takesValue: true },
    { name: 'title', takesValue: true },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'messages');
  const all = parsed.flags.get('all') === true;
  const source = parsed.flags.get('source');
  const title = parsed.flags.get('title');
  if (all || source !== undefined || title !== undefined) {
    if (parsed.positional.length > 0) {
      console.error('Give either a message id or --all/--source/--title, not both.');
      process.exit(1);
    }
    const filter: SystemMessageDismissFilter = {};
    if (typeof source === 'string') filter.source = source;
    if (typeof title === 'string') filter.titleContains = title;
    if (all && (filter.source || filter.titleContains)) {
      console.error('--all dismisses every open message; drop it to dismiss only those matching --source/--title.');
      process.exit(1);
    }
    await dismissMatching(filter, parsed.flags.get('yes') === true);
    return;
  }
  const id = requireMessageId('dismiss', parsed.positional[0]);

  const storage = await requireStorage();
  try {
    const existing = await storage.getSystemMessage(id);
    if (!existing) {
      console.error(`No system message matches '${id}'.`);
      console.error(`List them with: ${theme.command('lazy messages list --all')}`);
      process.exit(1);
    }
    if (existing.dismissed_at) {
      console.log(`Already dismissed: ${existing.title}`);
      return;
    }
    const message = await storage.dismissSystemMessage(existing.id, getActor());
    console.log(`Dismissed: ${message.title}`);
    console.log(`It stays on record — see it again with: ${theme.command('lazy messages list --all')}`);
  } finally {
    await storage.close();
  }
}

/** What the filter means in words, for the count line and the prompt. */
function describeFilter(filter: SystemMessageDismissFilter): string {
  const parts: string[] = [];
  if (filter.source) parts.push(`from ${filter.source}`);
  if (filter.titleContains) parts.push(`with "${filter.titleContains}" in the title`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

async function dismissMatching(filter: SystemMessageDismissFilter, yes: boolean): Promise<void> {
  const storage = await requireStorage();
  try {
    // The store decides what matches — a preview first, so the count shown is
    // the store's own answer, then the same filter for real.
    const matching = await storage.dismissSystemMessages(filter, getActor(), { preview: true });
    const what = `open message(s)${describeFilter(filter)}`;
    if (matching.length === 0) {
      console.log(`No ${what}.`);
      return;
    }
    console.log(`${matching.length} ${what}:`);
    for (const m of matching.slice(0, 10)) {
      console.log(`  ${shortMessageId(m.id)}  ${m.title}${repeatSuffix(m)}`);
    }
    if (matching.length > 10) console.log(`  … and ${matching.length - 10} more`);
    if (!yes) {
      if (!isTTY()) {
        console.error('Refusing to dismiss without confirmation: pass --yes to confirm non-interactively.');
        process.exit(1);
      }
      if (!(await promptYesNo(`Dismiss ${matching.length} message(s)?`, false))) {
        console.log('Nothing dismissed.');
        return;
      }
    }
    const dismissed = await storage.dismissSystemMessages(filter, getActor());
    console.log(`Dismissed ${dismissed.length} message(s).`);
    console.log(`They stay on record — see them again with: ${theme.command('lazy messages list --all')}`);
  } finally {
    await storage.close();
  }
}

export function messagesUsage(): void {
  console.log(`Usage: lazy messages <subcommand>

Your inbox of system messages — proactive reports lazy wrote for you: scheduled
analyses (post-mortems, tool-call patterns, token usage), daemon notices, and
other findings. Unread messages appear in the builder's launch context until
read or dismissed.

Subcommands:
  list                 Show the inbox (default; dismissed messages hidden)
  read <id>            Print one message in full and mark it read
  dismiss <id>         Hide a message from default surfaces (never deletes)
  dismiss --all        Dismiss every open message (asks first)
  dismiss --source <s> Dismiss every open message from source <s>
  dismiss --title <t>  Dismiss every open message whose title contains <t>
                       (--source and --title combine)

Options:
  -a, --all            (list) Include dismissed messages; (dismiss) every open one
  --source <s>         (dismiss) Match an exact source, e.g. machine-docker
  --title <text>       (dismiss) Match a title substring, case-insensitive
  -y, --yes            (dismiss) Skip the confirmation prompt

Ids are UUIDs; any unique prefix works (the listing shows the first 8 chars).

Not lazy's own diagnosis channel: lazy's configuration and health problems are
diagnosed by ${'`'}lazy doctor${'`'}. System messages carry reports, and blockers in your
environment that an agent hit and could not fix; producers file them via the
${'`'}lazy_message_post${'`'} MCP tool (dismissal is human/builder-only).

Examples:
  lazy messages
  lazy messages read 3f9a01b2
  lazy messages dismiss 3f9a01b2
  lazy messages dismiss --source machine-docker
  lazy messages dismiss --all --yes
  lazy messages list --all${docsFooter('system-messages')}`);
}
