/**
 * DoctorActions over the daemon's in-process Storage handle.
 *
 * The web layer declares the port (`src/server/doctor-actions.ts`); this is
 * what the daemon injects. `run` / `report` are the existing RPC handlers so
 * the dashboard, the from-source dev server, and `POST /rpc/doctor.run` cannot
 * disagree. Remedies go through `src/doctor/remedies.ts` with this Storage
 * handle, and resume is the same `resumeTask` the CLI's `lazy resume` uses.
 */

import {
  handleDoctorApplyRemedy,
  handleDoctorPreviewRemedy,
  handleDoctorReport,
  handleDoctorRun,
} from './rpc-doctor';
import type { DoctorActions } from '../server/doctor-actions';
import type { DoctorRemedyFlag, DoctorRemedyProgressEvent } from '../doctor/remedies';
import type { ProgressEmitter } from './progress';

export function createDoctorActions(projectRoot: string): DoctorActions {
  return {
    run: () => handleDoctorRun(projectRoot),
    report: () => handleDoctorReport(projectRoot),
    previewRemedy: (flag: DoctorRemedyFlag) => handleDoctorPreviewRemedy(projectRoot, { flag }),
    applyRemedy: (
      flag: DoctorRemedyFlag,
      onProgress?: (event: DoctorRemedyProgressEvent) => void,
    ) => {
      const progress: ProgressEmitter | undefined = onProgress
        ? (event) => {
            if (event.kind !== 'phase') return;
            onProgress({
              label: event.label,
              state: event.state === 'failed' ? 'error'
                : event.state === 'progress' ? 'start'
                : event.state === 'skipped' ? 'ok'
                : event.state,
              detail: event.detail,
            });
          }
        : undefined;
      return handleDoctorApplyRemedy(projectRoot, { flag }, progress);
    },
  };
}
