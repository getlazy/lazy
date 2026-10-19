/**
 * Self-repair of a runner image whose layers Docker can no longer read back.
 *
 * Seen in the field (2026-10-14/15, a Teams microVM): `docker run` of the
 * project's runner image failed with `apply layer error for "": failed to
 * extract layer sha256:…: archive/tar: invalid tar header`, first when a
 * builder started and the next day when a member's feedback launched a turn.
 * The image is present, but a layer's stored content is torn, so every
 * container created from it fails the same way until the image is replaced.
 *
 * The repair is deliberately narrow:
 *   1. `docker image rm <that image>` — that one tag. Docker refuses (we never
 *      force) while a container uses it. Content is deleted only when no
 *      other tag still names the image, and lazy's default image carries
 *      others (`:latest`, the published ref), so there this only untags. No
 *      volume, no other image, no container, no prune.
 *   2. rebuild it without the cache (the caller's `rebuild`: the daemon's own
 *      build of that image), which writes fresh layers for every build step.
 *      That is what actually repairs it;
 *   3. the caller retries its launch ONCE.
 * A torn layer the rebuild REUSES — the Dockerfile's FROM base, which a
 * no-cache build does not re-pull — is not repaired: the retry fails the same
 * way. Then, or when the image cannot be removed or rebuilt, the error says
 * so and keeps Docker's own words, which is what the Teams banner reads to
 * offer the full "Reset Docker storage", the escalation.
 *
 * Zero imports from claude.ts: it is handed its docker and build steps, which
 * is also the test seam (test/unit/damaged-image.test.ts).
 */

import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';

/**
 * Docker's words for a layer it cannot extract. Read off real messages (the
 * engineer's `docker run` on the guest, 2026-10-14/15); keep in step with
 * lazy-teams/app/models/environment_breakage.rb DAMAGED_STORE, which picks
 * the escalation banner from the same text.
 */
const DAMAGED_LAYER_PATTERNS: RegExp[] = [
  /failed to extract layer/i,
  /invalid tar header/i,
  /apply layer error for/i,
  /layer does not exist/i,
  /unexpected EOF[^\n]*(extract|layer|\btar\b)/i,
];

/**
 * Causes that make Docker print the same "failed to extract layer" for a layer
 * that is perfectly fine: the disk is full or cannot be written. Removing the
 * image there deletes the project's only image, and the rebuild then fails on
 * the same full disk — so these are never treated as a damaged layer. Keep in
 * step with the machine failures in src/daemon/image-state.ts.
 */
const NOT_A_DAMAGED_LAYER: RegExp[] = [
  /no space left on device/i,
  /\bENOSPC\b/,
  /disk quota exceeded/i,
  /input\/output error/i,
  /\bEIO\b/,
  /read-only file system/i,
];

export function isDamagedLayerError(text: string): boolean {
  if (NOT_A_DAMAGED_LAYER.some((re) => re.test(text))) return false;
  return DAMAGED_LAYER_PATTERNS.some((re) => re.test(text));
}

/** A launch failed because `imageName`'s stored layers cannot be extracted. */
export class DamagedImageError extends Error {
  constructor(readonly imageName: string, readonly dockerMessage: string) {
    super(dockerMessage);
    this.name = 'DamagedImageError';
  }
}

/** What a repair did, for the person who asked and for the project's record. */
export interface DamagedImageRepairEvent {
  /** `repaired` = removed and rebuilt, launch retried; `failed` = the targeted repair could not help. */
  outcome: 'repaired' | 'failed';
  imageName: string;
  /** What was being launched: "task", "builder". */
  subject: string;
  /** The task (code or id) whose launch hit it, when there is one. */
  taskId?: string;
  /** Docker's own message from the failed launch. */
  dockerMessage: string;
  /**
   * For `failed`: why the repair did not help. For `repaired`: set only when the
   * rebuilt image started but the retried launch failed for an unrelated reason.
   */
  error?: string;
  /**
   * What was found BEFORE the repair removed anything: the failing blob and
   * what else was going on (src/docker/damaged-image-evidence.ts). Bounded, and
   * printable text in the blob is withheld.
   */
  evidence?: string;
  /** A launch hit damage whose repair already failed: no new attempt was made. */
  repeat?: boolean;
}

type Reporter = (event: DamagedImageRepairEvent) => Promise<void>;
let reporter: Reporter | null = null;

/**
 * The daemon registers where repairs are recorded (the task's journal and a
 * system message). Outside the daemon nothing is registered, and the repair
 * is only logged and narrated.
 */
export function setDamagedImageReporter(r: Reporter | null): void {
  reporter = r;
}

async function report(event: DamagedImageRepairEvent): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(event);
  } catch (err) {
    // The record is secondary to the launch it describes: say so in the log.
    logger.warn(`Could not record the repair of image ${event.imageName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface DamagedImageRepairDeps {
  binary: string;
  /**
   * Whether lazy may rebuild `imageName` by itself: lazy's default image or
   * the project's own image. A task-pinned or adopted image is a person's
   * choice, so its repair stops at telling them — and it is never removed.
   */
  canRebuild: (imageName: string) => Promise<boolean>;
  /** Rebuild `imageName` without the build cache. */
  rebuild: (imageName: string) => Promise<unknown>;
  /**
   * Capture the evidence of a damaged image before it is removed. Optional:
   * outside the daemon nothing records it.
   */
  collectEvidence?: (imageName: string, dockerMessage: string) => Promise<string>;
}

/** How long evidence collection may hold up the repair (it hashes and decodes the blob once). */
const EVIDENCE_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** One repair per image at a time: concurrent launches wait on the same one. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Repairs that did not help, per image and Docker message. A launch that still
 * fails is parked `interrupted` and auto-resume relaunches it many times; each
 * relaunch must not run another no-cache rebuild (the build that OOM-killed
 * dockerd) and file another alert. Forgotten when a launch of the image
 * is repaired, when someone asks for a rebuild of it, or when the daemon restarts.
 */
const failedRepairs = new Map<string, Map<string, FailedRepair>>();

interface FailedRepair {
  /** Why the repair did not help, for the message a later launch gets. */
  why: string;
  /** Whether lazy removed and rebuilt the image (false: it never got that far). */
  rebuilt: boolean;
}

/**
 * The same damage, whichever launch hit it: the failing layer's digest when
 * Docker names one, otherwise Docker's text with lazy's own prefix ("Failed to
 * launch supervisor container: …", "Failed to start detached builder session
 * (exit N): …") stripped — so a task launch, the agent probe and a builder
 * share one entry instead of each repairing again.
 */
export function damageSignature(dockerMessage: string): string {
  const digest = /sha256:[0-9a-f]+/i.exec(dockerMessage);
  if (digest) return digest[0].toLowerCase();
  return dockerMessage.replace(/^Failed to (?:launch supervisor container|start detached builder session(?: \(exit [^)]*\))?):\s*/i, '').trim();
}

function rememberFailedRepair(binary: string, imageName: string, failure: FailedRepair, ...messages: string[]): void {
  const key = `${binary}\0${imageName}`;
  const known = failedRepairs.get(key) ?? new Map<string, FailedRepair>();
  for (const m of messages) known.set(damageSignature(m), failure);
  failedRepairs.set(key, known);
}

/**
 * Forget the failed repairs of `imageName` (every binary): a person asked for
 * it to be rebuilt, so the next damaged-layer failure is worth repairing again.
 */
export function forgetFailedDamagedImageRepair(imageName: string): void {
  for (const key of [...failedRepairs.keys()]) if (key.endsWith(`\0${imageName}`)) failedRepairs.delete(key);
}

/**
 * Remove `imageName` and rebuild it. Throws, naming the step, when either
 * cannot be done. Single-flight per image.
 */
export function repairDamagedImage(
  imageName: string,
  deps: DamagedImageRepairDeps,
  notify?: (detail: string) => void,
  /** Run first, by the launch that starts the repair only (evidence collection). */
  leaderFirst?: () => Promise<void>,
): Promise<void> {
  const key = `${deps.binary}\0${imageName}`;
  const running = inFlight.get(key);
  if (running) {
    notify?.(`waiting for the repair of image ${imageName} that is already running`);
    return running;
  }
  const work = (async () => {
    if (leaderFirst) await leaderFirst();
    // Asked before anything is removed: an image lazy may not rebuild is
    // never deleted, or the repair would leave nothing to run at all.
    if (!(await deps.canRebuild(imageName))) {
      throw new Error(`${imageName} is a task-pinned or adopted image, which lazy does not rebuild by itself`);
    }
    notify?.(`removing the damaged image ${imageName}`);
    await removeImage(deps.binary, imageName);
    notify?.(`rebuilding ${imageName} without the build cache`);
    await deps.rebuild(imageName);
  })();
  inFlight.set(key, work);
  const clear = () => { if (inFlight.get(key) === work) inFlight.delete(key); };
  work.then(clear, clear);
  return work;
}

/**
 * `docker image rm <name>` — never `--force`, never `prune`, never a volume.
 * Docker removes only content nothing else references and refuses outright
 * while a container uses the image; that refusal is reported, not overridden.
 */
async function removeImage(binary: string, imageName: string): Promise<void> {
  const proc = spawn([binary, 'image', 'rm', imageName], { stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return;
  const said = stderr.trim();
  // Already gone is what we wanted.
  if (/no such image/i.test(said)) return;
  throw new Error(`could not remove the damaged image ${imageName} (\`${binary} image rm\` exit ${exitCode}): ${said || 'no output'}`);
}

export interface DamagedImageLaunchContext extends DamagedImageRepairDeps {
  /** "task", "builder" — used in narration ("The task's image was damaged…"). */
  subject: string;
  taskId?: string;
  notify?: (detail: string) => void;
}

/**
 * Run `launch`; if it fails with a {@link DamagedImageError}, repair that
 * image and run `launch` exactly once more. A second damaged-layer failure,
 * or a failed repair, is thrown with Docker's original message kept and the
 * repair's outcome added — never a second repair, never a loop. A repair
 * that did not help is remembered per image and error, so a relaunch of the
 * same failure (auto-resume) does not rebuild again: it fails at once.
 */
export async function withDamagedImageRepair<T>(ctx: DamagedImageLaunchContext, launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (err) {
    if (!(err instanceof DamagedImageError)) throw err;
    return repairAndRetry(ctx, launch, err);
  }
}

async function repairAndRetry<T>(ctx: DamagedImageLaunchContext, launch: () => Promise<T>, err: DamagedImageError): Promise<T> {
  const { imageName, dockerMessage } = err;
  const key = `${ctx.binary}\0${imageName}`;
  const known = failedRepairs.get(key)?.get(damageSignature(dockerMessage));
  if (known) {
    // Already tried for this image and this damage, and it did not help: no
    // second rebuild, no evidence (the blob is the one already recorded), and
    // the record is a repeat — it collapses into the open alert and adds no
    // journal entry.
    const why = known.rebuilt
      ? `lazy already removed and rebuilt this image for the same damage and it did not help (${known.why}), so it was not rebuilt again`
      : `lazy already tried to repair this image for the same damage and could not (${known.why}), so it did not try again`;
    logger.warn(`Image ${imageName} is still damaged; not repairing it again (docker said: ${dockerMessage})`);
    await report({ imageName, subject: ctx.subject, dockerMessage, outcome: 'failed', error: why, repeat: true, ...(ctx.taskId ? { taskId: ctx.taskId } : {}) });
    const rebuildable = await ctx.canRebuild(imageName).catch(() => false);
    throw new Error(
      `${dockerMessage}\n\n${why}. Docker's storage on this machine needs a reset (Reset Docker storage)` +
      (rebuildable ? ', or a project admin can Rebuild the image to try the repair again.' : '.'),
    );
  }
  const announce = `The ${ctx.subject}'s image was damaged; rebuilding it, then retrying`;
  logger.warn(`${announce} (image ${imageName}; docker said: ${dockerMessage})`);
  ctx.notify?.(announce);

  // The evidence, BEFORE anything is removed: once the repair runs, the
  // damaged blob is gone and the next occurrence would again be a mystery.
  // The launch that starts the repair collects it inside the single flight,
  // which it claims before its first await, so a joining launch never does.
  let evidence: string | undefined;
  const collect = ctx.collectEvidence
    ? async () => {
        ctx.notify?.('recording what the damaged image looks like before it is removed');
        evidence = await withTimeout(ctx.collectEvidence!(imageName, dockerMessage), EVIDENCE_TIMEOUT_MS)
          .catch((e: unknown) => `Evidence could not be collected: ${e instanceof Error ? e.message : String(e)}`);
      }
    : undefined;
  const baseOf = () => ({
    imageName, subject: ctx.subject, dockerMessage,
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(evidence ? { evidence } : {}),
  });

  try {
    await repairDamagedImage(imageName, ctx, ctx.notify, collect);
  } catch (repairErr) {
    const why = repairErr instanceof Error ? repairErr.message : String(repairErr);
    rememberFailedRepair(ctx.binary, imageName, { why, rebuilt: false }, dockerMessage);
    await report({ ...baseOf(), outcome: 'failed', error: why });
    throw new Error(
      `${dockerMessage}\n\nlazy tried to repair the damaged image ${imageName} by itself (remove it and rebuild it), ` +
      `and that did not work: ${why}`,
    );
  }

  ctx.notify?.(`image ${imageName} rebuilt; retrying the ${ctx.subject} launch`);
  try {
    const result = await launch();
    failedRepairs.delete(key);
    await report({ ...baseOf(), outcome: 'repaired' });
    return result;
  } catch (retryErr) {
    const why = retryErr instanceof Error ? retryErr.message : String(retryErr);
    if (!(retryErr instanceof DamagedImageError)) {
      // The image was rebuilt and Docker could read it this time: the repair
      // worked, and the launch failed for a reason of its own, rethrown as is.
      await report({ ...baseOf(), outcome: 'repaired', error: `the retried launch then failed for another reason: ${why}` });
      throw retryErr;
    }
    rememberFailedRepair(ctx.binary, imageName, { why: 'the relaunch failed the same way', rebuilt: true }, dockerMessage, retryErr.dockerMessage);
    await report({ ...baseOf(), outcome: 'failed', error: why });
    throw new Error(
      `${retryErr.dockerMessage}\n\nlazy removed and rebuilt the damaged image ${imageName} by itself and the launch ` +
      `still failed the same way, so the damage is outside that image: Docker's storage on this machine needs a reset.`,
    );
  }
}

/** Test-only: forget repairs in flight. */
export function resetDamagedImageRepairForTests(): void {
  inFlight.clear();
  failedRepairs.clear();
  reporter = null;
}
