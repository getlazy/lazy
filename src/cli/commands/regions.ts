import { parseFlags } from '../helpers';
import { queryRegions, setRegionOverlay } from '../../daemon/rpc-fallback';
import { overlayActorName, regionNoteLine, type RegionSummary } from '../../regions';

/**
 * "signed off @abc1234 by Kim", or without the name when the write could not
 * be attributed — the single-machine case, and every overlay written before
 * attribution existed. Never a placeholder name.
 */
function signOffText(
  sha: string,
  current: boolean | undefined,
  by: Parameters<typeof overlayActorName>[0],
): string {
  const who = overlayActorName(by);
  // Provenance-neutral on purpose: a presented region stales when its own
  // content hash moved (the carve's head key is gone from human surfaces), and
  // either way the meaning for the reviewer is the same — what this approval
  // was given against is not what is on the screen now.
  return `signed off @${sha.slice(0, 8)}${who ? ` by ${who}` : ''}` +
    (current ? '' : ' (STALE — region has changed)');
}

/** "owner ierceg (set by Kim)" — the label, and who put it there when known. */
function ownerText(owner: string, setBy: Parameters<typeof overlayActorName>[0]): string {
  const who = overlayActorName(setBy);
  return `owner ${owner}${who ? ` (set by ${who})` : ''}`;
}

/**
 * `lazy regions <task>` — the task's review regions, as a list.
 *
 * The daemon decides what the rows ARE — the walkthrough the task filed on
 * its last human-facing park, or, for a task with landed subtasks, a map
 * derived from those children; this only formats. Indentation shows the
 * hierarchy, because "this region is inside that one" is the single most
 * useful thing about a 400-region release and a flat list destroys it.
 */
export async function commandRegions(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'region', aliases: ['r'], takesValue: true },
    { name: 'files', takesValue: false },
    { name: 'depth', takesValue: true },
    { name: 'all', takesValue: false },
    { name: 'name', takesValue: true },
    { name: 'owner', takesValue: true },
    { name: 'sign-off', takesValue: false },
    { name: 'unsign', takesValue: false },
    { name: 'json', takesValue: false },
  ], 'regions');

  const taskId = parsed.positional[0];
  if (!taskId) {
    regionsUsage();
    process.exit(1);
  }

  const region = parsed.flags.get('region') as string | undefined;
  const name = parsed.flags.get('name') as string | undefined;
  const owner = parsed.flags.get('owner') as string | undefined;
  const signOff = parsed.flags.get('sign-off') === true;
  const unsign = parsed.flags.get('unsign') === true;

  if ((name !== undefined || owner !== undefined || signOff || unsign) && !region) {
    console.error(
      '--name, --owner, --sign-off and --unsign need --region <id> to say which region.',
    );
    process.exit(1);
  }
  if (signOff && unsign) {
    console.error('Pass --sign-off or --unsign, not both.');
    process.exit(1);
  }

  if (name !== undefined || owner !== undefined || signOff || unsign) {
    const result = await setRegionOverlay({
      taskId,
      region: region!,
      ...(name !== undefined ? { name } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(signOff ? { signOff: true } : {}),
      ...(unsign ? { signOff: false } : {}),
    });
    const signed = result.overlay.signed_off_sha;
    console.log(
      `Region ${result.region}: ` +
      [
        result.overlay.name ? `named "${result.overlay.name}"` : null,
        result.overlay.owner
          ? ownerText(result.overlay.owner, result.overlay.owner_set_by)
          : (owner !== undefined ? 'owner cleared' : null),
        signed
          ? `signed off at ${signed.slice(0, 8)}` +
            (overlayActorName(result.overlay.signed_off_by)
              ? ` by ${overlayActorName(result.overlay.signed_off_by)}`
              : '')
          : (unsign ? 'sign-off withdrawn' : null),
      ].filter(Boolean).join(', '),
    );
    return;
  }

  const depthValue = parsed.flags.get('depth') as string | undefined;
  let depth: number | 'all' | undefined;
  if (parsed.flags.get('all') === true) {
    depth = 'all';
  } else if (depthValue !== undefined) {
    const parsedDepth = Number.parseInt(depthValue, 10);
    if (!Number.isFinite(parsedDepth) || parsedDepth < 0) {
      console.error(`Invalid --depth: ${depthValue}. Expected a non-negative integer (0 = top level only), or use --all.`);
      process.exit(1);
    }
    depth = parsedDepth;
  }

  const cover = await queryRegions({ taskId, region, depth });

  if (parsed.flags.get('json') === true) {
    console.log(JSON.stringify(cover, null, 2));
    return;
  }

  if (cover.region || cover.superseded_unit) {
    printRegionDetail(cover, parsed.flags.get('files') === true);
    return;
  }

  console.log(`Regions for ${cover.taskId} — ${cover.baseRef}..${cover.headSha.slice(0, 8)}`);
  console.log(
    cover.shown === cover.total
      ? `${cover.total} region(s)\n`
      : `${cover.shown} of ${cover.total} region(s) — ` +
        `showing depth ${cover.depth}; expand one with --region <id>, or --all\n`,
  );
  for (const r of cover.regions) {
    console.log(formatRow(r));
  }

  for (const note of dedupeNotes(cover.notes)) {
    console.log(`\nnote: ${note}`);
  }
  if (cover.regions.length > 0) {
    console.log('\nScope a diff to one:  lazy diff <task> --region <id> --full');
  }
}

/**
 * One region row. The file count IS the region's share of the partition, so
 * the counts down a level sum to the review's own file count — that is the
 * property the row is there to make readable, and it goes on the row rather
 * than behind a flag.
 */
function formatRow(r: RegionSummary): string {
  const indent = '  '.repeat(r.depth);
  const who = [r.actors?.join('/'), r.models?.join('/')].filter(Boolean).join(' ')
    || r.authors.join(', ');
  const bits = [
    `${r.files} file${r.files === 1 ? '' : 's'}`,
    r.shared > 0 ? `${r.shared} also touched by others` : null,
    r.owner ? ownerText(r.owner, r.owner_set_by) : null,
    who || null,
    // A sign-off the branch has moved past is marked STALE rather than shown
    // as approval: "signed off" on code nobody has seen is the one failure a
    // per-region sign-off exists to prevent. And it names WHO signed, when the
    // daemon knew them — an approval by nobody cannot be questioned.
    r.signed_off_sha
      ? signOffText(r.signed_off_sha, r.signed_off_current, r.signed_off_by)
      : null,
    r.descendants > 0 ? `${r.descendants} inside → --region ${r.id}` : null,
  ].filter(Boolean);
  const head = `${indent}${r.unit === 'task' ? '▸' : r.unit === 'chunk' ? '·' : '○'} ${r.id}`;
  // The walkthrough's own line about this region — and on "Other changes",
  // how much of the branch it did not name and whether a cap forced that.
  // Clipped by the shared helper, so this row and the web strip say the same
  // thing at the same length.
  const noteLine = regionNoteLine(r.note);
  return `${head}\n${indent}   ${truncate(r.label, 100)}\n${indent}   ${bits.join(' · ')}` +
    (noteLine ? `\n${indent}   ${noteLine}` : '') +
    (r.expanded ? `\n${indent}   expanded: ${r.expansion_reasons.join('; ')}` : '');
}

/**
 * Name an "also touched by" unit. The carve's own superseded marking died
 * with the carve's human surfaces (§6.3): the walkthrough the agent declared
 * has no such rows, and the shared-file "also" list on a presented region
 * names live claimants only.
 */
function printRegionDetail(
  cover: Awaited<ReturnType<typeof queryRegions>>,
  withFiles: boolean,
): void {
  const r = cover.region!;
  console.log(`${r.id}  (${r.unit}, via ${r.provenance})`);
  console.log(r.name ? `${r.name}  — ${r.title}` : r.title);
  if (r.note) console.log(r.note);
  if (r.from && r.to) console.log(`range: ${r.from.slice(0, 12)}..${r.to.slice(0, 12)}`);
  if (r.owner) console.log(`owner: ${ownerText(r.owner, r.owner_set_by).replace(/^owner /, '')}`);
  // The detail view showed an owner and not a sign-off, so the one place a
  // reviewer goes to read everything about a region was the one place that
  // could not tell them whether it had been approved, or by whom.
  if (r.signed_off_sha) {
    // The key is the region's CONTENT hash on a presented region (what the
    // sign-off actually approved), falling back to the head only on a carve
    // read, where that is the only key there is.
    console.log(
      signOffText(r.signed_off_sha, r.signed_off_sha === (cover.region_hash ?? cover.headSha), r.signed_off_by),
    );
  }
  console.log(`authors: ${r.authors.join(', ') || 'unknown'}`);
  if (r.actors?.length) console.log(`actors: ${r.actors.join(', ')}`);
  if (r.agents?.length) console.log(`agents: ${r.agents.join(', ')}`);
  if (r.models?.length) console.log(`models: ${r.models.join(', ')}`);
  const shared = new Map(r.shared_files.map((f) => [f.path, f]));
  console.log(
    `\n${r.files.length} file(s), ${shared.size} of them also touched by other units`,
  );
  if (withFiles) {
    for (const f of r.files) {
      const share = shared.get(f);
      // The line split is the answer to "how much of this file is really
      // theirs" — the question a reviewer of a shared file asks first, and the
      // one a co-owner list on its own never answered.
      // `0/0` is not a line split, it is blame declining to answer — a deleted
      // file, a binary, or one whose review lines were all overwritten again.
      // Printed as a ratio it reads as a bug in the count rather than as the
      // absence of one, which is the opposite of what it means.
      const split = share && share.total_lines > 0
        ? `${share.lines}/${share.total_lines} lines; `
        : 'no surviving lines to weigh; ';
      console.log(
        share
          ? `  ${f}  (${split}also: ${share.also.join(', ')})`
          : `  ${f}`,
      );
    }
  } else if (r.files.length > 0) {
    console.log('Pass --files to list them.');
  }

  // What is inside it. This is the drill-down half of "regions are a tree":
  // asking for a region is also how you see the level below it.
  const children = cover.regions.filter((c) => c.parent_id === r.id);
  if (children.length > 0) {
    console.log(`\n${children.length} region(s) inside this one:`);
    for (const child of children) console.log(formatRow({ ...child, depth: 0 }));
  }
}

/**
 * Notes repeat once per unrecoverable branch, which on a big release is
 * hundreds of near-identical lines. Collapse the repeats into a count.
 */
function dedupeNotes(notes: string[]): string[] {
  const missing = notes.filter((n) => n.startsWith('No surviving branch for'));
  const rest = notes.filter((n) => !n.startsWith('No surviving branch for'));
  if (missing.length <= 3) return [...rest, ...missing];
  return [
    ...rest,
    `${missing.length} units had no surviving branch and stayed commit-level regions.`,
  ];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function regionsUsage(): void {
  console.log(`Usage: lazy regions <task_id> [--region <id>] [--depth <n>|--all] [--files] [--json]
       lazy regions <task_id> --region <id> [--name <text>] [--owner <who>] [--sign-off | --unsign]

Show a task's review regions — the walkthrough it filed with its report
(presentation.groups), with an "Other changes" region for anything no group
claimed. A walkthrough is authored on every park that faces a human, not only
on a task declared done, and re-authored only once the branch has moved past
the one on record.

A task with LANDED subtasks is presented by them instead: a map derived from
its children, one region per accepted child. Nobody writes that one, and it
says so.

Regions are a PARTITION: every file in the review belongs to exactly one
region, so the file counts add up to the size of the change and signing one
off means something. A file several groups reference is owned by the group
that claimed it whole; the others may quote it as a snippet, which names the
owner alongside it as having also touched it.

Regions keep the order the agent's walkthrough declared them in — that order
is the story to review by — and form a TREE: the top-level groups by default,
then --region <id> to open one and see what is inside it.

Regions come from the task's own report, or from its children. A git-derived
carve is the agents' authoring hint (the MCP tool's provenance flag); the
human surface has no flag for it, because the thing a review navigates by is
the walkthrough, not the carve.

Arguments:
  <task_id>        ID of the task

Options:
  -r, --region <id>  Show one region in detail (a task code or a full region id)
  --files            With --region, list the region's files
  --depth <n>        Show regions down to depth n (default 0: top level only)
  --all              Show every region at every depth
  --name <text>      Name a region (survives every recompute)
  --owner <who>      Say who this region is to review; empty string clears it
  --sign-off         Record a sign-off for a region, against its current content
  --unsign           Withdraw a region's sign-off
  --json             Machine-readable output

Examples:
  lazy regions release-v022                     # the walkthrough's top-level groups
  lazy regions release-v022 -r fix-timings      # that region, and what is inside it
  lazy regions release-v022 --all               # every region, however deep
  lazy regions release-v022 -r fix-timings --files
  lazy diff release-v022 --region fix-timings --full
  lazy regions release-v022 -r fix-timings --owner ierceg
  lazy regions release-v022 -r fix-timings --sign-off`);
}
