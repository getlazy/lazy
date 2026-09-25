/**
 * Daemon module — public API
 *
 * Re-exports the key functions needed by CLI commands and auto-start.
 */

export { getDaemonBaseDir, getDaemonDir, getPidPath, getTokenPath, getLogPath, getDaemonLockPath, getStartupErrorPath, projectSlug } from './paths';
export {
  checkDaemonHealth,
  DAEMON_HEALTH_TIMEOUT_MS,
  isDaemonRunning,
  isProcessAlive,
  requestShutdown,
  waitForDaemon,
  waitForDaemonStop,
  readPid,
  readToken,
  getDaemonTcpTarget,
  readWebPort,
  cleanupStaleFiles,
  cleanupOwnDaemonFiles,
  probeDaemonLockSync,
  readDaemonLockPid,
  acquireDaemonLock,
  releaseDaemonLock,
  blockingFlock,
  SIGNAL_SHUTDOWN_BUDGET_MS,
  SHUTDOWN_STOP_GRACE_SECONDS,
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
export { DASHBOARD_HOSTNAME, dashboardHostFor, formatDashboardUrl, resolveDashboardUrl } from './dashboard-url';
// The dashboard's browser-session gate. `serveDashboardRequest` is how a
// surface that serves the pages should reach it — gate plus router, so the
// response headers that go with the gate come along. `hasDashboardSession` is
// the reusable check every new dashboard-adjacent surface must call — in
// particular the web shell's WebSocket upgrade, which has to re-check on EVERY
// bind rather than trusting that the page that opened it was authenticated.
export {
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_LOGIN_PARAM,
  guardDashboardRequest,
  serveDashboardRequest,
  hasDashboardSession,
  isDashboardHost,
  readCookie,
  signInPage,
} from './dashboard-auth';
export {
  DASHBOARD_SESSION_IDLE_MS,
  LOGIN_TICKET_TTL_MS,
  clearDashboardSessionCache,
  isValidDashboardSession,
  mintDashboardLoginTicket,
  redeemDashboardLoginTicket,
  revokeDashboardSessions,
} from './dashboard-sessions';
export { enumerateDaemons, writeDaemonRoot, type DaemonRecord, type DaemonIdentity } from './registry';
export { ensureDaemon } from './auto-start';
export { DaemonClient, DaemonNotRunningError, NotALazyProjectError, tryRpc } from './client';
export { setDaemonContext, getDaemonContext } from './context';
export { queryTaskList, queryBlockedTasks, queryActiveTasks, queryTaskShow, querySearch, queryDiff, queryWait, queryStartTask, queryDaemonMcpConfig, queryRevokeDaemonMcpToken } from './rpc-fallback';
export type { ListResult, ShowResult, SearchQueryResult, DiffResult, WaitResult, StartTaskRpcResult, DaemonMcpConfigResult, RevokeDaemonMcpTokenResult } from './rpc-fallback';
export type { AutoReactTrigger, AutoReactDecision } from './auto-react-budget';
export type { AutoReactBudgetEntry } from './lifecycle';
