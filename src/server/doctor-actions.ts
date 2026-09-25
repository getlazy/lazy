/**
 * The port through which the web Settings page runs doctor and its remedies.
 *
 * Same shape as `MemoryActions`: the web handler never opens Storage for a
 * write, never runs the sweep itself, and never shells out to `lazy doctor`.
 * The daemon injects an implementation (`src/daemon/doctor-service.ts`) that
 * calls `doctor.run` / `doctor.report` and the shared remedy module.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests of other pages), the Doctor tab still RENDERS — GET is a last-report
 * read, and a missing port just says the actions are unavailable — but Run
 * and the remedy buttons answer 503 rather than half-working.
 */

import type { DoctorReport, StoredDoctorReport } from '../doctor';
import type {
  DoctorRemedyFlag,
  DoctorRemedyPreview,
  DoctorRemedyProgressEvent,
  DoctorRemedyResult,
} from '../doctor/remedies';

export type {
  DoctorReport,
  StoredDoctorReport,
  DoctorRemedyFlag,
  DoctorRemedyPreview,
  DoctorRemedyProgressEvent,
  DoctorRemedyResult,
};

export interface DoctorActions {
  /** Execute the sweep. Slow (docker/git probes) — never call this from a GET. */
  run(): Promise<DoctorReport>;
  /** Last snapshot this machine produced, or null. A file read, not a sweep. */
  report(): Promise<StoredDoctorReport | null>;
  /** List what a flag would touch. Does not act. */
  previewRemedy(flag: DoctorRemedyFlag): Promise<DoctorRemedyPreview>;
  /** Act. The caller has already confirmed. Streams progress when given. */
  applyRemedy(
    flag: DoctorRemedyFlag,
    onProgress?: (event: DoctorRemedyProgressEvent) => void,
  ): Promise<DoctorRemedyResult>;
}
