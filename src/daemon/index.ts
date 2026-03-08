/**
 * Daemon module — public API
 *
 * Re-exports the key functions needed by CLI commands and auto-start.
 */

export { getDaemonDir, getPidPath, getSocketPath, getTokenPath, getLogPath } from './paths';
export {
  checkDaemonProcess,
  checkDaemonHealth,
  requestShutdown,
  waitForDaemon,
  readPid,
  readToken,
  cleanupStaleFiles,
  acquireStartLock,
  releaseStartLock,
  type DaemonStatus,
} from './lifecycle';
export { startDaemonServer, type RunningDaemon, type DaemonServerOptions } from './server';
export { ensureDaemon } from './auto-start';
export { DaemonClient, tryRpc } from './client';
export { queryTaskList, queryBlockedTasks, queryActiveTasks, queryTaskShow, querySearch, queryDiff, queryWait } from './rpc-fallback';
export type { ListResult, ShowResult, SearchQueryResult, DiffResult, WaitResult } from './rpc-fallback';
