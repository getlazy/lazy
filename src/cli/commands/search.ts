import { requireStorage, shortId, parseFlags } from '../helpers';
import type { SearchResult } from '../../storage';
import type { Storage } from '../../storage/interface';
import { theme, stripAnsi } from '../theme';
import { QueryParseError } from '../../search';
import { loadTaskShowData, buildTaskShowLines } from './show';
import { querySearch } from '../../daemon/rpc-fallback';

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

function resultDisplayId(result: SearchResult): string {
  return result.task_code ?? shortId(result.task_id);
}

function printResults(results: SearchResult[], groupByTask: boolean): void {
  if (results.length === 0) {
    console.log('No matches found.');
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
        const typeLabel = result.entity_type.padEnd(6);
        console.log(`  ${typeLabel}: ${truncate(result.match_context, 70)}`);
      }
      console.log('');
    });
  } else {
    // Flat list
    console.log(`${theme.header('TASK'.padEnd(20))} ${theme.header('TYPE'.padEnd(8))} ${theme.header('MATCH')}`);
    console.log(theme.separator(`${'─'.repeat(20)} ${'─'.repeat(8)} ${'─'.repeat(60)}`));

    for (const result of results) {
      console.log(
        `${theme.pad(theme.taskId(resultDisplayId(result)), 20)} ${result.entity_type.padEnd(8)} ${truncate(result.match_context, 60)}`
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

  // Extract turn sequence from the show output if this is a turn match
  if (result.entity_type === 'turn' && lineNum !== null) {
    const line = stripAnsi(showLines[lineNum - 1] || '');
    const turnMatch = line.match(/#(\d+)\s+\[(\w+)\]/);
    if (turnMatch) {
      ctx.turn_seq = parseInt(turnMatch[1], 10);
      ctx.role = turnMatch[2];
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
async function printJsonResults(storage: Storage, results: SearchResult[], query: string): Promise<void> {
  // Build show output for each unique task (for line number computation)
  const showOutputCache = new Map<string, string[]>();

  // Collect unique task IDs (excluding conversations which use session IDs)
  const taskIds = new Set<string>();
  for (const r of results) {
    if (r.entity_type !== 'conversation') {
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

  console.log(JSON.stringify({ query, matches }));
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
    { name: 'conversations', takesValue: false },
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
  const searchConversations = parsed.flags.get('conversations') === true;

  // If no specific types, search all
  const searchAll = !searchTasks && !searchPrompts && !searchTurns && !searchCommits && !searchNotes && !searchConversations;

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
    if (searchConversations) types.push('conversation');
  }

  // For --json output, we need local show output computation for line numbers,
  // so we always go direct (querySearch still handles daemon-vs-direct internally
  // for the search itself, but we need storage open for the JSON rendering).
  if (jsonOutput) {
    const storage = await requireStorage();
    try {
      const { results } = await querySearch({ query, fuzzy, types: types.length > 0 ? types : undefined });
      await printJsonResults(storage, results, query);
    } catch (err) {
      if (err instanceof QueryParseError) {
        console.error(`Query parse error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    } finally {
      await storage.close();
    }
    return;
  }

  try {
    const { results } = await querySearch({ query, fuzzy, types: types.length > 0 ? types : undefined });
    printResults(results, groupByTask);
  } catch (err) {
    if (err instanceof QueryParseError) {
      console.error(`Query parse error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export function searchUsage(): void {
  console.log(`Usage: lazy search <query> [options]

Search across tasks, prompts, turns, commits, notes, and conversations.

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
  --conversations    Search captured builder conversations only

Query language:
  Supports Lucene-style syntax with boolean operators and field filters.
  When operators or field syntax are detected, structured search is used
  automatically. Plain text queries use regex (case-insensitive) matching.

  Boolean operators:
    AND                Both conditions must match
    OR                 Either condition matches
    NOT                Negation
    (A OR B) AND C     Parentheses for grouping

  Field operators:
    status:<value>     Task status (working, blocked, interrupted, etc.)
    goal:<text>        Match against task goal
    code:<value>       Match task code
    in:turns <text>    Search within turn content
    in:commits <text>  Search within commit messages
    in:comments <text> Search within comments
    in:conversations <text>  Search within conversation messages
    has:commits        Task has commits
    has:turns          Task has turns
    has:comments       Task has comments
    created:>YYYY-MM-DD / created:<YYYY-MM-DD   Date filter on creation
    updated:>YYYY-MM-DD / updated:<YYYY-MM-DD   Date filter on last update

Examples:
  lazy search "auth"                                       # Regex search everywhere
  lazy search catchup --fuzzy                              # Fuzzy search
  lazy search 'status:blocked AND in:turns "reconciler"'   # Structured query
  lazy search 'in:conversations "design decision"'         # Search conversations
  lazy search 'status:rejected OR status:closed'           # Boolean OR
  lazy search 'has:commits AND NOT in:commits "wip"'       # Negation
  lazy search 'created:>2026-02-15 AND status:working'     # Date filter
  lazy search "design decision" --conversations            # Filter to conversations only
  lazy search "auth" --json                                  # JSON output with line numbers`);
}
