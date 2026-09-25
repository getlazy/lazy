/**
 * `lazy raised` — the cross-task raised-items queue, and the triage verbs on it.
 *
 * Raised items are what an agent surfaces to a human. A BLOCKING item is a
 * question or decision about the task's own scope or diff and gates `lazy
 * accept`; a NON-BLOCKING item is an orthogonal proposal or an FYI and never
 * gates. They are one entity with one flag (docs/design/raised-items-unified.md),
 * so they are one command with one vocabulary:
 *
 *   respond / acknowledge / dismiss / promote   — the resolutions
 *   blocking <true|false>                       — correct the agent's flag
 *
 * `lazy followups` and `lazy followup` are aliases for one release and print a
 * deprecation line to stderr, so scripts and muscle memory keep working while
 * the new name settles.
 *
 * Routes through Storage (RemoteStorage → daemon) — the CLI is a client.
 */

import { requireActorIdentity } from '../identity-preflight';
import { requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { shortId, displayId, validateCode } from '../../task/identity';
import { theme, bold } from '../../render/theme';
import { docsFooter } from '../../docs/links';
import { getActor } from '../../constants';
import { raisedGateVocabulary } from '../../raised/vocabulary';
import { attributionLabel } from '../../actor-ref';
import type {
  RaisedItemListSort,
  RaisedItemTaskStatusFilter,
  RaisedItemBlockingFilter,
} from '../../raised';

const TASK_STATUS_FILTERS: RaisedItemTaskStatusFilter[] = [
  'terminal',
  'non-terminal',
  'complete-only',
  'complete',
  'abandoned',
  'working',
  'blocked',
  'backlog',
  'interrupted',
  'merging',
  'submitted',
  'conflict',
  'pairing',
  'zombie',
];

function parseTaskStatusFilter(value: string): RaisedItemTaskStatusFilter {
  const normalized = value.toLowerCase();
  if (TASK_STATUS_FILTERS.includes(normalized as RaisedItemTaskStatusFilter)) {
    return normalized as RaisedItemTaskStatusFilter;
  }
  console.error(
    `Unknown task status filter '${value}'. ` +
    `Try: ${TASK_STATUS_FILTERS.join(', ')}`,
  );
  process.exit(1);
}

/**
 * Dispatch. A leading flag (or nothing at all) means the listing; anything else
 * is read as a subcommand, so `lazy raised --all` and `lazy raised dismiss …`
 * both do what they look like.
 */
export async function commandRaised(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand.startsWith('-')) {
    await commandRaisedList(args);
    return;
  }

  const subArgs = args.slice(1);
  // Every subcommand but the listing records a human decision on an item, so
  // the identity check happens here, once, before any of them collects text.
  // Listing is a read and stays available while the identity is unconfigured.
  if (subcommand !== 'list') await requireActorIdentity();
  switch (subcommand) {
    case 'list':
      await commandRaisedList(subArgs);
      break;
    case 'respond':
      await commandRaisedResolve(subArgs, 'respond');
      break;
    case 'acknowledge':
    case 'ack':
      await commandRaisedResolve(subArgs, 'acknowledge');
      break;
    case 'dismiss':
      await commandRaisedResolve(subArgs, 'dismiss');
      break;
    case 'promote':
      await commandRaisedPromote(subArgs);
      break;
    case 'blocking':
      await commandRaisedBlocking(subArgs);
      break;
    default:
      console.error(`Unknown raised subcommand: ${subcommand}`);
      raisedUsage();
      process.exit(1);
  }
}

export const raisedSubcommandUsage: Record<string, () => void> = {
  'list': raisedUsage,
  'respond': raisedUsage,
  'acknowledge': raisedUsage,
  'ack': raisedUsage,
  'dismiss': raisedUsage,
  'promote': raisedUsage,
  'blocking': raisedUsage,
};


// --- listing ---------------------------------------------------------------

/**
 * The GATE column's words, from the shared vocabulary the web badges render
 * (src/raised/vocabulary.ts). The column used to say `gate` / `—`, a third
 * spelling of a flag that already had two — and one flag reading differently
 * depending on which surface you are looking at is the confusion this whole
 * change is about.
 *
 * The LABEL, deliberately, not the emoji `marker`: these land in `padEnd`-ed,
 * width-computed columns, and an emoji is two terminal cells in some emulators
 * and zero in others, which silently misaligns every row after it. That is why
 * PROTECTED_MARKER in src/protection/status.ts is ASCII too. The `--blocking` /
 * `--non-blocking` FLAGS are unchanged: a flag name is a contract, the column
 * is display.
 */
const GATE_BLOCKING = raisedGateVocabulary(true).label;
const GATE_FYI = raisedGateVocabulary(false).label;
const GATE_WIDTH = Math.max(GATE_BLOCKING.length, GATE_FYI.length, 'GATE'.length);

function gateLabel(blocking: boolean): string {
  return blocking ? GATE_BLOCKING : GATE_FYI;
}

async function commandRaisedList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'status', aliases: ['s'], takesValue: true },
    { name: 'query', aliases: ['q'], takesValue: true },
    { name: 'min-age', takesValue: true },
    { name: 'min-recurrence', takesValue: true },
    { name: 'sort', takesValue: true },
    { name: 'order', takesValue: true },
    { name: 'limit', takesValue: true },
    { name: 'offset', takesValue: true },
    { name: 'recurring-only', aliases: ['r'], takesValue: false },
    { name: 'all', takesValue: false },
    { name: 'blocking', aliases: ['b'], takesValue: false },
    { name: 'non-blocking', takesValue: false },
  ], 'raised');

  const showAll = parsed.flags.get('all') === true;
  const recurringOnly = parsed.flags.get('recurring-only') === true;
  const onlyBlocking = parsed.flags.get('blocking') === true;
  const onlyNonBlocking = parsed.flags.get('non-blocking') === true;
  if (onlyBlocking && onlyNonBlocking) {
    console.error('--blocking and --non-blocking are opposites; pass at most one.');
    process.exit(1);
  }
  const blocking: RaisedItemBlockingFilter =
    onlyBlocking ? 'blocking' : onlyNonBlocking ? 'non-blocking' : 'all';

  const statusRaw = parsed.flags.get('status') as string | undefined;
  const query = parsed.flags.get('query') as string | undefined;
  const minAgeRaw = parsed.flags.get('min-age') as string | undefined;
  const minRecurrenceRaw = parsed.flags.get('min-recurrence') as string | undefined;
  const sortRaw = parsed.flags.get('sort') as string | undefined;
  const orderRaw = parsed.flags.get('order') as string | undefined;
  const limitRaw = parsed.flags.get('limit') as string | undefined;
  const offsetRaw = parsed.flags.get('offset') as string | undefined;

  const sortValues: RaisedItemListSort[] = ['age', 'recurrence', 'task'];
  const sort = sortRaw && sortValues.includes(sortRaw as RaisedItemListSort)
    ? (sortRaw as RaisedItemListSort)
    : recurringOnly ? 'recurrence' : 'age';
  if (sortRaw && !sortValues.includes(sortRaw as RaisedItemListSort)) {
    console.error(`Unknown sort '${sortRaw}'. Try: ${sortValues.join(', ')}`);
    process.exit(1);
  }

  const order = orderRaw === 'asc' || orderRaw === 'desc' ? orderRaw : 'desc';
  if (orderRaw && orderRaw !== 'asc' && orderRaw !== 'desc') {
    console.error(`Unknown order '${orderRaw}'. Try: asc, desc`);
    process.exit(1);
  }

  const minAgeDays = minAgeRaw ? Number(minAgeRaw) : undefined;
  if (minAgeRaw && Number.isNaN(minAgeDays)) {
    console.error(`Invalid --min-age '${minAgeRaw}'`);
    process.exit(1);
  }

  const minRecurrenceSize = minRecurrenceRaw
    ? Number(minRecurrenceRaw)
    : recurringOnly ? 2 : undefined;
  if (minRecurrenceRaw && Number.isNaN(minRecurrenceSize)) {
    console.error(`Invalid --min-recurrence '${minRecurrenceRaw}'`);
    process.exit(1);
  }

  const limit = limitRaw ? Number(limitRaw) : undefined;
  const offset = offsetRaw ? Number(offsetRaw) : undefined;
  if (limitRaw && Number.isNaN(limit!)) {
    console.error(`Invalid --limit '${limitRaw}'`);
    process.exit(1);
  }
  if (offsetRaw && Number.isNaN(offset!)) {
    console.error(`Invalid --offset '${offsetRaw}'`);
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const result = await storage.listRaisedItems({
      taskStatus: statusRaw ? parseTaskStatusFilter(statusRaw) : undefined,
      query,
      minAgeDays,
      minRecurrenceSize,
      sort,
      order,
      limit,
      offset,
      state: showAll ? 'all' : 'open',
      blocking,
      collapseExactDuplicates: true,
    });

    if (result.total === 0) {
      console.log('No raised items match.');
      return;
    }

    if (recurringOnly || (result.recurrences.some((c) => c.size > 1) && sort === 'recurrence')) {
      const recurring = result.recurrences.filter((c) => c.size > 1);
      if (recurring.length > 0) {
        console.log(`${theme.header('Recurring items')} (${recurring.length}):\n`);
        for (const recurrence of recurring) {
          const preview = recurrence.sample_content.replace(/\s+/g, ' ').trim().slice(0, 72);
          console.log(
            `  ${bold(String(recurrence.size).padStart(2))}×  ${preview}${preview.length >= 72 ? '…' : ''}`,
          );
          console.log(
            `      tasks: ${recurrence.task_ids.map((id) => shortId(id)).join(', ')}`,
          );
        }
        console.log('');
      }
    }

    if (!recurringOnly) {
      // The two open counts lead, because "how much is standing between me and
      // a merge" is a different question from "how much is proposed".
      console.log(
        `${result.total} raised item(s) — ` +
        `${result.total_open_blocking} open ${GATE_BLOCKING}, ` +
        `${result.total_open_non_blocking} open ${GATE_FYI}:\n`,
      );
      console.log(
        `${theme.header('ID'.padEnd(9))} ${theme.header('GATE'.padEnd(GATE_WIDTH))} ${theme.header('AGE'.padEnd(5))} ${theme.header('REC'.padEnd(4))} ${theme.header('TASK'.padEnd(22))} ${theme.header('STATUS'.padEnd(10))} ${theme.header('ITEM')}`,
      );
      for (const item of result.items) {
        const taskLabel = item.task_code ?? shortId(item.task_id);
        const promoted = item.promoted_task_code
          ? ` → ${item.promoted_task_code}`
          : item.possibly_promoted ? ' [promoted?]' : '';
        // WHICH PERSON decided, when the store knew one — the role is passed
        // as null on purpose: every decision in a single-user install was made
        // by `human`, and a column repeating that word says nothing. `lazy
        // show` spells the role out; this listing exists to tell rows apart.
        const decidedByPerson = attributionLabel(null, item.resolved_by_email, item.resolved_by_name);
        const decidedBy = decidedByPerson ? ` ${theme.label(`[by ${decidedByPerson}]`)}` : '';
        const line = (item.title ?? item.content).replace(/\s+/g, ' ').trim();
        const preview = line.length > 60 ? `${line.slice(0, 60)}…` : line;
        console.log(
          `${shortId(item.id).padEnd(9)} ${gateLabel(item.blocking).padEnd(GATE_WIDTH)} ` +
          `${String(item.age_days).padEnd(5)} ${String(item.recurrence_size).padEnd(4)} ` +
          `${taskLabel.padEnd(22)} ${item.task_status.padEnd(10)} ${preview}${promoted}${decidedBy}`,
        );
      }
      console.log(`\nDrill into a task with: ${theme.command('lazy show <task>')}`);
    }
  } finally {
    await storage.close();
  }
}

// --- resolutions -----------------------------------------------------------

function requireItemRef(
  parsed: ReturnType<typeof parseFlags>,
  usage: string,
): { taskRef: string; itemId: string } {
  const taskRef = parsed.positional[0];
  const itemId = parsed.positional[1];
  if (!taskRef || !itemId) {
    console.error(usage);
    process.exit(1);
  }
  if (!/^[0-9a-fA-F-]+$/.test(itemId!)) {
    console.error(
      `Invalid raised-item id '${itemId}' — ids are hex UUIDs (or a unique prefix).`,
    );
    console.error(`List them with: ${theme.command(`lazy show ${taskRef}`)}`);
    process.exit(1);
  }
  return { taskRef: taskRef!, itemId: itemId! };
}

async function commandRaisedResolve(
  args: string[],
  action: 'respond' | 'acknowledge' | 'dismiss',
): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'note', takesValue: true },
    { name: 'reason', aliases: ['r'], takesValue: true },
    { name: 'message', aliases: ['m'], takesValue: true },
  ], 'raised');

  const { taskRef, itemId } = requireItemRef(
    parsed,
    `Usage: lazy raised ${action} <task> <id> [--message "..."]`,
  );

  const flagText =
    (parsed.flags.get('message') as string | undefined)
    ?? (parsed.flags.get('reason') as string | undefined)
    ?? (parsed.flags.get('note') as string | undefined);
  // Everything after the id reads as the text, so `lazy raised respond t i ship
  // option 2` works without quoting gymnastics.
  const positionalText = parsed.positional.slice(2).join(' ').trim();
  const response = (flagText ?? positionalText)?.trim() || null;

  if (action === 'respond' && !response) {
    console.error('A response needs text: lazy raised respond <task> <id> "your answer"');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const updated = await storage.resolveRaisedItem(task.id, itemId, {
      action,
      actor: getActor(),
      response,
    });

    const verb =
      action === 'respond' ? 'Responded to' : action === 'acknowledge' ? 'Acknowledged' : 'Dismissed';
    console.log(
      theme.success(`${verb} raised item ${updated.id.slice(0, 8)} on ${displayId(task)}.`),
    );
    if (updated.resolution) {
      console.log(`  ${theme.label('Recorded:')} ${updated.resolution}`);
    }
    console.log(
      `  ${theme.label('Delivery:')} rides the next ${theme.command('lazy unblock')} (or accept).`,
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    await storage.close();
  }
}

async function commandRaisedPromote(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'goal', aliases: ['g'], takesValue: true },
    { name: 'prompt', aliases: ['p'], takesValue: true },
    { name: 'code', aliases: ['c'], takesValue: true },
    { name: 'parent', takesValue: true },
    { name: 'subtask', takesValue: false },
    { name: 'peer', takesValue: false },
  ], 'raised');

  const { taskRef, itemId } = requireItemRef(
    parsed,
    'Usage: lazy raised promote <task> <id> [--subtask|--peer] [--goal "..."] [--code <code>] [--parent <task>]',
  );

  const asSubtask = parsed.flags.get('subtask') === true;
  const asPeer = parsed.flags.get('peer') === true;
  if (asSubtask && asPeer) {
    console.error('--subtask and --peer are opposites; pass at most one.');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const code = parsed.flags.get('code') as string | undefined;
    if (code) {
      const codeError = validateCode(code);
      if (codeError) {
        console.error(`Invalid code '${code}': ${codeError}`);
        process.exit(1);
      }
    }
    const result = await storage.promoteRaisedItem(task.id, itemId, {
      goal: parsed.flags.get('goal') as string | undefined,
      prompt: parsed.flags.get('prompt') as string | undefined,
      code,
      parent: parsed.flags.get('parent') as string | undefined,
      // Peer stays the default: it is what promoting a follow-up has always
      // done, and it is what an orthogonal proposal usually wants.
      relation: asSubtask ? 'subtask' : 'peer',
      actor: getActor(),
    });

    console.log(theme.success(`Created task ${displayId(result.task)}`));
    console.log(`  ${theme.label('Goal:')} ${result.task.goal}`);
    console.log(
      `  ${theme.label('Raised item:')} ${result.raised_item.id.slice(0, 8)} marked promoted`,
    );
    console.log(`  ${theme.label('Start it with:')} ${theme.command(`lazy start ${displayId(result.task)}`)}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    await storage.close();
  }
}

async function commandRaisedBlocking(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'raised');
  const { taskRef, itemId } = requireItemRef(
    parsed,
    'Usage: lazy raised blocking <task> <id> <true|false>',
  );

  const valueRaw = (parsed.positional[2] ?? '').toLowerCase();
  const TRUE = ['true', 'yes', 'on', '1'];
  const FALSE = ['false', 'no', 'off', '0'];
  if (!TRUE.includes(valueRaw) && !FALSE.includes(valueRaw)) {
    console.error(
      'Say which way: lazy raised blocking <task> <id> <true|false>\n' +
      '  true  — gates accept (a decision about this task\'s own scope or diff)\n' +
      '  false — never gates (orthogonal proposal, FYI)',
    );
    process.exit(1);
  }
  const blocking = TRUE.includes(valueRaw);

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskRef);
    const updated = await storage.setRaisedItemBlocking(task.id, itemId, blocking, getActor());
    console.log(
      theme.success(
        `Raised item ${updated.id.slice(0, 8)} on ${displayId(task)} ` +
        `${blocking ? 'now GATES accept' : 'no longer gates accept'}.`,
      ),
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    await storage.close();
  }
}

export function raisedUsage(): void {
  console.log(`Usage: lazy raised [subcommand] [options]

Everything agents raised for a human, across every task — one queue, one flag.

A BLOCKING item is a question or decision about its task's own scope or diff:
it gates ${'`'}lazy accept${'`'} until it is responded to, promoted, dismissed, or acknowledged. A
NON-BLOCKING item is an orthogonal proposal or an FYI and never gates. The flag
is the agent's opening judgement, not the last word — correct it with
${'`'}lazy raised blocking${'`'}.

Subcommands:
  list                    Cross-task queue with filters and recurrences
                          (the default — a bare ${'`'}lazy raised${'`'} lists)
  respond <task> <id> <text>
                          Answer the agent; rides the next unblock
  acknowledge <task> <id> [--note "..."]
                          Noted, maybe later (ack is an alias)
  dismiss <task> <id> [--reason "..."]
                          Won't pursue
  promote <task> <id> [--subtask|--peer] [--goal "..."] [--code <code>]
                          Create a backlog task from it (never auto-starts)
  blocking <task> <id> <true|false>
                          Change whether it gates accept

List options:
  -b, --blocking          Only items that gate accept
      --non-blocking      Only items that never gate
  -s, --status <filter>   Originating task status: terminal, non-terminal,
                          complete-only, or a specific status (working, blocked…)
  -q, --query <text>      Case-insensitive substring on the item body
      --min-age <days>    Only items at least N days old
      --min-recurrence <n>
                          Only items recurring at least N times (default 2 with -r)
  -r, --recurring-only    Show recurrences only (no per-item rows)
      --all               Include resolved items (default: open only)
      --sort <field>      age | recurrence | task (default age; recurrence with -r)
      --order <dir>       asc | desc (default desc)
      --limit <n>         Max rows after sort
      --offset <n>        Skip rows after sort

Promote options:
      --subtask           Child of the originating task
      --peer              Sibling of the originating task (default)
  -g, --goal "..."        Goal (default: the item's title or first sentence)
  -c, --code <code>       Task code (default: the agent's proposed code, else derived)
  -p, --prompt "..."      Prompt override (default: the item's body + provenance)
      --parent <task>     Parent override

Examples:
  lazy raised
  lazy raised --blocking
  lazy raised --status complete-only --min-age 7
  lazy raised -r
  lazy raised respond abc12345 a1b2c3d4 "ship option 2"
  lazy raised dismiss abc12345 a1b2c3d4 --reason "out of scope"
  lazy raised promote abc12345 a1b2c3d4 --subtask --code fix-retry-helper
  lazy raised blocking abc12345 a1b2c3d4 false${docsFooter('raised-items')}`);
}

/** Usage for the deprecated `lazy followups` / `lazy followup` spellings. */
