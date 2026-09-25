/**
 * `lazy conversations` — browse captured builder conversations from the terminal.
 *
 * Builder sessions are captured into lazy's store automatically (live capture
 * and import). MCP agents reach them via lazy_conversations /
 * lazy_conversation_search / lazy_conversation_read; this is the human surface.
 *
 * Shaped to sit beside a future `lazy chat` without rework: list/search/show
 * are read-only views over immutable history, not interactive sessions.
 *
 * Subcommands:
 *   list (default)       — timestamps, summary, session id prefix, newest first
 *   search <query>       — keyword/regex search across message content
 *   show <session-id>    — read one conversation in full
 *   promote <session-id> — seed a backlog task from a range of its messages
 *
 * `promote` is the one subcommand that writes, and what it writes is a TASK:
 * the conversation record itself stays immutable history (src/conversation/promote.ts).
 */

import { requireActorIdentity } from '../identity-preflight';
import { requireStorage, parseFlags } from '../helpers';
import { theme } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import { parsePositiveInt } from './stats-flags';
import { searchConversations } from '../../conversation/search';
import { printConversationList } from '../../conversation/list';
import { resolveStoredConversation } from '../../conversation/ask';
import {
  buildConversationTaskPrompt,
  conversationPromotions,
  defaultConversationCode,
  defaultConversationGoal,
  formatMessageRange,
  rangesOverlap,
  resolveMessageRange,
} from '../../conversation/promote';
import { isTTY, openEditor, promptLine, removeRecoveryFile } from '../editor';
import { showConversationTranscript } from './import-conversation';

function requireSessionId(sub: string, id: string | undefined): string {
  if (!id || !/^[0-9a-fA-F-]+$/.test(id)) {
    console.error(
      id
        ? `Invalid session id '${id}' — ids are hex UUIDs (or a unique prefix), e.g. 3f9a01b2.`
        : `Usage: lazy conversations ${sub} <session-id>`,
    );
    console.error(`List ids with: ${theme.command('lazy conversations')}`);
    process.exit(1);
  }
  return id;
}

function requireSearchQuery(query: string | undefined): string {
  if (!query?.trim()) {
    console.error('Usage: lazy conversations search <query>');
    console.error(`Example: ${theme.command('lazy conversations search "design decision"')}`);
    process.exit(1);
  }
  return query.trim();
}

export async function commandConversations(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case undefined:
    case 'list':
    case 'ls':
      await commandConversationsList(subArgs);
      break;
    case 'search':
      await commandConversationsSearch(subArgs);
      break;
    case 'show':
    case 'read':
      await commandConversationsShow(subArgs);
      break;
    case 'promote':
      await commandConversationsPromote(subArgs);
      break;
    default:
      // Allow `lazy conversations --search foo` without an explicit `list`.
      if (subcommand.startsWith('-')) {
        await commandConversationsList(args);
        return;
      }
      console.error(`Unknown conversations subcommand: ${subcommand}`);
      conversationsUsage();
      process.exit(1);
  }
}

export const conversationsSubcommandUsage: Record<string, () => void> = {
  'list': conversationsUsage,
  'search': conversationsUsage,
  'show': conversationsUsage,
  'promote': conversationsUsage,
};

async function commandConversationsList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'search', aliases: ['s'], takesValue: true },
    { name: 'limit', takesValue: true },
    { name: 'offset', takesValue: true },
  ], 'conversations');

  const inlineSearch = parsed.flags.get('search') as string | undefined;
  if (inlineSearch !== undefined) {
    await runConversationSearch(inlineSearch, parsed.flags);
    return;
  }

  const offset = parsePositiveInt(parsed.flags.get('offset') as string | undefined, 'offset', 0);
  const limitFlag = parsed.flags.get('limit') as string | undefined;
  const limit = limitFlag === undefined
    ? undefined
    : parsePositiveInt(limitFlag, 'limit', 50);

  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversationSummaries();
    if (conversations.length === 0) {
      console.log('No captured builder conversations yet.');
      console.log(`Start one with: ${theme.command('lazy builder')}`);
      console.log(`Or import Claude Code history: ${theme.command('lazy import-conversation')}`);
      return;
    }

    const { shown, total, hasMore } = printConversationList(conversations, {
      offset,
      limit,
      useSummaryColumn: true,
    });

    if (hasMore) {
      console.log(
        `\nShowing ${shown} of ${total}. Next page: ` +
        theme.command(`lazy conversations list --offset ${offset + shown}${limit !== undefined ? ` --limit ${limit}` : ''}`),
      );
    }
    console.log(`\nRead one with: ${theme.command('lazy conversations show <session-id>')}`);
    console.log(`Search with: ${theme.command('lazy conversations search <query>')}`);
  } finally {
    await storage.close();
  }
}

async function commandConversationsSearch(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'limit', takesValue: true },
  ], 'conversations');
  const query = requireSearchQuery(parsed.positional[0]);
  await runConversationSearch(query, parsed.flags);
}

async function runConversationSearch(
  query: string,
  flags: Map<string, string | boolean | string[]>,
): Promise<void> {
  const maxResults = parsePositiveInt(flags.get('limit') as string | undefined, 'limit', 10);

  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    if (conversations.length === 0) {
      console.log('No captured builder conversations yet.');
      console.log(`Import history with: ${theme.command('lazy import-conversation')}`);
      return;
    }

    let hits;
    try {
      hits = await searchConversations(conversations, query, { maxResults });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    if (hits.length === 0) {
      console.log(`No conversations match '${query}'.`);
      return;
    }

    console.log(`${hits.length} conversation(s) match '${query}':\n`);
    for (const hit of hits) {
      const shortId = hit.sessionId.substring(0, 8);
      const started = hit.startedAt
        ? hit.startedAt.replace('T', ' ').substring(0, 16)
        : '-';
      console.log(`${theme.taskId(shortId)}  ${started}  ${elideHitSummary(hit.summary)}`);
      for (const match of hit.matches) {
        const role = match.role === 'user' ? 'human' : 'agent';
        console.log(`  [${role}] ${match.excerpt.replace(/\n/g, ' ')}`);
      }
      console.log('');
    }
    console.log(`Read one with: ${theme.command('lazy conversations show <session-id>')}`);
  } finally {
    await storage.close();
  }
}

function elideHitSummary(summary: string, maxLen = 80): string {
  const line = summary.split('\n')[0];
  if (line.length <= maxLen) return line;
  return line.substring(0, maxLen) + '...';
}

async function commandConversationsShow(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'conversations');
  const sessionId = requireSessionId('show', parsed.positional[0]);

  const storage = await requireStorage();
  try {
    const match = await resolveStoredConversation(storage, sessionId);
    if (!match) {
      console.error(`No conversation matches '${sessionId}'.`);
      console.error(`List them with: ${theme.command('lazy conversations')}`);
      process.exit(1);
    }
    if ('ambiguous' in match) {
      console.error(`Multiple conversations match '${sessionId}'. Use a longer prefix:`);
      for (const c of match.ambiguous) {
        const firstLine = c.summary.split('\n')[0].substring(0, 60);
        console.error(`  ${c.sessionId.substring(0, 8)}  ${firstLine}`);
      }
      process.exit(1);
    }

    await showConversationTranscript(storage, match.conversation.sessionId);
  } finally {
    await storage.close();
  }
}

/**
 * `lazy conversations promote <session-id> --from N [--to M]` — turn part of a
 * stored conversation into a backlog task.
 *
 * A RANGE IS REQUIRED. Defaulting to the whole transcript would seed a task
 * with hundreds of messages about a dozen topics, which is worse than useless:
 * the human names the exchange the decision happened in. `lazy conversations
 * show` numbers every message so the numbers are there to read off.
 *
 * ORDER MATTERS. Everything that can fail — resolving the session, validating
 * the range, refusing a range already promoted — runs BEFORE the editor opens,
 * so nobody types a brief only to have a pre-flight failure discard it. If the
 * create itself fails afterwards, the editor's recovery file is kept and its
 * path printed.
 */
async function commandConversationsPromote(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'from', takesValue: true },
    { name: 'to', takesValue: true },
    { name: 'goal', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'conversations');

  // Before the promoted task's goal and prompt are typed is typed: the daemon refuses a write it cannot
  // attribute, and a refusal must never cost the human what they wrote.
  await requireActorIdentity();

  const sessionId = requireSessionId('promote', parsed.positional[0]);
  const fromFlag = parsed.flags.get('from') as string | undefined;
  if (!fromFlag) {
    console.error('Which messages? Pass --from <n> (and --to <n> for a range).');
    console.error(`Message numbers are shown by: ${theme.command(`lazy conversations show ${sessionId}`)}`);
    process.exit(1);
  }
  const from = parsePositiveInt(fromFlag, 'from', 1);
  const toFlag = parsed.flags.get('to') as string | undefined;
  const to = toFlag === undefined ? from : parsePositiveInt(toFlag, 'to', from);
  const skipPrompts = parsed.flags.get('yes') === true || !isTTY();

  const storage = await requireStorage();
  let recoveryPath: string | null = null;
  try {
    const match = await resolveStoredConversation(storage, sessionId);
    if (!match) {
      console.error(`No conversation matches '${sessionId}'.`);
      console.error(`List them with: ${theme.command('lazy conversations')}`);
      process.exit(1);
    }
    if ('ambiguous' in match) {
      console.error(`Multiple conversations match '${sessionId}'. Use a longer prefix:`);
      for (const c of match.ambiguous) {
        console.error(`  ${c.sessionId.substring(0, 8)}  ${c.summary.split('\n')[0].substring(0, 60)}`);
      }
      process.exit(1);
    }
    const conv = match.conversation;

    let range;
    try {
      range = resolveMessageRange(conv, { from, to });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const promotions = conversationPromotions(await storage.listTasks(), conv.sessionId);
    const duplicate = promotions.find(p => p.range.from === range.from && p.range.to === range.to);
    if (duplicate) {
      console.error(
        `Messages ${formatMessageRange(range)} were already promoted to ` +
        `${duplicate.task.code ?? duplicate.task.id.slice(0, 8)}.`,
      );
      process.exit(1);
    }
    for (const p of promotions.filter(p => rangesOverlap(p.range, range))) {
      console.log(theme.warning(
        `Note: messages ${formatMessageRange(p.range)} already became ` +
        `${p.task.code ?? p.task.id.slice(0, 8)} — this range overlaps it.`,
      ));
    }

    let goal = (parsed.flags.get('goal') as string | undefined)?.trim() || defaultConversationGoal(conv, range);
    let code = (parsed.flags.get('code') as string | undefined)?.trim() || defaultConversationCode(goal) || '';
    let parent = (parsed.flags.get('parent') as string | undefined)?.trim() || '';
    let prompt = buildConversationTaskPrompt(conv, range);

    console.log(
      `Promoting message${range.from === range.to ? '' : 's'} ${formatMessageRange(range)} of ` +
      `${conv.messages.length} from conversation ${theme.taskId(conv.sessionId.substring(0, 8))}.`,
    );

    if (!skipPrompts) {
      goal = (await promptLine('Goal', goal)).trim() || goal;
      code = (await promptLine('Code (blank for none)', code)).trim();
      parent = (await promptLine('Parent task (blank for top level)', parent)).trim();
      const edited = await openEditor(prompt, 'conversation-promote');
      if (!edited || !edited.content.trim()) {
        console.error('Empty prompt — nothing promoted.');
        process.exit(1);
      }
      prompt = edited.content;
      recoveryPath = edited.recoveryPath;
    }

    const result = await storage.promoteConversation(conv.sessionId, {
      from: range.from,
      to: range.to,
      goal,
      prompt,
      ...(code ? { code } : {}),
      ...(parent ? { parent } : {}),
      actor: 'human',
    });

    if (recoveryPath) removeRecoveryFile(recoveryPath);
    recoveryPath = null;

    const label = result.task.code ?? result.task.id.slice(0, 8);
    console.log(`\nCreated backlog task ${theme.taskId(label)}: ${result.task.goal}`);
    console.log('It is not started — promotion creates the task, starting the work is your call.');
    console.log(`Start it with: ${theme.command(`lazy start ${label}`)}`);
  } catch (err) {
    console.error(`Could not promote: ${err instanceof Error ? err.message : String(err)}`);
    if (recoveryPath) {
      console.error(`Your edited prompt is safe at: ${recoveryPath}`);
    }
    process.exit(1);
  } finally {
    await storage.close();
  }
}

export function conversationsUsage(): void {
  console.log(`Usage: lazy conversations <subcommand>

Browse captured builder conversations — the reasoning and decisions from past
builder sessions, stored automatically alongside task data.

Subcommands:
  list                 List conversations (default; newest first)
  search <query>       Search message content (regex, case-insensitive)
  show <session-id>    Read one conversation in full
  promote <session-id> Turn a range of its messages into a backlog task

Options:
  -s, --search <query> (list) Run a search without a separate subcommand
      --limit <n>      (list) Page size (default: show all)
      --offset <n>     (list) Skip the first N conversations
      --limit <n>      (search) Max conversations to return (default 10)
      --from <n>       (promote) First message of the range (required)
      --to <n>         (promote) Last message of the range (default: --from)
      --goal <text>    (promote) Goal for the new task (default: seeded)
      --code <code>    (promote) Kebab-case code (default: derived from the goal)
      --parent <task>  (promote) Parent task id or code (default: top level)
      --yes            (promote) Take the seeded goal and prompt unedited

Session ids are UUIDs; any unique prefix works (the listing shows the first 8).

${'`'}promote${'`'} seeds a BACKLOG task from the messages you name (${'`'}show${'`'} numbers them)
and opens your editor on the seeded prompt first. Nothing is started, and the new
task records which conversation and which messages it came from.

To import Claude Code history that predates lazy, use
${'`'}lazy import-conversation${'`'}. To start a new builder session,
${'`'}lazy builder${'`'}.

Examples:
  lazy conversations
  lazy conversations list --limit 20
  lazy conversations search "release hub"
  lazy conversations --search "design decision"
  lazy conversations show 3f9a01b2
  lazy conversations promote 3f9a01b2 --from 12 --to 18
  lazy search 'in:conversations "token usage"'${docsFooter('conversation-import')}`);
}
