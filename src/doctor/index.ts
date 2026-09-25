/**
 * Doctor — the shared health-report module.
 *
 * Checks live here so the daemon can run them without importing `src/cli/`.
 * `lazy doctor` is a thin client of `runDoctorReport`; the daemon exposes the
 * same report over `doctor.run` / `doctor.report`. Presentation (colours,
 * prompts, process.exit) stays in the CLI.
 */

export type {
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
  DoctorReport,
  DoctorRunOptions,
  MissingRun,
  StoredDoctorReport,
} from './types';

export {
  buildReport,
  checkIdFromLabel,
  runChecks,
  statusOf,
  toStructuredCheck,
} from './registry';

export {
  checkAdoptedImage,
  checkStaleLazyImages,
  explainExitCode,
  formatTimeSince,
  printContextBudget,
  runDoctorReport,
  type DoctorSweepResult,
} from './sweep';

export {
  DOCTOR_ALERT_SOURCE,
  DOCTOR_ALERT_TITLE,
  doctorAlertBody,
  errorChecks,
  isDuplicateDoctorAlert,
  maybePostDoctorAlert,
} from './alert';

export {
  DOCTOR_LOCK_TIMEOUT_MS,
  openDoctorStorage,
  withDoctorStorage,
} from './storage';

export {
  DOCTOR_REMEDY_FLAGS,
  DESTRUCTIVE_REMEDY_FLAGS,
  applyRemedy,
  isDestructiveRemedy,
  isDoctorRemedyFlag,
  previewRemedy,
  remedyTitle,
  type DoctorRemedyFlag,
  type DoctorRemedyPreview,
  type DoctorRemedyProgressEvent,
  type DoctorRemedyResult,
  type RemedyContext,
} from './remedies';
