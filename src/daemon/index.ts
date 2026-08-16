/**
 * Daemon module — public API
 *
 * Re-exports the key functions needed by CLI commands and auto-start.
 */

export { getDaemonBaseDir, getDaemonDir, getPidPath, getSocketPath, getTokenPath, getLogPath, getDaemonLockPath, getStartupErrorPath, projectSlug } from './paths';
export {
  checkDaemonHealth,
  isDaemonRunning,
  isProcessAlive,
  requestShutdown,
  waitForDaemon,
  waitForDaemonStop,
  readPid,
  readToken,
  readWebPort,
  cleanupStaleFiles,
  cleanupOwnDaemonFiles,
  probeDaemonLockSync,
  readDaemonLockPid,
  acquireDaemonLock,
  releaseDaemonLock,
  blockingFlock,
  type DaemonStatus,
  type DaemonLockState,
  type CleanupOutcome,
} from './lifecycle';
export {
  inspectDaemonStateFiles,
  startDaemonStateFileWatch,
  type DaemonStateFileReport,
} from './state-files';
export { startDaemonServer, type RunningDaemon, type DaemonServerOptions } from './server';
export { formatDashboardUrl } from './dashboard-url';
export { enumerateDaemons, writeDaemonRoot, type DaemonRecord, type DaemonIdentity } from './registry';
export { ensureDaemon } from './auto-start';
export { DaemonClient, DaemonNotRunningError, NotALazyProjectError, tryRpc } from './client';
export { setDaemonContext, getDaemonContext } from './context';
export { queryTaskList, queryBlockedTasks, queryActiveTasks, queryTaskShow, querySearch, queryDiff, queryWait, queryStartTask, queryDaemonMcpConfig, queryRevokeDaemonMcpToken } from './rpc-fallback';
export type { ListResult, ShowResult, SearchQueryResult, DiffResult, WaitResult, StartTaskRpcResult, DaemonMcpConfigResult, RevokeDaemonMcpTokenResult } from './rpc-fallback';
export type { AutoReactTrigger, AutoReactDecision } from './auto-react-budget';
export type { AutoReactBudgetEntry } from './lifecycle';
