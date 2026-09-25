/**
 * `lazy doctor` — thin CLI client of `src/doctor/`.
 *
 * Flag dispatch, printing, prompts and process.exit live here. The sweep
 * itself — every check, the structured report, the inbox alert — lives in
 * the shared module so the daemon can run the same report without importing
 * this file.
 */

import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { findLazyRoot } from "../../project-paths";
import { theme } from "../../render/theme";
import { parseFlags, requireStorage, refuseIfBoundClone } from "../helpers";
import { loadConfig, resolveConfigPath } from "../../config/loader";
import { planAgentMigration } from "../../config/agent-migration";
import { commandDoctorFixAgents, DOCTOR_FIX_TARGETS } from "./doctor-fix-agents";
import {
  commandDoctorCleanWorktrees,
  commandDoctorCleanDockerImages,
  commandDoctorCleanOrphanedContainers,
  commandDoctorUnsetUpstreamTracking,
  commandDoctorResumeInterrupted,
  commandDoctorCleanLocalCommandConversations,
  type RemedyOptions,
} from "./doctor-remedies";
import {
  importHarnessMemory,
  countImportableMemories,
  formatLongDescriptionNotice,
} from "../../import/import-harness-memory";
import { findHousekeepingConversations } from "../../import/housekeeping-conversation";
import { runReimportBulk } from "./import-conversation";
import { isTTY, promptYesNo } from "../editor";
import { mayOfferUsagePauseOverride } from "../human-terminal";
import { docsFooter, docsSuffix } from "../../docs/links";
import {
  formatTimeSince,
  maybePostDoctorAlert,
  printContextBudget,
  runDoctorReport,
  withDoctorStorage,
  checkAdoptedImage,
  checkStaleLazyImages,
  explainExitCode,
} from "../../doctor";

// Re-export so existing tests that imported these from the CLI keep working.
export { checkAdoptedImage, checkStaleLazyImages, explainExitCode };

/**
 * `lazy doctor --import-memory`: the one-time migration from harness memory
 * files into lazy-owned shared memory. Previews, confirms (unless --yes), then
 * imports every record missing from the store. Idempotent — already-imported
 * names are skipped, so re-running is safe.
 */
async function commandDoctorImportMemory(root: string, opts: { yes: boolean }): Promise<void> {
  const config = await loadConfig(root);
  const dataDirAbs = join(root, config.data.path);

  // Writes go through the daemon (RemoteStorage) — the daemon owns storage.
  const storage = await requireStorage();
  try {
    const missing = await countImportableMemories({ lazyRoot: root, dataDirAbs, storage });
    if (missing === 0) {
      console.log('No harness memory records found on disk that lazy is missing — nothing to import.');
      return;
    }

    console.log(`Found ${missing} harness memory record(s) not yet in lazy's shared memory.`);
    if (!opts.yes) {
      if (!isTTY()) {
        console.log(`Re-run with ${theme.command('--yes')} to import them (non-interactive).`);
        return;
      }
      const proceed = await promptYesNo(`Import ${missing} memory record(s)?`, true);
      if (!proceed) {
        console.log('Aborted — nothing was imported.');
        return;
      }
    }

    const report = await importHarnessMemory({
      lazyRoot: root,
      dataDirAbs,
      storage,
      onImported: (info) => {
        console.log(theme.success(`  Imported ${info.name}`) + `  (${info.type}) ${info.description}`);
      },
    });

    console.log('');
    console.log(
      `Import complete: ${report.imported.length} imported, ` +
      `${report.skippedExisting.length} already present, ` +
      `${report.skippedEmpty.length} empty skipped.`,
    );
    // Curation hint, not a failure: over-long descriptions ARE imported.
    const longNotice = formatLongDescriptionNotice(report);
    if (longNotice) {
      console.log(theme.warning(`  ${longNotice}`));
    }
    if (report.errors.length > 0) {
      console.log(theme.error(`  ${report.errors.length} record(s) failed to import:`));
      for (const { name, error } of report.errors) {
        console.log(theme.error(`    ${name}: ${error.message}`));
      }
      process.exit(1);
    }
    console.log(`Review them with: ${theme.command('lazy memory list')}`);
  } finally {
    await storage.close();
  }
}

/**
 * `lazy doctor --reimport-conversations`: the built-in recovery. An alias for
 * the bulk path of `lazy import-conversation` — scans every candidate Claude
 * projects dir (shared + per-builder isolation dirs), dedupes sessions, and
 * re-imports any missing from the store through the daemon. Report-only preview
 * unless the user confirms (or passes --yes).
 */
/**
 * `lazy doctor --purge-housekeeping-conversations`: the one-time cleanup of
 * machine-generated `claude -p` one-shots that were captured before lazy
 * started excluding them at the source.
 *
 * INVARIANT: this NEVER runs as part of a routine `lazy doctor` sweep, and
 * never deletes without explicit human confirmation. It is the only caller of
 * `Storage.deleteConversation`, and it is the only place in lazy that
 * classifies a conversation by sniffing prompt wording — see the docblock in
 * src/import/housekeeping-conversation.ts for why that trade is acceptable
 * here and nowhere else.
 *
 * Without `--yes` the classified list is printed and NOTHING is deleted: a TTY
 * is then asked to confirm (defaulting to NO, because deletion is not
 * recoverable from lazy alone), and a non-TTY is told to re-run with `--yes`.
 */
async function commandDoctorPurgeHousekeeping(opts: { yes: boolean }): Promise<void> {
  // Reads and writes both go through the daemon (RemoteStorage) — the daemon
  // owns storage, and it is also the process running the capture sweep.
  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    const matches = findHousekeepingConversations(conversations);

    if (matches.length === 0) {
      console.log(
        `No machine-generated housekeeping conversations found among ${conversations.length} stored conversation(s).`,
      );
      return;
    }

    console.log(
      `Found ${matches.length} of ${conversations.length} stored conversation(s) that look like ` +
      `machine-generated lazy housekeeping:`,
    );
    console.log('');
    for (const { conversation, kind, reason } of matches) {
      const started = conversation.startedAt
        ? conversation.startedAt.replace('T', ' ').substring(0, 16)
        : 'unknown         ';
      const firstLine = (conversation.summary ?? '').split('\n')[0].trim();
      const elided = firstLine.length > 60 ? `${firstLine.substring(0, 57)}...` : firstLine;
      console.log(
        `  ${theme.taskId(conversation.sessionId.substring(0, 8))}  ${started}  ` +
        `${kind.padEnd(16)}  ${elided}`,
      );
      console.log(`    ${theme.label('why:')} ${reason}`);
    }
    console.log('');

    const byKind = new Map<string, number>();
    for (const m of matches) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    console.log(
      `By kind: ${[...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    );

    if (!opts.yes) {
      if (!isTTY()) {
        console.log('');
        console.log(`Nothing was deleted. Re-run with ${theme.command('--yes')} to delete them (non-interactive).`);
        return;
      }
      console.log('');
      console.log(theme.warning('Deleting a conversation is permanent — lazy cannot restore it.'));
      const proceed = await promptYesNo(`Delete ${matches.length} conversation(s) from the store?`, false);
      if (!proceed) {
        console.log('Aborted — nothing was deleted.');
        return;
      }
    }

    let deleted = 0;
    let alreadyGone = 0;
    const errors: { sessionId: string; error: Error }[] = [];
    for (const { conversation } of matches) {
      try {
        if (await storage.deleteConversation(conversation.sessionId)) {
          deleted++;
        } else {
          // Idempotent re-run, or something else purged it concurrently.
          alreadyGone++;
        }
      } catch (err) {
        errors.push({ sessionId: conversation.sessionId, error: err as Error });
      }
    }

    console.log('');
    console.log(
      `Purge complete: ${deleted} deleted` +
      (alreadyGone > 0 ? `, ${alreadyGone} already gone` : '') +
      (errors.length > 0 ? `, ${errors.length} failed` : '') + '.',
    );
    if (errors.length > 0) {
      for (const { sessionId, error } of errors) {
        console.log(theme.error(`  ${sessionId.substring(0, 8)}: ${error.message}`));
      }
      process.exit(1);
    }
    console.log(
      'This is a one-time cleanup: new housekeeping one-shots are marked at the source and never enter the store.',
    );
    // Least surprise: these conversations predate the on-disk marker, so the
    // recovery path cannot tell them apart from real history. Say so here
    // rather than letting the next `lazy doctor` quietly offer to undo this.
    console.log(
      theme.warning(
        `  Note: purged conversations whose raw Claude JSONL is still on disk carry no marker, so ` +
        `${theme.command('lazy doctor --reimport-conversations')} would bring them back.`,
      ),
    );
  } finally {
    await storage.close();
  }
}

async function commandDoctorReimport(root: string, opts: { yes: boolean }): Promise<void> {
  const config = await loadConfig(root);
  const dataDirAbs = join(root, config.data.path);

  // Writes go through the daemon (RemoteStorage) — the daemon owns storage.
  const storage = await requireStorage();
  try {
    const { ok } = await runReimportBulk({ lazyRoot: root, dataDirAbs, storage, yes: opts.yes });
    if (!ok) process.exit(1);
  } finally {
    await storage.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────

export async function commandDoctor(args: string[]): Promise<void> {
  // There is no local machine to diagnose for a bound clone — the daemon it
  // would check is Teams' own (design doc §4.4, §4.7). Refuse by name, like
  // `daemon start/stop/status`, `init` and `dashboard`.
  await refuseIfBoundClone('doctor');

  // Parse flags
  const parsed = parseFlags(args, [
    { name: "no-resume", takesValue: false },
    { name: "dry-run", takesValue: false },
    { name: "yes", aliases: ["y"], takesValue: false },
    { name: "reimport-conversations", takesValue: false },
    { name: "purge-housekeeping-conversations", takesValue: false },
    { name: "import-memory", takesValue: false },
    { name: "probe-agent", takesValue: false },
    { name: "fix", takesValue: true },
    { name: "clean-worktrees", takesValue: false },
    { name: "clean-docker-images", takesValue: false },
    { name: "clean-orphaned-containers", takesValue: false },
    { name: "unset-upstream-tracking", takesValue: false },
    { name: "resume-interrupted-tasks", takesValue: false },
    { name: "clean-local-command-conversations", takesValue: false },
    { name: "delete-empty-local-command-conversations", takesValue: false },
  ], "doctor");

  const dryRun = parsed.flags.get("dry-run") === true;
  const yes = parsed.flags.get("yes") === true;
  const reimportConversationsFlag = parsed.flags.get("reimport-conversations") === true;
  const purgeHousekeepingFlag = parsed.flags.get("purge-housekeeping-conversations") === true;
  const importMemoryFlag = parsed.flags.get("import-memory") === true;
  const probeAgent = parsed.flags.get("probe-agent") === true;
  const fixTarget = parsed.flags.get("fix");

  // If a positional argument is provided, run task-specific diagnostics
  if (parsed.positional.length > 0) {
    const { commandDoctorTask } = await import("./doctor-task");
    await commandDoctorTask(parsed.positional[0], { dryRun, yes, probeAgent });
    return;
  }

  // `--fix <target>` is a config REWRITER, not a health check: it runs before
  // (and instead of) the sweep, because the sweep's first check is "lazy.toml
  // parses" — which is exactly what a config needing this fix does not do, and
  // running the rest of the checks against a config that never loaded reports
  // defaults as if the user had chosen them.
  if (fixTarget !== undefined) {
    const target = typeof fixTarget === "string" ? fixTarget.trim() : "";
    if (!(DOCTOR_FIX_TARGETS as readonly string[]).includes(target)) {
      console.error(
        `Unknown --fix target ${JSON.stringify(target)}. ` +
        `Valid targets: ${DOCTOR_FIX_TARGETS.join(", ")}.`,
      );
      process.exit(1);
    }
    const fixRoot = findLazyRoot();
    if (!fixRoot) {
      console.error("Not in a lazy project. Run `lazy init` first.");
      process.exit(1);
    }
    await commandDoctorFixAgents(fixRoot, { yes });
    return;
  }

  // `--reimport-conversations` is a dedicated recovery flow, not part of the
  // health-check sweep: it scans every candidate Claude projects dir and
  // re-imports missing builder conversations into the store.
  if (reimportConversationsFlag) {
    const reimportRoot = findLazyRoot();
    if (!reimportRoot) {
      console.error("Not in a lazy project. Run `lazy init` first.");
      process.exit(1);
    }
    await commandDoctorReimport(reimportRoot, { yes });
    return;
  }

  // `--purge-housekeeping-conversations` is a one-time cleanup flow, never part
  // of the health-check sweep: it deletes already-stored machine-generated
  // one-shots that predate the capture-time exclusion.
  if (purgeHousekeepingFlag) {
    const purgeRoot = findLazyRoot();
    if (!purgeRoot) {
      console.error("Not in a lazy project. Run `lazy init` first.");
      process.exit(1);
    }
    await commandDoctorPurgeHousekeeping({ yes });
    return;
  }

  // `--import-memory` is likewise a dedicated migration flow, not part of the
  // health-check sweep: it imports harness memory files into shared memory.
  if (importMemoryFlag) {
    const importRoot = findLazyRoot();
    if (!importRoot) {
      console.error("Not in a lazy project. Run `lazy init` first.");
      process.exit(1);
    }
    await commandDoctorImportMemory(importRoot, { yes });
    return;
  }

  // The remedy flags: each one is a lazy operation doctor's checks point AT,
  // never a shell command list for the human to paste, and never something the
  // sweep does on its own. Each lists what it found, stops there under
  // `--dry-run`, confirms (skipped by `--yes`), then acts one line per item.
  const remedies: Array<{ flag: string; run: (root: string, opts: RemedyOptions) => Promise<void> }> = [
    { flag: "clean-worktrees", run: commandDoctorCleanWorktrees },
    { flag: "clean-docker-images", run: commandDoctorCleanDockerImages },
    { flag: "clean-orphaned-containers", run: commandDoctorCleanOrphanedContainers },
    { flag: "unset-upstream-tracking", run: commandDoctorUnsetUpstreamTracking },
    { flag: "resume-interrupted-tasks", run: commandDoctorResumeInterrupted },
    { flag: "clean-local-command-conversations", run: commandDoctorCleanLocalCommandConversations },
  ];
  // A modifier on one remedy, not a remedy of its own: on its own it would be a
  // delete flag with no listing in front of it, which is the shape this command
  // exists to avoid. Say which flag it belongs to rather than silently doing
  // nothing.
  const deleteEmpty = parsed.flags.get("delete-empty-local-command-conversations") === true;
  if (deleteEmpty && parsed.flags.get("clean-local-command-conversations") !== true) {
    console.error(
      `--delete-empty-local-command-conversations only applies to ` +
      `--clean-local-command-conversations. Run: ` +
      `lazy doctor --clean-local-command-conversations --delete-empty-local-command-conversations`,
    );
    process.exit(1);
  }

  const requested = remedies.filter(r => parsed.flags.get(r.flag) === true);
  if (requested.length > 1) {
    // One remedy per run: each prints its own listing and asks its own question,
    // and interleaving two of those is how a human confirms the wrong one.
    console.error(
      `Run one remedy at a time. Given: ${requested.map(r => `--${r.flag}`).join(", ")}.`,
    );
    process.exit(1);
  }
  if (requested.length === 1) {
    const remedyRoot = findLazyRoot();
    if (!remedyRoot) {
      console.error("Not in a lazy project. Run `lazy init` first.");
      process.exit(1);
    }
    await requested[0]!.run(remedyRoot, { yes, dryRun, deleteEmpty });
    return;
  }

  if (parsed.flags.get("no-resume") === true) {
    // Kept registered so existing scripts do not die on an unknown flag, but it
    // no longer suppresses anything: doctor never resumes on its own now.
    console.log(
      `Note: ${theme.command("--no-resume")} is no longer needed — doctor never resumes tasks on ` +
      `its own. Use ${theme.command("lazy doctor --resume-interrupted-tasks")} to resume.\n`,
    );
  }

  const root = findLazyRoot();
  const { report, results, notes } = await runDoctorReport({
    root,
    // Only a person at their own terminal is told the override command.
    offerUsagePauseOverride: await mayOfferUsagePauseOverride(),
    onStaleStorageLock: async (path, detail) => {
      if (detail) console.log(`${theme.error("✗")} ${detail}\n`);
      if (dryRun) {
        console.log(`Would remove stale storage lock: ${path}\n`);
        return "left";
      }
      const proceed = yes || !isTTY()
        ? yes
        : await promptYesNo(`Remove the stale storage lock at ${path}?`, true);
      if (proceed) {
        try {
          await unlink(path);
          console.log(theme.success(`Removed stale storage lock: ${path}\n`));
          return "removed";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(theme.error(`Could not remove ${path}: ${message}\n`));
          return "left";
        }
      }
      console.log(`Left in place. Remove it yourself with: ${theme.command(`rm ${path}`)}\n`);
      return "left";
    },
  });

  for (const note of notes) {
    console.log(`${note}\n`);
  }

  // Print results — same lines as before the extraction, from the original
  // CheckResults (they embed theme.command() ANSI). The structured report
  // strips colour for the inbox / RPC.
  for (const r of results) {
    if (r.ok) {
      console.log(theme.success(`✓ ${r.label}`));
      if (r.warning) {
        console.log(theme.warning(`  ! ${r.warning}`));
      }
    } else {
      console.log(theme.error(`✗ ${r.label}`));
      if (r.detail) {
        console.log(`  ${r.detail}`);
      }
      if (r.docs) {
        const pointer = docsSuffix(r.docs, "");
        if (pointer) console.log(`  ${pointer}`);
      }
    }
  }

  if (report.contextBudget) printContextBudget(report.contextBudget);

  if (root && report.configError) {
    await offerAgentMigration(root, { yes, dryRun });
  }

  // Report dead runs. Doctor NEVER acts here: it used to auto-resume every
  // interrupted task, which is both wrong (the daemon's reconciler already does
  // that, by design) and broken — it spawned `process.argv[0]`, an embedded
  // `bun` that is not on PATH in a released binary, so every automatic resume
  // failed with "binary 'bun' not found". Resuming now needs
  // `--resume-interrupted-tasks`.
  //
  // The two groups are separated on purpose. An `interrupted` task is
  // RESUMABLE by design — a watchdog kill or a container that went away leaves
  // it there, and a running daemon picks it up on its own — so calling it
  // "crashed" made a routine state read like damage.
  const crashedTasks = report.missingRuns;
  if (crashedTasks.length > 0) {
    const resumable = crashedTasks.filter(c => c.taskStatus === "interrupted");
    const dead = crashedTasks.filter(c => c.taskStatus !== "interrupted");

    const line = (c: (typeof crashedTasks)[number]) => {
      const timePart = c.finishedAt ? `, run ended ${formatTimeSince(c.finishedAt)}` : "";
      return `  ${theme.taskId(c.taskCode)} ${theme.status(c.taskStatus)} — ${c.runName} (${c.explanation}${timePart})`;
    };

    if (resumable.length > 0) {
      console.log("");
      console.log(theme.header("Interrupted tasks (resumable):"));
      for (const c of resumable) console.log(line(c));
      console.log("");
      // Exactly what the reconciler promises, and no more — same wording the
      // remedy prints. `maybeAutoResume` (src/utils/reconcile.ts) gates on
      // `user_stopped`, the MAX_CONSECUTIVE_INTERRUPTIONS circuit breaker and
      // the auto-react budget, so "the daemon resumes these on its own" is false
      // for precisely the tasks this flag exists for — a task held back by one
      // of those gates is the one a human wants to start by hand.
      console.log(
        `A running daemon re-offers these each tick; a ${theme.command("lazy stop")}, the ` +
        `interruption circuit breaker or the auto-react budget can veto it.`,
      );
      console.log(
        `To start their next turn now: ${theme.command("lazy doctor --resume-interrupted-tasks")}`,
      );
    }

    if (dead.length > 0) {
      console.log("");
      console.log(theme.header("Tasks whose run is gone:"));
      for (const c of dead) console.log(line(c));
    }
  }

  // People who never run doctor still need to see what it found. One alert
  // per distinct set of failures; an identical still-open message is reused.
  if (root && report.errorCount > 0) {
    try {
      await withDoctorStorage(root, storage => maybePostDoctorAlert(storage, report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Could not file inbox alert: ${message}`);
    }
  }

  // Summary
  const failures = results.filter(r => !r.ok);
  console.log("");
  if (failures.length === 0) {
    console.log(theme.success("All good! Lazy is ready to use."));
  } else {
    console.log(theme.error(`${failures.length} issue${failures.length > 1 ? "s" : ""} found.`));
    process.exit(1);
  }
}

/**
 * Offer to run `--fix agents` in place, when the config that would not parse is
 * one lazy can rewrite.
 *
 * The loader's refusal already prints the replacement block, and doctor already
 * names the flag — but a user reading a wall of migration text still has to
 * re-run a command to get out of it. Doctor is the surface for "my setup is
 * broken", so it asks. The posture is the same as the flag's own: default NO,
 * and the accepted path goes through `commandDoctorFixAgents` unchanged, so the
 * diff is still shown and still confirmed before anything is written. Nothing is
 * offered when the migration does not apply (`plan.needed` false — some other
 * TOML error), under `--dry-run`, or off a TTY.
 */
async function offerAgentMigration(root: string, opts: { yes: boolean; dryRun: boolean }): Promise<void> {
  if (opts.dryRun) return;
  let needed = false;
  try {
    const configPath = await resolveConfigPath(root);
    needed = planAgentMigration(await readFile(configPath, 'utf-8')).needed;
  } catch {
    // Unreadable or unplannable: the failed check above already says what is
    // wrong with the file, and an offer nobody can act on is worse than none.
    return;
  }
  if (!needed) return;
  console.log('');
  if (!isTTY() || opts.yes) {
    console.log(
      `lazy can rewrite this itself: ${theme.command('lazy doctor --fix agents')} ` +
      `(shows the diff and asks before writing).`,
    );
    return;
  }
  const proceed = await promptYesNo('Rewrite lazy.toml into agent profiles now?', false);
  if (!proceed) {
    console.log(`Left alone. Run ${theme.command('lazy doctor --fix agents')} when you are ready.`);
    return;
  }
  console.log('');
  await commandDoctorFixAgents(root, { yes: false });
}

export function doctorUsage(): void {
  console.log(`Usage: lazy doctor
       lazy doctor --clean-worktrees [--dry-run] [--yes]
       lazy doctor --clean-docker-images [--dry-run] [--yes]
       lazy doctor --clean-orphaned-containers [--dry-run] [--yes]
       lazy doctor --unset-upstream-tracking [--dry-run] [--yes]
       lazy doctor --resume-interrupted-tasks [--dry-run] [--yes]
       lazy doctor --clean-local-command-conversations [--delete-empty-local-command-conversations] [--dry-run] [--yes]
       lazy doctor --reimport-conversations [--yes]
       lazy doctor --purge-housekeeping-conversations [--yes]
       lazy doctor --import-memory [--yes]
       lazy doctor --fix agents [--yes]
       lazy doctor <task-id> [--dry-run] [--yes] [--probe-agent]

Check the health of your lazy installation, or diagnose a specific task.

A plain 'lazy doctor' only REPORTS: every remedy below is a flag you choose to
run. Each lists what it would touch, asks before acting (--yes to skip the
prompt, --dry-run to list and stop), and prints one line per item. Run one
remedy at a time.

Remedies:
  --clean-worktrees          Remove the worktrees of finished (complete/abandoned) tasks,
                             reclaiming build output and dependency trees. Branches are kept
  --clean-docker-images      Remove stale lazy runner images. Never touches the image in use,
                             an adopted image, or an image pinned on a task
  --clean-orphaned-containers
                             Remove lazy containers whose task no longer references them
  --unset-upstream-tracking  Drop leftover upstream tracking from lazy task branches
  --resume-interrupted-tasks Start the next turn of interrupted tasks now, instead of waiting
                             for the daemon's reconciler to pick them up
  --clean-local-command-conversations
                             Drop Claude Code's local-command scaffolding (the caveat, a
                             built-in slash command and its output) out of conversations
                             stored before lazy filtered it at import, so each listing
                             summary becomes the first real thing that was said. Deletes
                             nothing: a row left with no content is listed and left alone
  --delete-empty-local-command-conversations
                             Only with the flag above: also DELETE the stored conversations
                             that hold nothing but scaffolding. Never implied by --yes, asked
                             for separately, and permanent — a deleted row is not brought
                             back by --reimport-conversations

Options:
  --no-resume                Deprecated no-op — doctor never resumes tasks on its own
  --reimport-conversations   Recover builder conversations whose raw Claude logs are on
                             disk (shared ~/.claude/projects + per-builder isolation dirs)
                             but never reached the store; skips ones already imported
  --purge-housekeeping-conversations
                             Delete already-stored machine-generated lazy one-shots
                             (accept fidelity summaries, 'lazy report', memory
                             compaction, pairing summaries) from the conversation
                             store. Lists what it classified and deletes nothing
                             without --yes or an interactive confirmation. A ONE-TIME
                             cleanup: newer one-shots are marked at the source and
                             never reach the store
  --import-memory            Import Claude Code harness memory files (shared ~/.claude/projects
                             + per-builder isolation dirs) into lazy-owned shared memory;
                             skips records already present
  --fix agents               Rewrite lazy.toml from the removed role-backend config
                             ([models.roles.*] backend/model/endpoint, [ollama],
                             [proxy] openai_upstream) into [agents.<name>] profiles.
                             Shows the diff and asks first; --yes for scripts
  --dry-run                  List what a remedy would do and stop; in task mode, show task
                             issues without offering fixes
  --probe-agent              Task mode only: have the in-container doctor start a real
                             claude process to confirm the agent itself sees the lazy
                             tools. Off by default because it bills a model request
  --yes, -y                  Apply all fixes / skip the remedy, re-import, import-memory,
                             purge, or --fix confirmation prompt

Project-level checks (no task ID):
  - Git installed and functional
  - Repository has at least one commit
  - Docker installed and daemon running
  - Anthropic API key or OAuth token present in the DAEMON's environment
    (falls back to this shell's, saying so, when the daemon can't be asked)
  - Shell detected and completions installed
  - tmux installed (soft recommendation)
  - Data directory structure valid
  - Container image exists and up to date
  - No stale locks or orphaned containers
  - No split storage (when external storage is configured)
  - Recoverable builder conversations on disk but missing from the store
  - Stored conversations still listing Claude Code local-command scaffolding
  - Harness memory files on disk with no lazy shared-memory record
  - Injected memory context size vs [memory] warn_bytes (compact staleness + remedy)
  - Context budget: what every builder and task agent session starts with —
    CLAUDE.md files (and Claude Code's per-file size warning), lazy's system
    prompt, the shared memory index, the MCP tool schemas — with a total per role
  - Stale [protection].protected_tasks entries that gate nothing
  - Default-branch protection resolves to a real branch (not the "main" fallback)
  - [protection] gate keys configured while the master switch is off (inert)
  - Approval passphrase enrollment on this machine, and any leftover plaintext
    .lazy/approve-passphrase file from before it moved out of the repo
  - Tasks stranded in 'merging' by an accept that died
  - Interrupted tasks (resumable) and tasks whose run is gone — reported, never resumed
  - Worktrees still on disk for finished tasks, with the space they hold
  - Leftover upstream tracking on lazy task branches
  - Adequate disk space
  - Unknown or deprecated config options in lazy.toml
  - Remote driver health checks
  - Feature flags status and unknown flag warnings

Task-level checks (with task ID):
  - Stale parent (parent task is complete but child still points to it)
  - Missing local branch (session has a branch but it's gone locally)
  - Missing worktree (non-terminal task with no worktree directory)
  - Local/remote branch divergence
  - Status mismatch (task has work but status is still backlog)
  - Orphaned worktree (directory exists but not registered in git)
  - Agent MCP wiring, by running "lazy-agent doctor" inside the task's container and
    passing its output through (skipped, not failed, when there is no live container)

Exit code is 0 if all checks pass, 1 if any issues are found.${docsFooter('troubleshooting')}`);
}

