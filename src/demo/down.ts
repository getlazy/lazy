/**
 * `lazy playground down` — stop the demo daemon and remove everything it created.
 *
 * Teardown is ORDERED and the order is the whole point: stop the daemon FIRST,
 * then delete the root. Deleting first leaves a daemon running against paths
 * that no longer exist — it holds its port, keeps answering, and the next
 * `lazy playground up` starts a second one. That is the leak this command exists to
 * prevent, and the reason it is a command rather than "just `rm -rf`".
 *
 * It is also the one place in lazy that recursively deletes a directory the
 * CALLER named, so it refuses before it removes: see `safety.ts` for the shape
 * check and the manifest marker, both of which run here and therefore also run
 * inside `lazy playground up`, which tears down before it provisions.
 */

import { readFile, rm, stat } from 'fs/promises';
import { demoPaths, readManifest, MANIFEST_VERSION, type DemoManifest, type DemoPaths } from './paths';
import { reapDemoProcesses } from './reap';
import { assertRootIsOwnable, classifyRoot, foreignRootMessage } from './safety';
import { stopTeamsServer, teamsEnv, demoTeamsPaths } from './teams';
import { runDemoFleet } from './fleet';
import { dirname, join } from 'path';
import { spawnSyncUnsupervised } from '../utils/spawn';
import {
  agentBinDir, allowlistedEnv, demoEnv, lazyTry, resolveLazyInvocation, withDemoDaemonBase,
} from './runtime';

export interface DemoDownOptions {
  root?: string;
  report: (message: string) => void;
  /**
   * Suppress "there was nothing to tear down" reporting.
   *
   * Set by `lazy playground up`, which always tears down first and for which an empty
   * root is the normal case rather than something worth saying.
   */
  quiet?: boolean;
}

export interface DemoDownResult {
  /** Whether anything was there to remove. */
  removed: boolean;
  root: string;
}

export async function takeDemoEnvironmentDown(options: DemoDownOptions): Promise<DemoDownResult> {
  const paths = demoPaths(options.root);

  // Shape first, and before anything is read: this one holds even for a root
  // that does not exist, and it is the check that catches `--root ~`.
  assertRootIsOwnable(paths.root);

  const kind = await classifyRoot(paths);

  if (kind.kind === 'absent' || kind.kind === 'empty') {
    // Nothing of ours, and nothing to remove. An empty directory is left where
    // it is — we did not create it, so it is not ours to delete either.
    if (!options.quiet) options.report(`nothing at ${paths.root}`);
    return { removed: false, root: paths.root };
  }

  if (kind.kind === 'foreign') {
    // The refusal that makes `--root` safe to offer. It throws rather than
    // returning, because every caller — including `up`, which is about to
    // provision — must stop here.
    throw new Error(foreignRootMessage(paths.root, kind.entries, 'tear down'));
  }

  await withDemoDaemonBase(paths.daemonBase, async () => {
    // `classifyRoot` has already read this manifest, parsed it, and checked its
    // version and root — that is what authorised the removal below. So it
    // cannot fail here, and the `.catch` is defensiveness rather than a
    // recovery path: a teardown that throws while reading a file would leave
    // the daemon running, which is the one outcome this command exists to
    // prevent.
    //
    // There used to be a salvage here that pulled a Teams pid out of an
    // unparseable manifest. It was dead code from the moment the marker started
    // being validated — an unparseable manifest is now refused by
    // `classifyRoot` several lines above, so nothing could reach it — and its
    // comment confidently described a rescue that could never run.
    const manifest = await readManifest(paths).catch(() => null);

    if (manifest?.teams) {
      options.report('stopping the playground Teams app');
      await stopTeamsServer(manifest.teams);
    }

    // The fleet demo's machine, AFTER the server: with Puma gone the reconciler
    // cannot race the teardown and revive what is being deleted. Never skipped
    // and never silent — a VM left behind holds a published port and a copy of
    // the store, which is the leak `--fleet` must not add to this command.
    if (manifest?.fleet) {
      await tearDownFleet(manifest, paths, options.report);
    }

    const env = demoEnv({ paths });

    // `lazy daemon stop` runs IN the demo project, so it needs that directory
    // to exist. It may not, if an `up` died before the fixture was created.
    // Spawning into a missing cwd fails the whole teardown, which in `up`'s
    // case means that root could never be provisioned again.
    if (await pathExists(paths.repo)) {
      // Best effort otherwise: the daemon may already be gone. That is not a
      // reason to leave the directory behind — but the stop is ATTEMPTED before
      // the delete whenever it can be, which is the part that matters.
      options.report('stopping the playground daemon');
      await lazyTry(resolveLazyInvocation(), ['daemon', 'stop'], {
        cwd: paths.repo, env, timeoutMs: 60_000,
      });
    }
  });

  // The daemon is down, but the demo deliberately leaves a task mid-turn and
  // that turn's agent outlives it. Sweep before deleting: an agent process
  // running against a directory that no longer exists is the leak this command
  // exists to prevent.
  const reaped = await reapDemoProcesses(paths);
  if (reaped.length > 0) {
    options.report(`stopped ${reaped.length} leftover playground process${reaped.length === 1 ? '' : 'es'}`);
  }

  options.report(`removing ${paths.root}`);
  await rm(paths.root, { recursive: true, force: true });

  return { removed: true, root: paths.root };
}

/**
 * Delete the fleet demo's machine through the supervisor that made it
 * (`DemoFleet.teardown!` → `SmolvmSupervisor#destroy` → `machine delete`), and
 * if Rails cannot run — a broken bundle, a database the previous boot never
 * finished — fall back to the smolvm launcher directly, from the binary and the
 * machine name the manifest recorded. Both paths are attempted before the root
 * is removed; neither failing stops the removal, but both failing is REPORTED
 * with the command to run by hand, because a machine that outlives its demo is
 * exactly what this exists to prevent.
 */
async function tearDownFleet(
  manifest: DemoManifest, paths: DemoPaths, report: (message: string) => void,
): Promise<void> {
  const fleet = manifest.fleet!;
  const sourceRoot = dirname(dirname(manifest.lazyEntry));
  const appDir = join(sourceRoot, 'lazy-teams');
  const { storageDir, fleetRoot } = demoTeamsPaths(paths.root);

  report(`deleting the fleet machine${fleet.machine ? ` ${fleet.machine}` : ''}`);
  try {
    const env = teamsEnv({
      sourceRoot, storageDir, fleetRoot,
      mode: {
        kind: 'fleet',
        inputs: {
          backend: fleet.backend, smolvmBinary: fleet.smolvmBinary, daemonImage: fleet.daemonImage,
          repo: fleet.repo, servePort: fleet.servePort, memoryMib: fleet.memoryMib ?? null, model: fleet.model ?? null,
          // The credential is not needed to tear down and is not in the manifest.
          credential: { kind: 'api_key', value: '', envVar: fleet.credentialEnvVar },
        },
        onProgress: async () => {},
      },
      home: process.env.HOME ?? paths.home,
    });
    const result = await runDemoFleet(appDir, env, 'teardown', {}, 600_000);
    if (result.removed === true) return;
    if (!fleet.machine) return; // never provisioned: nothing to delete
  } catch (err) {
    report(`Rails could not tear the machine down (${(err as Error).message.split('\n')[0]}); trying smolvm directly`);
  }

  if (!fleet.machine) return;
  const direct = spawnSyncUnsupervised(
    [fleet.smolvmBinary, 'machine', 'delete', '--name', fleet.machine, '--force'],
    {
      timeout: 120_000, stdout: 'pipe', stderr: 'pipe',
      // The allowlist plus what smolvm itself needs: HOME for its machine
      // registry (the human's, as the fleet boot used), and the two fixed
      // variables the supervisor sets on every invocation.
      env: { ...allowlistedEnv(), HOME: process.env.HOME ?? paths.home, SMOLVM_EGRESS_FLOOR: 'strict', SMOLVM_PUBLISH_ADDR: '127.0.0.1' },
    },
  );
  if (direct.exitCode === 0) return;
  report(
    `WARNING: the machine ${fleet.machine} may still exist. Delete it yourself, on the host (any directory):\n` +
    `  "${fleet.smolvmBinary}" machine delete --name ${fleet.machine} --force\n` +
    `smolvm said: ${direct.stderr.toString().trim() || direct.stdout.toString().trim() || `exit ${direct.exitCode}`}`,
  );
}

/** Does this path exist? Absence is an answer here, never an error. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
