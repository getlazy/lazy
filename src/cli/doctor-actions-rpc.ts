/**
 * A DoctorActions implementation backed by the daemon's doctor RPC commands.
 *
 * Same reason as `memory-actions-rpc.ts`: the from-source web UI is a client,
 * not a second writer. Every run, last-report read, preview and apply lands
 * in doctor-service.ts on the daemon.
 */

import type { DaemonClient } from '../daemon/client';
import type { DoctorActions, DoctorReport, StoredDoctorReport } from '../server/doctor-actions';
import type {
  DoctorRemedyFlag,
  DoctorRemedyPreview,
  DoctorRemedyProgressEvent,
  DoctorRemedyResult,
} from '../doctor/remedies';

export function createRpcDoctorActions(client: DaemonClient, projectRoot: string): DoctorActions {
  const call = (
    command: string,
    params: Record<string, unknown> = {},
    onProgress?: (event: DoctorRemedyProgressEvent) => void,
  ) =>
    client.rpc(
      command,
      projectRoot,
      params,
      onProgress
        ? {
            onProgress: (event) => {
              if (event.kind !== 'phase') return;
              onProgress({
                label: event.label,
                state: event.state === 'failed' ? 'error'
                  : event.state === 'progress' ? 'start'
                  : event.state === 'skipped' ? 'ok'
                  : event.state,
                detail: event.detail,
              });
            },
          }
        : undefined,
    );

  return {
    async run(): Promise<DoctorReport> {
      return (await call('doctor.run')) as DoctorReport;
    },
    async report(): Promise<StoredDoctorReport | null> {
      return (await call('doctor.report')) as StoredDoctorReport | null;
    },
    async previewRemedy(flag: DoctorRemedyFlag): Promise<DoctorRemedyPreview> {
      return (await call('doctor.previewRemedy', { flag })) as DoctorRemedyPreview;
    },
    async applyRemedy(
      flag: DoctorRemedyFlag,
      onProgress?: (event: DoctorRemedyProgressEvent) => void,
    ): Promise<DoctorRemedyResult> {
      return (await call('doctor.applyRemedy', { flag }, onProgress)) as DoctorRemedyResult;
    },
  };
}
