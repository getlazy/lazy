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
  readPid,
  readToken,
  cleanupStaleFiles,
  acquireDaemonLock,
  releaseDaemonLock,
  blockingFlock,
  type DaemonStatus,
} from './lifecycle';
export { startDaemonServer, type RunningDaemon, type DaemonServerOptions } from './server';
export { ensureDaemon } from './auto-start';
export { DaemonClient, DaemonNotRunningError, tryRpc } from './client';
export { setDaemonContext, getDaemonContext } from './context';
export { queryTaskList, queryBlockedTasks, queryActiveTasks, queryTaskShow, querySearch, queryDiff, queryWait, queryStartTask, queryDaemonMcpConfig } from './rpc-fallback';
export type { ListResult, ShowResult, SearchQueryResult, DiffResult, WaitResult, StartTaskRpcResult, DaemonMcpConfigResult } from './rpc-fallback';
export type { AutoReactTrigger, AutoReactDecision } from './auto-react-budget';
export type { AutoReactBudgetEntry } from './lifecycle';
