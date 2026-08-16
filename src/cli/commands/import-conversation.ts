/**
 * import-conversation command
 *
 * Imports Claude Code conversation logs into lazy as persisted development
 * context. Conversations are stored via the Storage interface.
 *
 * This is the single surface for bringing Claude Code history into the store —
 * per-session and bulk are the same feature. Discovery spans every candidate
 * Claude projects dir for this repo (the shared `~/.claude/projects` dir AND the
 * per-builder isolation dirs under `<data>/builder-projects/<id>/`), deduped to
 * the best copy of each session — the same multi-root discovery the built-in
 * recovery (`lazy doctor --reimport-conversations`, an alias) uses. Both paths
 * share `discoverCandidateSessions`/`reimportConversations` in
 * `src/import/reimport-conversations.ts`; there is no second parser or scanner.
 *
 * Usage:
 *   lazy import-conversation                  # Bulk import all new sessions (preview + confirm)
 *   lazy import-conversation <session-id>     # Import a specific session
 *   lazy import-conversation --list           # List available sessions to import
 *   lazy import-conversation --all            # Re-import everything (including imported)
 */

import { join } from 'path';
import { requireLazyRoot, requireStorage, parseFlags, type LineRange, sliceLines } from '../helpers';
import { theme } from '../theme';
import { docsFooter } from '../../docs/links';
import { isTTY, promptYesNo } from '../editor';
import { loadConfig } from '../../config/loader';
import {
  parseConversation,
  extractSummary,
  conversationStats,
} from '../../import/claude-code-logs';
import {
  discoverCandidateSessionsPartitioned,
  reimportConversations,
  type CandidateSession,
} from '../../import/reimport-conversations';
import { toStoredConversation } from '../../import/conversation-storage';
import type { Storage } from '../../storage/interface';

export async function commandImportConversation(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'list', aliases: ['l'], takesValue: false },
    { name: 'show-imported', takesValue: false },
    { name: 'show', takesValue: true },
    { name: 'all', aliases: ['a'], takesValue: false },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'import-conversation');

  const lazyRoot = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const listMode = parsed.flags.get('list') === true;
    const showImported = parsed.flags.get('show-imported') === true;
    const showSession = parsed.flags.get('show') as string | undefined;
    const allMode = parsed.flags.get('all') === true;
    const yes = parsed.flags.get('yes') === true;

    const sessionIdArg = parsed.positional[0];

    // Read-only views don't need discovery.
    if (showSession) {
      await showConversationTranscript(storage, showSession);
      return;
    }
    if (showImported) {
      await showImportedConversations(storage);
      return;
    }

    const config = await loadConfig(lazyRoot);
    const dataDirAbs = join(lazyRoot, config.data.path);

    // Discover across every candidate root (shared dir + per-builder isolation
    // dirs), deduped to the best copy of each session. Machine-generated lazy
    // one-shots are split off — they are housekeeping, never importable.
    const { capturable: available, machineOneshots } =
      await discoverCandidateSessionsPartitioned({ lazyRoot, dataDirAbs });

    if (available.length === 0) {
      console.log('No Claude Code sessions found for this project.');
      console.log(`Looked in: ~/.claude/projects/ and per-builder isolation dirs for paths matching ${lazyRoot}`);
      if (machineOneshots.length > 0) {
        console.log(
          `(Ignored ${machineOneshots.length} machine-generated lazy one-shot(s) — ` +
          `fidelity summaries, ${theme.command('lazy report')}, memory compaction.)`,
        );
      }
      return;
    }

    if (listMode) {
      await listAvailableSessions(storage, available);
      return;
    }

    if (sessionIdArg) {
      // Import a specific session. Naming an exact session is explicit intent —
      // import it directly (no confirmation prompt).
      const match = available.find((s) => s.sessionId === sessionIdArg || s.sessionId.startsWith(sessionIdArg));
      if (!match) {
        // Distinguish "no such session" from "deliberately not importable": the
        // JSONL is right there on disk, so a bare "not found" would look like a
        // bug in discovery.
        const oneshot = machineOneshots.find(
          (s) => s.sessionId === sessionIdArg || s.sessionId.startsWith(sessionIdArg),
        );
        if (oneshot) {
          console.error(
            `Session ${oneshot.sessionId} is a machine-generated lazy one-shot ` +
            `(a fidelity summary, ${theme.command('lazy report')} unit, or memory compaction), not a conversation.`,
          );
          console.error('Those are deliberately never imported into the conversation store.');
          process.exit(1);
        }
        console.error(`Session not found: ${sessionIdArg}`);
        console.error(`Run 'lazy import-conversation --list' to see available sessions.`);
        process.exit(1);
      }

      await importSession(storage, match);
      return;
    }

    if (allMode) {
      // `--all` is explicit intent to re-import everything, including sessions
      // already in the store — import directly.
      let imported = 0;
      for (const session of available) {
        await importSession(storage, session);
        imported++;
      }
      console.log(`\nRe-imported ${imported} session(s).`);
      return;
    }

    // Default bulk: preview → confirm → import only what's missing. Shared with
    // `lazy doctor --reimport-conversations` so both surfaces behave identically.
    const { ok } = await runReimportBulk({ lazyRoot, dataDirAbs, storage, yes });
    if (!ok) process.exit(1);
  } finally {
    await storage.close();
  }
}

/**
 * Bulk import orchestration shared by `lazy import-conversation` (no session-id)
 * and `lazy doctor --reimport-conversations`. Previews what would be imported,
 * confirms before writing (unless `yes`), then imports the sessions missing from
 * the store through the given Storage. The caller owns the Storage lifecycle.
 *
 * Never writes silently: without `--yes`, a TTY is prompted and a non-TTY is
 * told to re-run with `--yes` — matching CLAUDE.md's least-surprise rule.
 */
export async function runReimportBulk(opts: {
  lazyRoot: string;
  dataDirAbs: string;
  storage: Storage;
  yes: boolean;
}): Promise<{ ok: boolean }> {
  const { lazyRoot, dataDirAbs, storage, yes } = opts;

  const { capturable: candidates, machineOneshots } =
    await discoverCandidateSessionsPartitioned({ lazyRoot, dataDirAbs });
  // Say what was ignored rather than quietly shrinking the count — a human who
  // knows there are 200 JSONLs on disk should not have to guess where they went.
  const ignoredNote =
    machineOneshots.length > 0
      ? ` (ignored ${machineOneshots.length} machine-generated lazy one-shot(s))`
      : '';

  if (candidates.length === 0) {
    console.log(`No Claude Code sessions found on disk for this project — nothing to import.${ignoredNote}`);
    return { ok: true };
  }

  let toImport = 0;
  for (const c of candidates) {
    if (!(await storage.isConversationImported(c.sessionId))) toImport++;
  }

  console.log(
    `Found ${candidates.length} session(s) on disk; ${toImport} missing from the store, ` +
    `${candidates.length - toImport} already imported.${ignoredNote}`,
  );

  if (toImport === 0) {
    console.log(theme.success('Store is already up to date — nothing to import.'));
    return { ok: true };
  }

  if (!yes) {
    if (!isTTY()) {
      console.log(`Re-run with ${theme.command('--yes')} to import them (non-interactive).`);
      return { ok: true };
    }
    const proceed = await promptYesNo(`Import ${toImport} conversation(s) into the store?`, true);
    if (!proceed) {
      console.log('Aborted — nothing was imported.');
      return { ok: true };
    }
  }

  const report = await reimportConversations({
    lazyRoot,
    dataDirAbs,
    storage,
    onImported: (info) => {
      const shortId = info.sessionId.substring(0, 8);
      const started = info.startedAt ? info.startedAt.replace('T', ' ').substring(0, 16) : 'unknown';
      console.log(
        theme.success(`  Imported ${shortId}`) +
        `  ${started}  ${info.messageCount} msgs, ${info.totalTokens} tokens`,
      );
    },
  });

  console.log('');
  console.log(
    `Import complete: ${report.imported.length} imported, ` +
    `${report.skippedAlready.length} already present, ` +
    `${report.skippedEmpty.length} empty/unparseable skipped.`,
  );
  if (report.skippedEmpty.length > 0) {
    console.log(theme.warning(`  Skipped (no content): ${report.skippedEmpty.map(s => s.substring(0, 8)).join(', ')}`));
  }
  if (report.errors.length > 0) {
    console.log(theme.error(`  ${report.errors.length} session(s) failed to import:`));
    for (const { sessionId, error } of report.errors) {
      console.log(theme.error(`    ${sessionId.substring(0, 8)}: ${error.message}`));
    }
    return { ok: false };
  }

  return { ok: true };
}

async function importSession(storage: Storage, session: CandidateSession): Promise<void> {
  const { projectPath, sessionId, projectsDirRoot } = session;
  try {
    // Parse from the root the session actually lives in — a session that only
    // exists in an isolation dir would be invisible to the shared-dir default.
    const conversation = await parseConversation(projectPath, sessionId, projectsDirRoot);
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
  available: CandidateSession[],
): Promise<void> {
  console.log(`Found ${available.length} Claude Code session(s):\n`);

  for (const session of available) {
    const alreadyImported = await storage.isConversationImported(session.sessionId);
    const shortId = session.sessionId.substring(0, 8);
    const status = alreadyImported ? '[imported]' : '[new]     ';

    try {
      const conversation = await parseConversation(session.projectPath, session.sessionId, session.projectsDirRoot);
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
happened during development. Adopting lazy on a repo that already has Claude
Code history means inheriting that history as builder memory.

Discovery spans every Claude projects dir for this repo: the shared
~/.claude/projects dir AND the per-builder isolation dirs (so a session that
only lives in an isolation dir is still importable). When the same session
appears in several dirs, the most complete copy is used.

Builder sessions are captured automatically when 'lazy builder' exits; this
command imports history that predates lazy or that recovery left behind.

Arguments:
  [session-id]     Import a specific session (can be shortened)

Options:
  --list, -l            List available sessions to import
  --all, -a             Re-import all sessions (including already imported)
  --yes, -y             Skip the confirmation prompt on bulk import
  --show-imported       Show already imported conversations (table)
  --show <session-id>   Show full interleaved conversation transcript

Bulk import:
  Without arguments, discovers all Claude Code sessions for this project
  (including worktree and isolation-dir sessions), previews what would be
  imported, and asks for confirmation before importing any that are new.
  This is the same recovery flow as 'lazy doctor --reimport-conversations'.

Examples:
  lazy import-conversation              # Preview + import all new sessions
  lazy import-conversation --yes        # Import all new sessions, no prompt
  lazy import-conversation --list       # List available sessions
  lazy import-conversation bc77e1b1     # Import specific session
  lazy import-conversation --all        # Re-import everything
  lazy import-conversation --show-imported        # Show imported list
  lazy import-conversation --show bc77e1b1        # Show full conversation${docsFooter('conversation-import')}`);
}
