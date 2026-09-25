/**
 * `lazy system store-check <path>` — report what a store directory is, without
 * opening it.
 *
 * The preflight for adopting an existing store into a Lazy Teams project
 * ("Adopting an existing store" in public-docs/self-hosting-lazy-teams.md).
 * Lazy Teams' fleet supervisor calls this with `--json` before it takes
 * ownership of a directory; an operator can run the same command by hand to see
 * what Teams will see.
 *
 * Deliberately does NOT require a lazy project, and deliberately touches
 * nothing: the store it is asked about belongs to another install, may still be
 * running, and may turn out to be unadoptable. See src/storage/store-inspect.ts
 * for why no code path here may take `.storage-lock`.
 *
 * It REPORTS; it does not judge. Whether a held lock or an unattributable actor
 * id is fatal is the adopting install's policy (lazy-teams' AdoptsStore), and
 * the human-readable output says what each finding means without deciding for
 * it. Exit 1 is reserved for "there is no store at that path" — the one answer
 * that makes every other field meaningless.
 */

import { resolve } from 'path';
import { parseFlags } from '../helpers';
import { inspectStore, type StoreInspection } from '../../storage/store-inspect';

export async function commandSystemStoreCheck(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [{ name: 'json', takesValue: false }], 'system store-check');
  const target = parsed.positional[0];

  if (!target) {
    console.error('Error: lazy system store-check needs a store directory.');
    console.error('       Usage: lazy system store-check <path> [--json]');
    process.exit(1);
  }

  const inspection = await inspectStore(resolve(target));

  if (parsed.flags.get('json') === true) {
    console.log(JSON.stringify(inspection, null, 2));
  } else {
    printReport(inspection);
  }

  if (!inspection.is_store) process.exit(1);
}

function printReport(store: StoreInspection): void {
  if (!store.is_store) {
    console.error(`No lazy store at ${store.path} — it has no tasks/ directory.`);
    console.error('A store is the directory named by [storage] external_path in a project\'s lazy.toml.');
    return;
  }

  console.log(`Store:  ${store.path}`);
  console.log(`Tasks:  ${store.task_count}`);
  console.log(
    `Schema: ${store.schema_version ?? 'unstated'} (this lazy understands ${store.supported_schema_version})` +
    (store.schema_is_newer ? ' — WRITTEN BY A NEWER LAZY' : ''),
  );
  if (store.schema_error) console.log(`        UNREADABLE — ${store.schema_error}`);

  switch (store.lock.state) {
    case 'absent':
      console.log('Lock:   none — no process is holding this store');
      break;
    case 'held':
      console.log(
        `Lock:   HELD by pid ${store.lock.pid}` +
        (store.lock.command ? ` (${store.lock.command})` : '') +
        (store.lock.acquired_at ? `, since ${store.lock.acquired_at}` : ''),
      );
      console.log('        Something owns this store right now. Stop it before handing the store over.');
      break;
    case 'stale':
      console.log(`Lock:   stale (pid ${store.lock.pid}) — ${store.lock.reason}`);
      break;
    case 'unreadable':
      console.log(`Lock:   unreadable — ${store.lock.detail}`);
      break;
  }

  if (store.actor_user_ids.length === 0) {
    console.log('Actors: no user ids recorded — every row is attributed by role only');
  } else {
    console.log(`Actors: ${store.actor_user_ids.length} actor id(s): ${store.actor_user_ids.join(', ')}`);
    console.log('        These name people in the install that wrote them. An install that cannot');
    console.log('        resolve one would render somebody else\'s work under one of its own members.');
  }

  // Said out loud, because it qualifies the line above: "no user ids recorded"
  // means something different when part of the store could not be read.
  if (store.unscanned_files.length > 0) {
    console.log(`Unread: ${store.unscanned_files.length} file(s) could not be scanned for user ids:`);
    for (const name of store.unscanned_files.slice(0, 10)) console.log(`        ${name}`);
    if (store.unscanned_files.length > 10) {
      console.log(`        …and ${store.unscanned_files.length - 10} more`);
    }
    console.log('        The actor line above is only about the files that WERE read.');
  }
}

export function systemStoreCheckUsage(): void {
  console.log(`Usage: lazy system store-check <path> [--json]

Report what a lazy store directory holds, without opening it: its schema
version, whether anything is holding its lock, how many tasks it has, and which
actor ids its rows carry.

Nothing is written, and the store's lock is never taken — this is safe to run
against a store a daemon is currently serving (it will say so).

Options:
  --json    Machine-readable report (what Lazy Teams reads before adopting)

Examples:
  lazy system store-check ~/.lazy/my-project
  lazy system store-check ~/.lazy/my-project --json`);
}
