/**
 * import-conversation command
 *
 * Imports Claude Code conversation logs into lazy as persisted
 * development context. Conversations are stored via the Storage interface.
 *
 * Usage:
 *   lazy import-conversation                  # Auto-discover and import all sessions
 *   lazy import-conversation <session-id>     # Import a specific session
 *   lazy import-conversation --list           # List available sessions to import
 */

import { requireLazyRoot, requireStorage, parseFlags, type LineRange, sliceLines } from '../helpers';
import { theme } from '../theme';
import {
  discoverAllProjectSessions,
  parseConversation,
  extractSummary,
  conversationStats,
} from '../../import/claude-code-logs';
import { toStoredConversation } from '../../import/conversation-storage';
import type { Storage } from '../../storage/interface';

export async function commandImportConversation(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'list', aliases: ['l'], takesValue: false },
    { name: 'show-imported', takesValue: false },
    { name: 'show', takesValue: true },
    { name: 'all', aliases: ['a'], takesValue: false },
  ], 'import-conversation');

  const lazyRoot = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const listMode = parsed.flags.get('list') === true;
    const showImported = parsed.flags.get('show-imported') === true;
    const showSession = parsed.flags.get('show') as string | undefined;
    const allMode = parsed.flags.get('all') === true;

    const sessionIdArg = parsed.positional[0];

    if (showSession) {
      await showConversationTranscript(storage, showSession);
      return;
    }

    if (showImported) {
      await showImportedConversations(storage);
      return;
    }

    // Discover available sessions
    const available = await discoverAllProjectSessions(lazyRoot);

    if (available.length === 0) {
      console.log('No Claude Code sessions found for this project.');
      console.log(`Looked in: ~/.claude/projects/ for paths matching ${lazyRoot}`);
      return;
    }

    if (listMode) {
      await listAvailableSessions(storage, available);
      return;
    }

    if (sessionIdArg) {
      // Import a specific session
      const match = available.find((s) => s.sessionId === sessionIdArg || s.sessionId.startsWith(sessionIdArg));
      if (!match) {
        console.error(`Session not found: ${sessionIdArg}`);
        console.error(`Run 'lazy import-conversation --list' to see available sessions.`);
        process.exit(1);
      }

      await importSession(storage, match.projectPath, match.sessionId);
      return;
    }

    // Default: import all new sessions (or all if --all)
    let imported = 0;
    let skipped = 0;

    for (const session of available) {
      const alreadyImported = await storage.isConversationImported(session.sessionId);

      if (alreadyImported && !allMode) {
        skipped++;
        continue;
      }

      await importSession(storage, session.projectPath, session.sessionId);
      imported++;
    }

    if (imported === 0 && skipped > 0) {
      console.log(`All ${skipped} session(s) already imported. Use --all to re-import.`);
    } else if (imported === 0) {
      console.log('No sessions to import.');
    } else {
      console.log(`\nImported ${imported} session(s)${skipped > 0 ? `, ${skipped} already imported` : ''}.`);
    }
  } finally {
    await storage.close();
  }
}

async function importSession(storage: Storage, projectPath: string, sessionId: string): Promise<void> {
  try {
    const conversation = await parseConversation(projectPath, sessionId);
    const summary = extractSummary(conversation);
    const stats = conversationStats(conversation);

    const stored = toStoredConversation(conversation, summary, stats);
    await storage.saveConversation(stored);

    const shortId = sessionId.substring(0, 8);
    console.log(`Imported ${shortId}  ${stats.messageCount} msgs, ${stats.subagentCount} subagents, ${stats.totalTokens} tokens`);
    console.log(`  Summary: ${summary.substring(0, 100)}${summary.length > 100 ? '...' : ''}`);
    if (conversation.gitBranch) {
      console.log(`  Branch:  ${conversation.gitBranch}`);
    }
    if (conversation.startedAt) {
      console.log(`  Started: ${conversation.startedAt}`);
    }
  } catch (err) {
    const shortId = sessionId.substring(0, 8);
    console.error(`Failed to import ${shortId}: ${(err as Error).message}`);
  }
}

async function listAvailableSessions(
  storage: Storage,
  available: Array<{ projectPath: string; sessionId: string }>
): Promise<void> {
  console.log(`Found ${available.length} Claude Code session(s):\n`);

  for (const session of available) {
    const alreadyImported = await storage.isConversationImported(session.sessionId);
    const shortId = session.sessionId.substring(0, 8);
    const status = alreadyImported ? '[imported]' : '[new]     ';

    try {
      const conversation = await parseConversation(session.projectPath, session.sessionId);
      const summary = extractSummary(conversation);
      const stats = conversationStats(conversation);

      console.log(`  ${shortId}  ${status}  ${stats.messageCount} msgs  ${summary.substring(0, 60)}${summary.length > 60 ? '...' : ''}`);
    } catch {
      console.log(`  ${shortId}  ${status}  (failed to parse)`);
    }
  }

  console.log(`\nRun 'lazy import-conversation' to import all new sessions.`);
  console.log(`Run 'lazy import-conversation <session-id>' to import a specific session.`);
}

export async function showConversationTranscript(storage: Storage, sessionIdPrefix: string, lineRange: LineRange | null = null): Promise<void> {
  // Find the matching conversation
  const conversations = await storage.listConversations();
  const match = conversations.find(
    c => c.sessionId === sessionIdPrefix || c.sessionId.startsWith(sessionIdPrefix)
  );

  if (!match) {
    console.error(`Conversation not found: ${sessionIdPrefix}`);
    console.error(`Run 'lazy import-conversation --show-imported' to see available conversations.`);
    process.exit(1);
  }

  const conv = await storage.loadConversation(match.sessionId);
  if (!conv) {
    console.error(`Failed to load conversation: ${match.sessionId}`);
    process.exit(1);
  }

  // Build output into a buffer
  const outputLines: string[] = [];

  // Header
  outputLines.push(`Conversation ${theme.taskId(conv.sessionId.substring(0, 8))}`);
  outputLines.push(`  ${theme.label('Session:')}  ${conv.sessionId}`);
  if (conv.gitBranch) {
    outputLines.push(`  ${theme.label('Branch:')}   ${conv.gitBranch}`);
  }
  if (conv.startedAt) {
    outputLines.push(`  ${theme.label('Started:')}  ${conv.startedAt.replace('T', ' ').substring(0, 19)}`);
  }
  if (conv.endedAt) {
    outputLines.push(`  ${theme.label('Ended:')}    ${conv.endedAt.replace('T', ' ').substring(0, 19)}`);
  }
  outputLines.push(`  ${theme.label('Messages:')} ${conv.stats.messageCount} (${conv.stats.userMessageCount} human, ${conv.stats.assistantMessageCount} assistant)`);
  outputLines.push(`  ${theme.label('Summary:')}  ${conv.summary}`);
  outputLines.push('');

  // Interleaved messages
  for (const msg of conv.messages) {
    const roleLabel = msg.role === 'user'
      ? theme.turnRole('human')
      : theme.turnRole('agent');
    const timestamp = msg.timestamp ? msg.timestamp.replace('T', ' ').substring(11, 19) : '';
    outputLines.push(`${theme.separator('---')} ${roleLabel} ${timestamp ? `(${timestamp})` : ''} ${theme.separator('---')}`);
    outputLines.push(msg.text);
    outputLines.push('');
  }

  // Join output and apply line slicing if specified
  let output = outputLines.join('\n');
  if (lineRange) {
    output = sliceLines(output, lineRange);
  }
  console.log(output);
}

async function showImportedConversations(storage: Storage): Promise<void> {
  const conversations = await storage.listConversations();

  if (conversations.length === 0) {
    console.log('No imported conversations yet.');
    console.log(`Run 'lazy import-conversation' to import Claude Code sessions.`);
    return;
  }

  console.log(`${conversations.length} imported conversation(s):\n`);

  console.log(`${'SESSION'.padEnd(10)} ${'STARTED'.padEnd(18)} ${'MSGS'.padEnd(6)} ${'TOKENS'.padEnd(9)} ${'BRANCH'.padEnd(25)} SUMMARY`);

  for (const conv of conversations) {
    const shortId = conv.sessionId.substring(0, 8);
    const started = conv.startedAt ? conv.startedAt.replace('T', ' ').substring(0, 16) : 'unknown';
    const msgs = String(conv.stats.messageCount).padEnd(6);
    const tokens = String(conv.stats.totalTokens).padEnd(9);
    const branch = (conv.gitBranch ?? '').substring(0, 24).padEnd(25);
    const summary = conv.summary.substring(0, 50) + (conv.summary.length > 50 ? '...' : '');

    console.log(`${shortId.padEnd(10)} ${started.padEnd(18)} ${msgs} ${tokens} ${branch} ${summary}`);
  }
}

export function importConversationUsage(): void {
  console.log(`Usage: lazy import-conversation [options] [session-id]

Import Claude Code conversation logs as development context.

Conversations are stored in the configured storage location and tracked
alongside task data. They serve as a persisted record of interactive
Claude Code sessions - the reasoning, exploration, and decisions that
happened during development.

Builder sessions are captured automatically when 'lazy builder' exits.

Arguments:
  [session-id]     Import a specific session (can be shortened)

Options:
  --list, -l            List available sessions to import
  --all, -a             Re-import all sessions (including already imported)
  --show-imported       Show already imported conversations (table)
  --show <session-id>   Show full interleaved conversation transcript

Auto-discovery:
  Without arguments, discovers all Claude Code sessions for this project
  (including worktree sessions) and imports any that haven't been imported yet.

Examples:
  lazy import-conversation              # Import all new sessions
  lazy import-conversation --list       # List available sessions
  lazy import-conversation bc77e1b1     # Import specific session
  lazy import-conversation --all        # Re-import everything
  lazy import-conversation --show-imported        # Show imported list
  lazy import-conversation --show bc77e1b1        # Show full conversation`);
}
