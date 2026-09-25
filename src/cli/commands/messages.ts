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
 */

import { requireStorage, parseFlags } from '../helpers';
import { formatDate } from '../../utils/format';
import { theme } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import { getActor } from '../../constants';
import { shortMessageId, systemMessageState } from '../../messages';

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
        `${shortMessageId(m.id).padEnd(9)} ${m.kind.padEnd(7)} ${systemMessageState(m).padEnd(10)} ${formatDate(m.created_at).padEnd(18)} ${m.source.padEnd(24)} ${m.title}`,
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
  const parsed = parseFlags(args, [], 'messages');
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

Options:
  -a, --all            (list) Include dismissed messages

Ids are UUIDs; any unique prefix works (the listing shows the first 8 chars).

Not lazy's own diagnosis channel: lazy's configuration and health problems are
diagnosed by ${'`'}lazy doctor${'`'}. System messages carry reports, and blockers in your
environment that an agent hit and could not fix; producers file them via the
${'`'}lazy_message_post${'`'} MCP tool (dismissal is human/builder-only).

Examples:
  lazy messages
  lazy messages read 3f9a01b2
  lazy messages dismiss 3f9a01b2
  lazy messages list --all${docsFooter('system-messages')}`);
}
