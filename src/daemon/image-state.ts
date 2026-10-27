/**
 * THE ONE ANSWER to "what is the project's image doing?" — exactly one state
 * at a time, decided here and nowhere else (AGENTS.md "`show` sends the
 * ANSWER, never the rule for a client to re-apply").
 *
 * Two trackers feed it and used to be rendered side by side: the project
 * image's build (./runner-image.ts) and an adoption's build
 * (./image-adoption.ts). After an admin confirmed an adoption, the page showed
 * BOTH "the project's image failed to build" and "Building Dockerfile.lazy from
 * …". The engineer's rule: either we adopted and are building, or we have not
 * adopted and need to decide what to adopt — never both. So the precedence is
 * fixed here:
 *
 *   1. adoption_in_progress — an adoption is exporting, verifying or building;
 *      whatever the project image did before is what it is replacing.
 *   2. adoption_failed      — the last adoption failed and nobody has moved on
 *      (a new adoption, a Rebuild, switching back, or dismissing it).
 *   3. building             — the project image (or the adopted one, after a
 *      machine replacement) is being checked or built.
 *   4. failed               — it failed, or its build was cancelled.
 *   5. adopted_in_force     — ready, and it is a ref adoption; `mainChanged`
 *      when the project branch's Dockerfile changed since.
 *   6. ready                — ready (or no custom image: lazy's default).
 *
 * Every failure state carries `escalation`: `admin` with the ways out the
 * admin can take, or `maintainer` when it is the machine's (god mode's)
 * problem. The ACTIONS are named, not described, so each surface renders its
 * own buttons and still cannot disagree about which apply.
 */
import { adoptionBuildStatus, adoptionJobStatus, refAdoptionView, type AdoptionBuildState } from './image-adoption';
import { describeRunnerImage, runnerImageStatus, runnerImageJob, defaultImageRebuildJob, type RunnerImageState } from './runner-image';
import type { ImageBuildJob } from './image-build-job';
import { logger } from '../utils/logger';
import { autoBuildsRootDockerfile } from '../config/managed-mode';
import { dockerdOomRemedy } from './guest-dockerd';
import { lostBuildOomFacts } from './build-connection-lost';

/** A way out of a failure, for the surface to render as a control. */
export type ImageAction =
  /** Build the project's image again (`rebuildRunnerImage`). */
  | 'rebuild'
  /** Adopt a Dockerfile.lazy from another branch or task (`imageAdoptionPreview` → `adoptImageFromRef`). */
  | 'adopt'
  /** Create a task whose agent fixes the Dockerfile (Teams' existing flow). */
  | 'create_fix_task'
  /** Drop the ref adoption; the project builds its own Dockerfile again (`clearImageAdoption`). */
  | 'switch_back'
  /** Put a failed adoption away and keep the current image (`dismissImageAdoptionFailure`). */
  | 'dismiss';

export type Escalation =
  | {
      to: 'admin';
      /** What went wrong, in one sentence. */
      summary: string;
      /** How to fix it, in one sentence. */
      howToFix: string;
      actions: ImageAction[];
    }
  | {
      to: 'maintainer';
      summary: string;
      /** Why it is not the admin's to fix. */
      why: string;
      /** Ways out that may still help (a retry once the machine is fixed). */
      actions: ImageAction[];
    };

/** The build a state is about, without its log (read that with `imageBuildLog`). */
export interface ImageBuildSummary {
  id: string;
  kind: 'project' | 'adoption';
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  progress: { step: number; total: number; label: string | null };
}

export interface ImageFailure {
  /** The step that failed, when one can be named. */
  step: string | null;
  /** That step's own output (or the error's detail). */
  output: string;
  /** The whole error. */
  error: string;
}

interface ImageRef {
  /** Concrete tag, including for the default runner. */
  tag?: string;
  /** The image name launches use, or lazy's default image. */
  name: string;
  /** Where its Dockerfile comes from, in words. */
  dockerfile: string | null;
  /** lazy's default image, which builders use while this one is not ready. */
  defaultImage: string | null;
  /** False when the project has no custom image and runs on lazy's default. */
  custom: boolean;
  /** The branch commit the image was last rebuilt from (the project image follows its acting branch); null before the first advance. */
  builtFrom: { branch: string; sha: string } | null;
}

interface AdoptionRef {
  ref: string;
  branch: string;
  commit: string;
}

export type ProjectImageState =
  | {
      state: 'building';
      image: ImageRef;
      /** `checking` while lazy is still deciding whether a build is needed at all. */
      phase: 'checking' | 'building';
      /** A Rebuild of a ready image: the current one stays in use meanwhile. */
      currentImageInUse: boolean;
      reason: string | null;
      build: ImageBuildSummary | null;
    }
  | {
      state: 'failed';
      image: ImageRef;
      failure: ImageFailure;
      cancelled: boolean;
      /** A failed Rebuild: the previous image is still the one launches use. */
      currentImageInUse: boolean;
      build: ImageBuildSummary | null;
      escalation: Escalation;
    }
  | {
      state: 'adoption_in_progress';
      adoption: AdoptionRef & { phase: string; startedAt: string };
      build: ImageBuildSummary | null;
    }
  | {
      state: 'adoption_failed';
      adoption: AdoptionRef & { failedStep: string; failedAt: string };
      failure: ImageFailure;
      build: ImageBuildSummary | null;
      escalation: Escalation;
    }
  | {
      state: 'adopted_in_force';
      image: ImageRef;
      adoption: AdoptionRef & {
        dockerfile: string;
        adoptedAt: string | null;
        adoptedBy: { email: string | null; name: string | null } | null;
        mainBranch: string | null;
      };
      /** The project branch's Dockerfile changed since the adoption: offer to switch back. */
      mainChanged: boolean;
      build: ImageBuildSummary | null;
    }
  | {
      state: 'ready';
      image: ImageRef;
      build: ImageBuildSummary | null;
    };

export type ProjectImageStateName = ProjectImageState['state'];

/** Every state name, in precedence order — the closed set the surfaces render. */
export const PROJECT_IMAGE_STATES: readonly ProjectImageStateName[] = [
  'adoption_in_progress', 'adoption_failed', 'building', 'failed', 'adopted_in_force', 'ready',
];

function summarize(job: ImageBuildJob | null): ImageBuildSummary | null {
  if (!job) return null;
  const v = job.view();
  return {
    id: v.id, kind: v.kind, outcome: v.outcome, startedAt: v.startedAt, finishedAt: v.finishedAt,
    durationMs: v.durationMs, progress: v.progress,
  };
}

/** The job with `id`, if it is the one given. */
function jobFor(job: ImageBuildJob | null, id: string | null | undefined): ImageBuildJob | null {
  return job && id && job.id === id ? job : null;
}

/** Errors that are the MACHINE's, not the Dockerfile's — matched on what docker and lazy print. */
const MACHINE_FAILURE = [
  /Cannot connect to the Docker daemon/i,
  /Is the docker daemon running/i,
  /docker daemon is not running/i,
  /Docker (?:is )?not running/i,
  /no space left on device/i,
  /did not finish within/i,
  /timed out after/i,
  /error during connect/i,
  // A build that lost its connection to Docker (BuildKit's EOF), and lazy's
  // diagnosis of it: the machine's runtime, never the Dockerfile.
  /lost its connection to Docker/i,
  /error reading from server: EOF/i,
];

/**
 * Whose problem a failed build is. A step of the PROJECT's Dockerfile failing
 * is the admin's (fix it, adopt another, rebuild); the container runtime being
 * unreachable, the disk full, lazy's own base image failing to build, or the
 * build being killed on a timer are the machine's — the maintainer's.
 */
export function buildFailureEscalation(
  failure: ImageFailure,
  opts: { failedImage: string | null; defaultImage: string | null; adopted: boolean },
): Escalation {
  const actions: ImageAction[] = opts.adopted ? ['rebuild', 'adopt', 'create_fix_task', 'switch_back'] : ['rebuild', 'adopt', 'create_fix_task'];
  // When BuildKit named the failing step, the failure happened INSIDE a
  // Dockerfile step, and only a full disk there is the machine's — a step's
  // own output saying "timed out after" is the step's business.
  const text = failure.step ? failure.output : `${failure.error}\n${failure.output}`;
  const machine = failure.step ? [/no space left on device/i] : MACHINE_FAILURE;
  if (machine.some((re) => re.test(text))) {
    // dockerd killed for memory has a remedy a project admin can start
    // (reset Docker storage), so it is the admin's, not "report to support".
    // (A non-dockerd OOM kill while Docker survived stays the maintainer's:
    // storage reset is not its remedy.)
    const oom = failure.step ? null : lostBuildOomFacts(text);
    if (oom) {
      return {
        to: 'admin',
        summary: `The build was lost because ${oom.sentence}.`,
        howToFix: dockerdOomRemedy(),
        actions: ['rebuild'],
      };
    }
    return {
      to: 'maintainer',
      summary: 'The build could not run on this project\'s machine.',
      why: 'The machine\'s container runtime failed (it is not running, out of disk, or the build was stopped on a timer) — nothing in the Dockerfile can fix that.',
      actions: ['rebuild'],
    };
  }
  const baseImage = opts.defaultImage?.split(':')[0];
  if (opts.failedImage && baseImage && opts.failedImage.split(':')[0] === baseImage) {
    return {
      to: 'maintainer',
      summary: 'lazy\'s own base image failed to build, before the project\'s Dockerfile ran.',
      why: 'The base image is lazy\'s, not the project\'s; a project admin cannot change it.',
      actions: ['rebuild'],
    };
  }
  return {
    to: 'admin',
    summary: failure.step ? `A step of the Dockerfile failed: ${failure.step}` : 'The Dockerfile failed to build.',
    howToFix: 'Fix the Dockerfile in a task (its agent can test-build it), adopt a working Dockerfile.lazy from another branch or task, or build again if the failure looks transient.',
    actions,
  };
}

function failureOf(job: ImageBuildJob | null, error: string): ImageFailure {
  const f = job?.failure;
  return f ? { step: f.stepLabel, output: f.output, error: f.error } : { step: null, output: error, error };
}

/** The image a job's failing docker step belonged to. */
function failedImageOf(job: ImageBuildJob | null): string | null {
  const id = job?.failure?.stepId;
  return id ? job!.steps.find((s) => s.id === id)?.image ?? null : null;
}

function imageRef(s: Exclude<RunnerImageState, { state: 'none' }>): ImageRef {
  return { name: s.imageName, dockerfile: s.dockerfile, defaultImage: s.defaultImage, custom: true, builtFrom: s.state !== 'checking' ? s.builtFrom ?? null : null };
}

function adoptionFailedEscalation(a: Extract<AdoptionBuildState, { state: 'failed' }>, failure: ImageFailure, job: ImageBuildJob | null, defaultImage: string | null): Escalation {
  if (a.failedStep === 'build') {
    const e = buildFailureEscalation(failure, { failedImage: failedImageOf(job), defaultImage, adopted: false });
    // Trying again means adopting again (not rebuilding the project's own
    // image), and the project keeps its image after a failed adoption, so
    // putting the failure away is always a way out.
    return { ...e, actions: e.actions.includes('create_fix_task') ? ['adopt', 'create_fix_task', 'dismiss'] : ['adopt', 'dismiss'] };
  }
  return {
    to: 'maintainer',
    summary: a.failedStep === 'verify'
      ? 'The exported Dockerfile did not match the one you confirmed.'
      : a.failedStep === 'export'
        ? `${a.branch}'s files could not be exported on this project's machine.`
        : 'The adoption built but could not be recorded on this project\'s machine.',
    why: 'This step reads and writes the machine\'s own copy of the repository; a failure there is the machine\'s, not the Dockerfile\'s.',
    actions: ['adopt', 'dismiss'],
  };
}

/** A ref adoption that can no longer be rebuilt (its commit is gone, or origin unreachable). */
function unavailableAdoptionEscalation(error: string): Escalation {
  if (/could not fetch|did not finish within|once origin is reachable/i.test(error)) {
    return {
      to: 'maintainer',
      summary: 'The adopted Dockerfile\'s commit is not on this machine, and origin could not be reached to fetch it.',
      why: 'Reaching the project\'s git remote from the machine is infrastructure.',
      actions: ['rebuild', 'adopt', 'switch_back'],
    };
  }
  return {
    to: 'admin',
    summary: 'The adopted Dockerfile\'s commit no longer exists, so its image cannot be rebuilt.',
    howToFix: 'Adopt a Dockerfile.lazy from another branch or task, fix it in a task, or switch back to the project\'s own file.',
    actions: ['adopt', 'create_fix_task', 'switch_back'],
  };
}

/**
 * Only the ways out this install can take: where an adoption is refused (a
 * dockerd shared with other projects, `autoBuildsRootDockerfile` false) the
 * panel must not offer one that `adoptImageFromRef` would answer with a 409.
 */
function available(e: Escalation): Escalation {
  return autoBuildsRootDockerfile() ? e : { ...e, actions: e.actions.filter((a) => a !== 'adopt') };
}

/**
 * The project's image state — the single function every surface's answer
 * comes from (the `runnerImage` RPC carries it as `imageState`).
 */
export async function projectImageState(
  projectRoot: string,
  /** The ref adoption view when the caller already read it (`refAdoptionView` runs git). */
  known?: { adoptionView: Awaited<ReturnType<typeof refAdoptionView>> },
): Promise<ProjectImageState> {
  const adoption = adoptionBuildStatus();
  const aJob = adoptionJobStatus();
  const project = runnerImageStatus();
  const pJob = runnerImageJob();
  const defaultImage = project.state === 'none' ? null : project.defaultImage;

  if (adoption.state === 'building') {
    return {
      state: 'adoption_in_progress',
      adoption: { ref: adoption.ref, branch: adoption.branch, commit: adoption.commit, phase: adoption.phase, startedAt: adoption.startedAt },
      build: summarize(jobFor(aJob, adoption.buildId)),
    };
  }
  if (adoption.state === 'failed') {
    const job = jobFor(aJob, adoption.buildId);
    const failure = failureOf(job, adoption.error);
    return {
      state: 'adoption_failed',
      adoption: { ref: adoption.ref, branch: adoption.branch, commit: adoption.commit, failedStep: adoption.failedStep, failedAt: adoption.failedAt },
      failure,
      build: summarize(job),
      escalation: available(adoptionFailedEscalation(adoption, failure, job, defaultImage)),
    };
  }

  // The ref adoption in force, when there is one — `adopted_in_force` and the
  // `switch_back` way out depend on it. Unreadable is answered as "none" and
  // logged: the state is still exactly one of the rest.
  const view = known ? known.adoptionView : await refAdoptionView(projectRoot).catch((err) => {
    logger.warn(`Image state: could not read the image adoption: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  if (project.state === 'checking' || project.state === 'building') {
    return {
      state: 'building',
      image: imageRef(project),
      phase: project.state,
      currentImageInUse: project.state === 'building' && project.replacing === true,
      reason: project.state === 'building' ? project.reason : project.waitingForEngine ? describeRunnerImage(project) : null,
      build: summarize(jobFor(pJob, project.buildId)),
    };
  }
  if (project.state === 'failed') {
    const job = jobFor(pJob, project.buildId);
    const failure = failureOf(job, project.error);
    const unavailable = project.adoptionUnavailable === true;
    const escalation: Escalation = project.cancelled
      ? {
          to: 'admin',
          summary: 'The build was cancelled before it finished.',
          howToFix: 'Build it again when you are ready, or adopt a Dockerfile.lazy from another branch or task.',
          actions: view ? ['rebuild', 'adopt', 'switch_back'] : ['rebuild', 'adopt', 'create_fix_task'],
        }
      : unavailable
        ? unavailableAdoptionEscalation(project.error)
        : buildFailureEscalation(failure, { failedImage: failedImageOf(job), defaultImage, adopted: view !== null });
    return {
      state: 'failed',
      image: imageRef(project),
      failure,
      cancelled: project.cancelled === true,
      currentImageInUse: project.replacing === true,
      build: summarize(job),
      escalation: available(escalation),
    };
  }
  if (project.state === 'ready' && view) {
    return {
      state: 'adopted_in_force',
      image: imageRef(project),
      adoption: {
        ref: view.ref, branch: view.branch, commit: view.commit, dockerfile: view.dockerfile,
        adoptedAt: view.adoptedAt ?? null, adoptedBy: view.adoptedBy ?? null, mainBranch: view.mainBranch,
      },
      mainChanged: view.mainChanged,
      build: summarize(jobFor(pJob, project.buildId)),
    };
  }
  if (project.state === 'ready') {
    return { state: 'ready', image: imageRef(project), build: summarize(jobFor(pJob, project.buildId)) };
  }
  // A project on lazy's default image: the build shown is a running Rebuild of
  // that image (a project admin's way out of a broken one), if any.
  const { resolveImageRepository, IMAGE_TAG } = await import('../capture/claude');
  const { repository } = await resolveImageRepository(projectRoot, true);
  return { state: 'ready', image: { name: 'lazy\'s default runner image', tag: `${repository}:${IMAGE_TAG}`, dockerfile: null, defaultImage: null, custom: false, builtFrom: null }, build: summarize(defaultImageRebuildJob()) };
}
