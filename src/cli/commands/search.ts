import { requireStorage, parseFlags } from '../helpers';
import { shortId } from '../../task/identity';
import type { SearchResult } from '../../storage';
import type { Storage } from '../../storage/interface';
import { theme, stripAnsi } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import {
  QueryParseError,
  GRAMMAR_EXAMPLES,
  renderGrammarText,
  renderGrammarNotesText,
} from '../../search';
import { buildTaskShowLines } from './show';
import { loadTaskShowData } from '../../task/show-data';
import { querySearch } from '../../daemon/rpc-fallback';
import { RpcApplicationError } from '../../daemon/client';
import { RpcError } from '../../daemon/rpc-error';

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

function resultDisplayId(result: SearchResult): string {
  // Memory records are keyed by their name, not by an id — truncating it to 8
  // chars ("tasks-no") would hide which record matched.
  if (result.entity_type === 'memory') return result.entity_id;
  return result.task_code ?? shortId(result.task_id);
}

/**
 * Label a hit with its locator, where the hit has one.
 *
 * A turn hit that reads only "turn" leaves the reader scanning `lazy show`
 * output for the excerpt. The sequence is exactly what show prints
 * (`--- Turn #12 ---`), so naming it turns a hit into a jump.
 */
function entityLabel(result: SearchResult): string {
  if (result.entity_type === 'turn' && result.turn_sequence !== undefined) {
    return `turn #${result.turn_sequence}`;
  }
  return result.entity_type;
}

function printResults(results: SearchResult[], groupByTask: boolean, hint?: string): void {
  if (results.length === 0) {
    console.log('No matches found.');
    if (hint) {
      console.log('');
      console.log(hint);
    }
    return;
  }

  console.log(`Found ${theme.count(String(results.length))} match${results.length === 1 ? '' : 'es'}:\n`);

  if (groupByTask) {
    // Group results by task
    const byTask = new Map<string, SearchResult[]>();
    for (const result of results) {
      const existing = byTask.get(result.task_id) || [];
      existing.push(result);
      byTask.set(result.task_id, existing);
    }

    byTask.forEach((taskResults) => {
      const firstResult = taskResults[0];
      console.log(`${theme.taskId(resultDisplayId(firstResult))} - ${truncate(firstResult.task_goal, 60)}`);

      for (const result of taskResults) {
        const typeLabel = entityLabel(result).padEnd(9);
        console.log(`  ${typeLabel}: ${truncate(result.match_context, 70)}`);
      }
      console.log('');
    });
  } else {
    // Flat list
    console.log(`${theme.header('TASK'.padEnd(20))} ${theme.header('TYPE'.padEnd(9))} ${theme.header('MATCH')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(9)} ${'─'.repeat(60)}`));

    for (const result of results) {
      console.log(
        `${theme.pad(theme.taskId(resultDisplayId(result)), 20)} ${entityLabel(result).padEnd(9)} ${truncate(result.match_context, 60)}`
      );
    }
  }
}

/**
 * Find the 1-indexed line number where content appears in show output text.
 * Searches ANSI-stripped output lines for the content string.
 * Returns the line number of the first match, or null if not found.
 */
function findLineInShowOutput(showLines: string[], content: string): number | null {
  // Clean and prepare the search content (first 60 chars, collapsed whitespace)
  const searchContent = content.replace(/\s+/g, ' ').trim().substring(0, 60).toLowerCase();
  if (!searchContent) return null;

  for (let i = 0; i < showLines.length; i++) {
    const line = stripAnsi(showLines[i]).replace(/\s+/g, ' ').toLowerCase();
    if (line.includes(searchContent)) {
      return i + 1; // 1-indexed
    }
  }

  // Fallback: try matching just the first 30 chars
  const shortContent = searchContent.substring(0, 30);
  if (shortContent.length > 5) {
    for (let i = 0; i < showLines.length; i++) {
      const line = stripAnsi(showLines[i]).replace(/\s+/g, ' ').toLowerCase();
      if (line.includes(shortContent)) {
        return i + 1;
      }
    }
  }

  return null;
}

/**
 * Build context metadata for a search result based on entity type.
 */
function buildMatchContext(result: SearchResult, showLines: string[], lineNum: number | null): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // The entity's 0-based position in that task's list of its kind — the locator
  // that makes a hit addressable without re-scanning the section by hand. For
  // turns, commits and comments that is the list `show` pages over; follow-ups
  // are always rendered whole, so there it is a position to read off, not to
  // page to.
  if (result.entity_index !== undefined) {
    ctx.index = result.entity_index;
  }

  if (result.entity_type === 'turn') {
    // Prefer the sequence the search layer carries: it comes from the stored
    // turn. The line scrape below is the fallback for a result produced before
    // that field existed (or by a backend that cannot supply it) — it can only
    // ever read back what show already rendered.
    if (result.turn_sequence !== undefined) {
      ctx.turn_seq = result.turn_sequence;
    }
    if (lineNum !== null) {
      const line = stripAnsi(showLines[lineNum - 1] || '');
      const turnMatch = line.match(/#(\d+)\s+\[(\w+)\]/);
      if (turnMatch) {
        if (ctx.turn_seq === undefined) ctx.turn_seq = parseInt(turnMatch[1], 10);
        ctx.role = turnMatch[2];
      }
    }
  }

  // Extract commit SHA from the show output if this is a commit match
  if (result.entity_type === 'commit' && lineNum !== null) {
    const line = stripAnsi(showLines[lineNum - 1] || '');
    const shaMatch = line.match(/^    ([0-9a-f]{8})\s/);
    if (shaMatch) {
      ctx.sha = shaMatch[1];
    }
  }

  return ctx;
}

/**
 * Output search results as JSON with line numbers.
 * For each matched task, builds the show output text and finds
 * where matched content appears to compute accurate line numbers.
 */
async function printJsonResults(storage: Storage, results: SearchResult[], query: string, hint?: string): Promise<void> {
  // Build show output for each unique task (for line number computation)
  const showOutputCache = new Map<string, string[]>();

  // Collect unique task IDs (excluding conversations which use session IDs)
  const taskIds = new Set<string>();
  for (const r of results) {
    if (r.entity_type !== 'conversation' && r.entity_type !== 'memory') {
      taskIds.add(r.task_id);
    }
  }

  // Build show output for each task
  for (const taskId of taskIds) {
    try {
      const result = await storage.resolveTask(taskId);
      if (result.task) {
        const data = await loadTaskShowData(storage, result.task);
        const lines = buildTaskShowLines(data, false);
        // Split multiline entries into individual lines (show output joins with \n then splits for --lines)
        const flatLines = lines.join('\n').split('\n');
        showOutputCache.set(taskId, flatLines);
      }
    } catch {
      // Skip tasks that can't be loaded
    }
  }

  // Build JSON matches
  const matches = results.map(r => {
    const showLines = showOutputCache.get(r.task_id) || [];
    const lineNum = findLineInShowOutput(showLines, r.content);
    const context = buildMatchContext(r, showLines, lineNum);

    return {
      task_id: r.task_id,
      task_code: r.task_code,
      match_type: r.entity_type,
      line: lineNum,
      content: truncate(r.match_context, 200),
      context: Object.keys(context).length > 0 ? context : undefined,
    };
  });

  console.log(JSON.stringify({ query, matches, ...(hint ? { hint } : {}) }));
}

/**
 * Print a bad query legibly, then exit.
 *
 * The same rejection arrives three ways: as a QueryParseError when the search
 * ran in-process with no daemon at all, as an RpcError when the in-process
 * handler mapped it, and as an RpcApplicationError wrapped in `RPC search
 * failed: 400 ` when a daemon ran it. All three are the human's query —
 * `code:spike` after the rename is the common one — so all three must print the
 * actionable sentence rather than a stack trace, and the SAME sentence. The
 * daemon handler supplies the `Query parse error:` prefix, so unwrapping is all
 * that is left here. Returns for anything else, so the caller can rethrow.
 */
function reportQueryError(err: unknown): void {
  if (err instanceof QueryParseError) {
    console.error(`Query parse error: ${err.message}`);
    process.exit(1);
  }
  if ((err instanceof RpcError || err instanceof RpcApplicationError) && err.status === 400) {
    // Strip the daemon client's `RPC search failed: 400 ` wrapper — the human
    // typed a query, not an RPC.
    const match = err.message.match(/^RPC \w+ failed: \d{3}\s+([\s\S]+)$/);
    console.error((match ? match[1] : err.message).trim());
    process.exit(1);
  }
}

export async function commandSearch(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'fuzzy', aliases: ['f'], takesValue: false },
    { name: 'group', aliases: ['g'], takesValue: false },
    { name: 'json', takesValue: false },
    { name: 'tasks', takesValue: false },
    { name: 'prompts', takesValue: false },
    { name: 'turns', takesValue: false },
    { name: 'commits', takesValue: false },
    { name: 'notes', takesValue: false },
    { name: 'followups', takesValue: false },
    { name: 'raised', takesValue: false },
    { name: 'conversations', takesValue: false },
    { name: 'memories', takesValue: false },
    { name: 'scratch', takesValue: false },
  ], 'search');

  // Parse options
  const fuzzy = parsed.flags.get('fuzzy') === true;
  const groupByTask = parsed.flags.get('group') === true;
  const jsonOutput = parsed.flags.get('json') === true;

  // Filter options for specific types
  const searchTasks = parsed.flags.get('tasks') === true;
  const searchPrompts = parsed.flags.get('prompts') === true;
  const searchTurns = parsed.flags.get('turns') === true;
  const searchCommits = parsed.flags.get('commits') === true;
  const searchNotes = parsed.flags.get('notes') === true;
  const searchFollowUps = parsed.flags.get('followups') === true;
  const searchRaised = parsed.flags.get('raised') === true;
  const searchConversations = parsed.flags.get('conversations') === true;
  const searchMemories = parsed.flags.get('memories') === true;
  const searchScratch = parsed.flags.get('scratch') === true;

  // If no specific types, search all
  const searchAll = !searchTasks && !searchPrompts && !searchTurns && !searchCommits && !searchNotes && !searchFollowUps && !searchRaised && !searchConversations && !searchMemories && !searchScratch;

  // Get query (remaining positional args)
  const query = parsed.positional.join(' ');

  if (!query) {
    console.error('Error: search query required');
    console.error('Usage: lazy search <query> [--fuzzy] [--group]');
    process.exit(1);
  }

  // Build type filter list
  const types: string[] = [];
  if (!searchAll) {
    if (searchTasks) types.push('task');
    if (searchPrompts) types.push('prompt');
    if (searchTurns) types.push('turn');
    if (searchCommits) types.push('commit');
    if (searchNotes) types.push('comment');
    if (searchFollowUps) types.push('followup');
    if (searchRaised) types.push('raised');
    if (searchConversations) types.push('conversation');
    if (searchMemories) types.push('memory');
    if (searchScratch) types.push('scratch');
  }

  // For --json output, we need local show output computation for line numbers,
  // so we always go direct (querySearch still handles daemon-vs-direct internally
  // for the search itself, but we need storage open for the JSON rendering).
  if (jsonOutput) {
    const storage = await requireStorage();
    try {
      const { results, hint } = await querySearch({ query, fuzzy, types: types.length > 0 ? types : undefined });
      await printJsonResults(storage, results, query, hint);
    } catch (err) {
      reportQueryError(err);
      throw err;
    } finally {
      await storage.close();
    }
    return;
  }

  try {
    const { results, hint } = await querySearch({ query, fuzzy, types: types.length > 0 ? types : undefined });
    printResults(results, groupByTask, hint);
  } catch (err) {
    reportQueryError(err);
    throw err;
  }
}

export function searchUsage(): void {
  console.log(`Usage: lazy search <query> [options]

Search across tasks, prompts, turns, commits, notes, follow-ups, conversations,
and shared memory records.

Options:
  -f, --fuzzy        Use fuzzy matching (typo-tolerant)
  -g, --group        Group results by task
  --json             Output as structured JSON with line numbers

Filter by type:
  --tasks            Search task goals only
  --prompts          Search task prompts only
  --turns            Search conversation turns only
  --commits          Search commit messages only
  --notes            Search task notes only
  --followups        Search task follow-ups only
  --raised           Search agent-raised questions/decisions only
  --conversations    Search captured builder conversations only
  --memories         Search shared memory records only
  --scratch          Search captured builder scratch files only

Query language:
  Supports Lucene-style syntax with boolean operators and field filters.
  When operators, field syntax, or a #tag are detected, structured search is
  used automatically. Plain text queries use regex (case-insensitive) matching.
  The dashboard's search page shows this same grammar inline.

${renderGrammarText('  ')}

Good to know:
${renderGrammarNotesText('  ')}

Examples:
${GRAMMAR_EXAMPLES.map(ex => `  lazy search '${ex.query}'`.padEnd(58) + `# ${ex.summary}`).join('\n')}
  lazy search 'catchup' --fuzzy                           # Typo-tolerant
  lazy search 'design decision' --conversations           # Filter to conversations only
  lazy search 'auth' --json                               # JSON output with line numbers${docsFooter('search')}`);
}
