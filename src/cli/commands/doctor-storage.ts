/**
 * Re-export: doctor storage lives in `src/doctor/storage.ts` so the daemon
 * can open the same handle without importing CLI code.
 */
export {
  DOCTOR_LOCK_TIMEOUT_MS,
  openDoctorStorage,
  withDoctorStorage,
} from '../../doctor/storage';
