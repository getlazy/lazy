/**
 * `lazy memory <subcommand>` — the human's hands on lazy-owned shared memory.
 *
 * Memory records are small, named pieces of curated cross-task knowledge stored
 * in lazy's storage and auto-injected (as a one-line index) into builder and
 * agent launches. Humans and the builder write them; task agents are read-only
 * (enforced server-side at the MCP boundary — see `lazy_memory_save`).
 *
 * Subcommands:
 *   list                 — the index (default)
 *   show <name>          — one record in full, with its write history
 *   save <name>          — create/update a record (--description/--type, body
 *                          from --body, piped stdin, or $EDITOR)
 *   rm <name>            — tombstone a record (history is preserved)
 *   history [<name>]     — the append-only, actor-attributed write history
 *   compact              — (re)generate the DERIVED compact used for injection
 */

import { join } from 'path';
import { requireStorage, requireLazyRoot, parseFlags, formatDate } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped, promptYesNo } from '../editor';
import { theme } from '../theme';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { getActor } from '../../constants';
import {
  normalizeMemoryName,
  normalizeAuthoredMemoryDescription,
  validateMemoryType,
  renderMemoryRecord,
  elideMemoryDescription,
  assembleMemorySection,
  recordsNewerThanCompact,
  namesRemovedSinceCompact,
  formatBytes,
  isLiveMemory,
} from '../../memory';
import { generateMemoryCompact, type CompactMode } from '../../memory/compact';
import { loadConfig } from '../../config/loader';
import { isOfflineMode } from '../../utils/offline';
import { VALID_MEMORY_TYPES, type MemoryRecord } from '../../types';

export async function commandMemory(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case undefined:
    case 'list':
    case 'ls':
      await commandMemoryList(subArgs);
      break;
    case 'show':
    case 'read':
      await commandMemoryShow(subArgs);
      break;
    case 'save':
    case 'add':
      await commandMemorySave(subArgs);
      break;
    case 'rm':
    case 'remove':
    case 'forget':
      await commandMemoryRemove(subArgs);
      break;
    case 'history':
      await commandMemoryHistory(subArgs);
      break;
    case 'compact':
      await commandMemoryCompact(subArgs);
      break;
    default:
      console.error(`Unknown memory subcommand: ${subcommand}`);
      memoryUsage();
      process.exit(1);
  }
}

export const memorySubcommandUsage: Record<string, () => void> = {
  'list': memoryUsage,
  'show': memoryUsage,
  'save': memoryUsage,
  'rm': memoryUsage,
  'history': memoryUsage,
  'compact': memoryUsage,
};

// --- list ---

/** Width of the padded NAME/TYPE/UPDATED columns (plus their separating spaces). */
const LIST_PREFIX_WIDTH = 32 + 1 + 10 + 1 + 18 + 1;

/** Narrowest description column worth printing, however cramped the terminal is. */
const MIN_LIST_DESCRIPTION_WIDTH = 40;

/**
 * Columns left for the DESCRIPTION after the fixed ones. When stdout is not a
 * terminal (piped, redirected) there is no width to respect, so assume a roomy
 * 120 — a pipe is not wrap-constrained, and eliding harder there than a human
 * sees on screen would throw away text for no reason.
 */
function listDescriptionWidth(): number {
  const columns = process.stdout.columns || 120;
  return Math.max(MIN_LIST_DESCRIPTION_WIDTH, columns - LIST_PREFIX_WIDTH);
}

async function commandMemoryList(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'all', aliases: ['a'], takesValue: false },
  ], 'memory');
  const includeDeleted = parsed.flags.get('all') === true;

  const storage = await requireStorage();
  try {
    const records = await storage.listMemories({ includeDeleted });
    if (records.length === 0) {
      console.log('No memory records yet.');
      console.log(`Add one with: ${theme.command('lazy memory save <name> --description "..."')}`);
      return;
    }

    console.log(`${records.length} memory record(s):\n`);
    console.log(`${theme.header('NAME'.padEnd(32))} ${theme.header('TYPE'.padEnd(10))} ${theme.header('UPDATED'.padEnd(18))} ${theme.header('DESCRIPTION')}`);
    // Elide at DISPLAY time only — the store keeps the full description, and
    // `lazy memory show` prints it verbatim. Imported records may carry
    // descriptions well past the authoring budget; left whole they wrap across
    // terminal lines and the table stops being scannable.
    const width = listDescriptionWidth();
    let elided = false;
    for (const r of records) {
      const name = r.deleted_at ? `${r.name} (deleted)` : r.name;
      const description = elideMemoryDescription(r.description, width);
      if (r.description.length > width) elided = true;
      console.log(
        `${name.padEnd(32)} ${r.type.padEnd(10)} ${formatDate(r.updated_at).padEnd(18)} ${description}`,
      );
    }
    // What is ACTUALLY injected depends on whether a compact exists, so say so
    // here rather than letting the index list imply it is the injected text.
    const compact = await storage.getMemoryCompact();
    if (compact) {
      const newer = records
        .filter(isLiveMemory)
        .filter(r => !compact.covered.some(c => c.name === r.name && c.revision === r.revision));
      console.log(
        `\nInjected as a ${compact.method} compact generated ${formatDate(compact.generated_at)}` +
        (newer.length > 0 ? ` plus ${newer.length} record(s) written since it` : '') +
        ` (${theme.command('lazy memory compact --show')}).`,
      );
    }

    console.log(
      elided
        ? `\nDescriptions are shortened to fit; read one in full with: ${theme.command('lazy memory show <name>')}`
        : `\nRead one with: ${theme.command('lazy memory show <name>')}`,
    );
  } finally {
    await storage.close();
  }
}

// --- show ---

async function commandMemoryShow(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'memory');
  const nameInput = parsed.positional[0];
  if (!nameInput) {
    console.error('Usage: lazy memory show <name>');
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const name = normalizeMemoryName(nameInput);
    const record = await storage.getMemory(name);
    if (!record) {
      console.error(`No memory record named '${name}'. List them with: lazy memory list`);
      process.exit(1);
    }

    console.log(renderMemoryRecord(record));
    console.log('');
    console.log(theme.separator('─'.repeat(60)));
    console.log(
      `revision ${record.revision} · created ${formatDate(record.created_at)} by ${record.created_by} · ` +
      `updated ${formatDate(record.updated_at)} by ${record.updated_by}`,
    );
  } finally {
    await storage.close();
  }
}

// --- save ---

async function commandMemorySave(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'description', aliases: ['d'], takesValue: true },
    { name: 'type', aliases: ['t'], takesValue: true },
    { name: 'body', aliases: ['b'], takesValue: true },
  ], 'memory');

  const nameInput = parsed.positional[0];
  if (!nameInput) {
    console.error('Usage: lazy memory save <name> [--description "..."] [--type <type>] [--body "..."]');
    process.exit(1);
  }

  const name = normalizeMemoryName(nameInput);

  const storage = await requireStorage();
  try {
    const existing = await storage.getMemory(name);

    // PRE-FLIGHT before $EDITOR (CLAUDE.md — never lose human feedback): every
    // validation that can fail happens here, so the human never types a record
    // body only to have it rejected afterwards.
    const descriptionInput = parsed.flags.get('description') as string | undefined;
    if (descriptionInput === undefined && !existing) {
      console.error(
        `A new memory record needs a description: lazy memory save ${name} --description "one line"`,
      );
      process.exit(1);
    }
    // AUTHORING surface: the length budget applies to descriptions written
    // here. An untouched `existing.description` passes through verbatim — an
    // imported record may legitimately exceed the limit, and editing its body
    // must not force a rewrite of its description.
    const description = descriptionInput !== undefined
      ? normalizeAuthoredMemoryDescription(descriptionInput)
      : existing!.description;

    const typeInput = parsed.flags.get('type') as string | undefined;
    if (typeInput === undefined && !existing) {
      console.error(
        `A new memory record needs a type: lazy memory save ${name} --type <${VALID_MEMORY_TYPES.join('|')}>`,
      );
      process.exit(1);
    }
    const type = typeInput !== undefined ? validateMemoryType(typeInput) : existing!.type;

    // Body: --body > piped stdin > $EDITOR (seeded with the existing body).
    const bodyFlag = parsed.flags.get('body') as string | undefined;
    let body: string;
    let recoveryPath: string | null = null;

    if (bodyFlag !== undefined) {
      body = bodyFlag;
    } else {
      const piped = await readStdinIfPiped();
      if (piped !== null) {
        body = piped;
      } else {
        if (!process.stdin.isTTY) {
          console.error('No body provided. Use --body, pipe the body on stdin, or run interactively.');
          process.exit(1);
        }
        const editResult = await openEditor(existing?.body ?? '', `memory-${name}`);
        if (editResult === null) {
          console.log('Editor cancelled.');
          return;
        }
        body = editResult.content;
        recoveryPath = editResult.recoveryPath;
      }
    }

    if (!body.trim()) {
      if (recoveryPath) removeRecoveryFile(recoveryPath);
      console.error('Empty memory body. Nothing saved.');
      process.exit(1);
    }

    // INTAKE BOUNDARY: a raw NUL from an editor/pipe would corrupt every read
    // surface (and this text is injected into prompts). Escape at the door.
    const record = await storage.saveMemory(
      { name, description, type, body: sanitizeUserText(body).trim() },
      getActor(),
    );
    // Durably persisted — only now is it safe to drop the recovery file.
    if (recoveryPath) removeRecoveryFile(recoveryPath);

    console.log(`${existing ? 'Updated' : 'Saved'} memory record '${record.name}' (revision ${record.revision}).`);
    console.log(`  type: ${record.type}`);
    console.log(`  ${record.description}`);
  } finally {
    await storage.close();
  }
}

// --- rm ---

async function commandMemoryRemove(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'memory');

  const nameInput = parsed.positional[0];
  if (!nameInput) {
    console.error('Usage: lazy memory rm <name> [--yes]');
    process.exit(1);
  }

  const name = normalizeMemoryName(nameInput);
  const storage = await requireStorage();
  try {
    const existing = await storage.getMemory(name);
    if (!existing) {
      console.error(`No memory record named '${name}'.`);
      process.exit(1);
    }

    if (parsed.flags.get('yes') !== true) {
      console.log(`${existing.name} (${existing.type}) — ${existing.description}`);
      const confirmed = await promptYesNo(`Remove memory record '${name}'?`, false);
      if (!confirmed) {
        console.log('Cancelled.');
        return;
      }
    }

    await storage.deleteMemory(name, getActor());
    console.log(`Removed memory record '${name}'. Its write history is preserved (lazy memory history ${name}).`);
  } finally {
    await storage.close();
  }
}

// --- history ---

async function commandMemoryHistory(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'memory');
  const nameInput = parsed.positional[0];

  const storage = await requireStorage();
  try {
    const name = nameInput ? normalizeMemoryName(nameInput) : undefined;
    const events = await storage.getMemoryHistory(name);
    if (events.length === 0) {
      console.log(name ? `No history for memory record '${name}'.` : 'No memory writes recorded yet.');
      return;
    }

    console.log(`${events.length} memory write(s)${name ? ` for '${name}'` : ''}:\n`);
    for (const e of events) {
      const label = name ? `${e.action}` : `${e.action} ${e.name}`;
      console.log(`[${formatDate(e.timestamp)}] ${label} (rev ${e.revision}) by ${e.actor}`);
      if (e.description) console.log(`    ${e.description}`);
    }
  } finally {
    await storage.close();
  }
}

// --- compact ---

/**
 * `lazy memory compact` — (re)generate the DERIVED compact used for injection.
 *
 * The records are NEVER touched here: this reads them and writes one separate,
 * overwritable artifact. Every run regenerates from the live records (never from
 * the previous compact), so repeated compaction cannot compound lossy
 * compression.
 *
 * No confirmation prompt, deliberately: the compact is derived state that any
 * later run can rebuild, so overwriting it destroys nothing — and prompting for
 * a safe act trains people to say yes to prompts that matter.
 */
async function commandMemoryCompact(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'mechanical', takesValue: false },
    { name: 'llm', takesValue: false },
    { name: 'model', aliases: ['m'], takesValue: true },
    { name: 'show', takesValue: false },
    { name: 'clear', takesValue: false },
  ], 'memory');

  const wantMechanical = parsed.flags.get('mechanical') === true;
  const wantLlm = parsed.flags.get('llm') === true;
  if (wantMechanical && wantLlm) {
    console.error('--mechanical and --llm are mutually exclusive: pick the generator, or pass neither for auto (LLM with mechanical fallback).');
    process.exit(1);
  }
  const mode: CompactMode = wantMechanical ? 'mechanical' : wantLlm ? 'llm' : 'auto';

  const root = requireLazyRoot();
  const config = await loadConfig(root);
  const warnBytes = config.memory.warn_bytes;

  const storage = await requireStorage();

  // Returns false when compaction was REJECTED, so the non-zero exit can happen
  // after storage is closed: `lazy` exits 0 on any clean dispatch, and exiting
  // from inside the try would skip the close.
  const run = async (): Promise<boolean> => {
    if (parsed.flags.get('clear') === true) {
      const cleared = await storage.clearMemoryCompact();
      console.log(cleared
        ? 'Cleared the memory compact. Injection falls back to the full index; regenerate with `lazy memory compact`.'
        : 'No memory compact to clear. Injection is already using the full index.');
      return true;
    }

    const records = await storage.listMemories();
    const live = records.filter(isLiveMemory);

    if (parsed.flags.get('show') === true) {
      await showMemoryCompact(storage, records, live, warnBytes);
      return true;
    }

    if (live.length === 0) {
      console.log('No memory records to compact.');
      return true;
    }

    // Size of what is injected TODAY (before this run), so the human sees what
    // compaction actually bought. Read via the same renderer the launch paths use.
    const previous = await storage.getMemoryCompact();
    // assembleMemorySection (not renderMemorySection + a re-measure) so the size
    // quoted here is the same one `lazy doctor` and the launch threshold use:
    // measured WITHOUT the builder's size note, which is a consequence of the
    // size rather than part of the budget it describes.
    const sectionBytes = (compact: typeof previous): number =>
      assembleMemorySection(records, 'builder', { compact, warnBytes }).measured.bytes;
    const beforeBytes = sectionBytes(previous);
    const plainBytes = sectionBytes(null);

    const offline = await isOfflineMode(join(root, '.lazy'), config.remote.offline);
    const model = parsed.flags.get('model') as string | undefined;

    // Tell the human what is about to happen BEFORE the model call — otherwise
    // `lazy memory compact` sits silent for the length of an LLM round-trip with
    // no indication that it is waiting on anything.
    console.log(`Compacting ${live.length} memory record(s)${mode === 'mechanical' ? ' (mechanical, no model)' : ''}…`);
    console.log(`  last compact: ${previous
      ? `${formatDate(previous.generated_at)} (${previous.method}${previous.model ? `, ${previous.model}` : ''}, ${previous.covered.length} record(s))`
      : 'never'}`);
    if (mode !== 'mechanical') {
      console.log(`  generator: ${mode === 'llm' ? 'llm (required)' : 'llm, falling back to mechanical'}` +
        (offline ? ' — offline mode is on, so the mechanical path will be used' : ''));
      if (!offline) {
        console.log(`  model: ${model ?? 'Claude CLI default'}`);
        console.log('  waiting on the model — this usually takes a few seconds…');
      }
    }

    const result = await generateMemoryCompact(live, {
      mode,
      model,
      targetBytes: warnBytes,
      offline,
    });

    // INVARIANT: compaction must never grow the injected context. A candidate
    // that does is not saved — the previous compact (or none) stays in place and
    // the human is told what it would have cost and what actually helps.
    if (!result.input) {
      const wouldBe = result.rejected ? sectionBytes({
        ...result.rejected,
        generated_at: Date.now(),
        generated_by: getActor(),
      }) : plainBytes;
      console.error('');
      console.error(theme.warning('No compact written — compaction would not shrink the injected context.'));
      console.error(`  without a compact:  ${formatBytes(plainBytes)}`);
      console.error(`  with this compact:  ${formatBytes(wouldBe)}` +
        ` (${wouldBe >= plainBytes ? '+' : '−'}${formatBytes(Math.abs(wouldBe - plainBytes))})`);
      for (const note of result.notes) {
        console.error(`  note: ${note}`);
      }
      console.error(
        `\nWhy this happens: a compact carries its own explanatory preamble, and the records' one-line\n` +
        `descriptions are already dense — summarizing ${live.length} of them costs more than it saves.\n` +
        `Compaction pays off once the plain index is large; with a small or already-tight store it cannot.`,
      );
      console.error(
        `\nWhat helps: curate the records (${theme.command('lazy memory list')}, ${theme.command('lazy memory rm <name>')}),\n` +
        `or raise ${theme.command('[memory] warn_bytes')} in lazy.toml if the current size is acceptable.`,
      );
      console.error(previous
        ? `\nThe existing compact (generated ${formatDate(previous.generated_at)}) is unchanged and still injected.`
        : '\nNo compact was written; injection continues to use the full index.');
      return false;
    }

    const saved = await storage.saveMemoryCompact(result.input, getActor());
    const after = assembleMemorySection(records, 'builder', { compact: saved, warnBytes }).measured;

    console.log('');
    console.log(
      `Compacted ${saved.covered.length} memory record(s) using ${saved.method} compaction` +
      `${saved.model ? ` (${saved.model})` : ''}.`,
    );
    console.log(`  injected context: ${formatBytes(beforeBytes)} → ${formatBytes(after.bytes)} ` +
      `(advisory threshold ${formatBytes(after.warnBytes)})`);
    console.log(`  without any compact it would be ${formatBytes(plainBytes)}`);
    // A recompact that is bigger than the PREVIOUS compact is still a win over
    // no compact (or it would have been rejected) — but the human just watched a
    // number go up, so say why rather than leaving them to wonder.
    if (after.bytes > beforeBytes && previous) {
      console.log(theme.warning(
        `  Larger than the previous compact (${formatBytes(beforeBytes)}): it now covers ` +
        `${saved.covered.length} record(s), including ones that were injected as raw index lines before.`,
      ));
    }
    for (const note of result.notes) {
      console.log(`  note: ${note}`);
    }
    if (after.overThreshold) {
      console.log(theme.warning(
        `  Still over the advisory threshold. Nothing is blocked — but consider whether some records ` +
        `have outlived their usefulness (\`lazy memory list\`, \`lazy memory rm <name>\`).`,
      ));
    }
    console.log('\nThe records themselves were not modified. Inspect the compact with: ' +
      theme.command('lazy memory compact --show'));
    return true;
  };

  let accepted = false;
  try {
    accepted = await run();
  } finally {
    await storage.close();
  }
  if (!accepted) process.exit(1);
}

/**
 * `lazy memory compact --show` — the current compact artifact and, just as
 * importantly, its COVERAGE.
 *
 * The compact alone is only half of what gets injected: everything written since
 * its watermark rides along as a live index line, and everything removed since is
 * called out as gone. Showing the artifact without those two lists invites the
 * exact doubt this exists to answer — "is a memory I saved after compacting
 * actually being injected?" — so both are printed even when empty.
 */
async function showMemoryCompact(
  storage: Awaited<ReturnType<typeof requireStorage>>,
  records: MemoryRecord[],
  live: MemoryRecord[],
  warnBytes: number,
): Promise<void> {
  const existing = await storage.getMemoryCompact();
  if (!existing) {
    console.log('No memory compact yet — the full index of ' +
      `${live.length} record(s) is injected as-is.`);
    console.log('Generate one with: ' + theme.command('lazy memory compact'));
    return;
  }

  console.log(`Generated ${formatDate(existing.generated_at)} by ${existing.generated_by} ` +
    `(${existing.method}${existing.model ? `, ${existing.model}` : ''}), covering ${existing.covered.length} record(s).`);

  const withCompact = assembleMemorySection(records, 'builder', { compact: existing, warnBytes }).measured;
  const without = assembleMemorySection(records, 'builder', { compact: null, warnBytes }).measured;
  console.log(`Injected context: ${formatBytes(withCompact.bytes)} with this compact, ` +
    `${formatBytes(without.bytes)} without it (advisory threshold ${formatBytes(warnBytes)}).`);

  console.log(theme.separator('─'.repeat(60)));
  console.log(existing.content);
  console.log(theme.separator('─'.repeat(60)));

  // CATCH-UP: records newer than the watermark are injected in full alongside the
  // compact, so nothing written after a compaction is invisible to a session.
  const newer = recordsNewerThanCompact(records, existing);
  if (newer.length > 0) {
    console.log(`\nAlso injected — ${newer.length} record(s) written or updated since this compact ` +
      `(their live index line supersedes the summary):`);
    for (const r of newer) {
      console.log(`  - ${r.name} (${r.type}) — ${elideMemoryDescription(r.description, listDescriptionWidth())}`);
    }
    console.log(`Fold them in with: ${theme.command('lazy memory compact')}`);
  } else {
    console.log('\nEvery live record is covered at its current revision — nothing is injected outside this summary.');
  }

  const removed = namesRemovedSinceCompact(records, existing);
  if (removed.length > 0) {
    console.log(`\nRemoved since this compact (injection flags them as gone): ${removed.join(', ')}`);
  }
}

export function memoryUsage(): void {
  console.log(`Usage: lazy memory <subcommand>

Manage lazy-owned shared memory — small, named records of curated cross-task
knowledge. A one-line index of every record is injected into builder and agent
launches; the full body is read on demand.

Subcommands:
  list                     Show the index of all records (default)
  show <name>              Print one record in full
  save <name>              Create or update a record
  rm <name>                Remove a record (tombstone; history is preserved)
  history [<name>]         Show the append-only, actor-attributed write history
  compact                  Regenerate the derived compact used for injection

Options:
  -a, --all                (list) Include removed records
  -d, --description "..."  (save) One-line summary (max 200 chars) — injected
  -t, --type <type>        (save) One of: ${VALID_MEMORY_TYPES.join(', ')}
  -b, --body "..."         (save) Record body; omit to use piped stdin or \$EDITOR
  -y, --yes                (rm) Skip the confirmation prompt
      --mechanical         (compact) Code-only compaction; no model needed
      --llm                (compact) Require the model path; fail if unavailable
  -m, --model <model>      (compact) Model for the LLM path
      --show               (compact) Print the current compact and what it covers
      --clear              (compact) Delete the compact; injection uses the full index

Compaction: \`lazy memory compact\` writes a separate, derived summary of the
records and injects that instead of the full index. The records are never
modified, every run regenerates from them (never from the previous compact), and
anything written since the compact is injected as its live index line — a newer
line always supersedes the summary. Over ${'`'}[memory] warn_bytes${'`'} (default 4KB) every
launch warns and suggests compacting; nothing is ever truncated or blocked.

A compact that would make the injected context BIGGER is rejected and not
saved (exit 1); any existing compact stays in place. A compact carries its own
explanatory preamble, so small or already-dense stores cannot be compacted
below their plain index — curating the records is what helps there.
${'`'}--show${'`'} prints the compact plus its coverage: when it was generated, how many
records it covers, and which newer records are injected raw alongside it.

Who can write: humans (this command) and the builder (lazy_memory_save). Task
agents are READ-ONLY — memory is injected into every future session, so an
agent-writable store would be a prompt-injection channel. Agents read it with
lazy_memory_recall and lazy_search 'in:memories <text>'.

Memory vs journal: the journal (lazy journal) is a raw, per-task, prompt-immune
record of one task; memory is curated, cross-task knowledge that IS injected.

Examples:
  lazy memory list
  lazy memory save vm-credentials-idea -t project -d "Why VM creds are injected at boot"
  echo "Body text" | lazy memory save deploy-window -t reference -d "Deploys are Tue/Thu 10am"
  lazy memory show vm-credentials-idea
  lazy memory history vm-credentials-idea
  lazy memory rm stale-note --yes
  lazy memory compact
  lazy memory compact --mechanical
  lazy memory compact --show
  lazy search 'in:memories "credentials"'`);
}
