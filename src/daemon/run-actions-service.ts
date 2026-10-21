/**
 * RunActions over the daemon's own commit-run functions — what the dashboard's
 * Run pages (src/server/runs-page.ts) call.
 *
 * Every method is the in-process twin of an RPC Lazy Teams sends
 * (docs/design/run-any-commit.md): `listBranches`, `runs.*`, `serve.run` /
 * `serve.stop` / `servePorts` / `ensureTaskContainer` with `runId`. They call
 * the SAME handlers, so the two surfaces cannot disagree about a run. The one
 * thing added here is the actor: the dashboard's person (./dashboard-actor.ts),
 * which is who a run's `created_by` / `last_pulled_by` names — on a laptop the
 * same person the CLI's writes name.
 */

import type { RunActions, RunServeView, RunView, RunDetail, RunBranchList } from '../server/run-actions';
import { dashboardActor } from './dashboard-actor';
import {
  createCommitRun,
  handleListBranches,
  handleListRuns,
  handleSetRunImageChoice,
  handleShowRun,
  handleStopRunContainer,
  pullCommitRun,
  removeCommitRun,
} from './commit-run';
import { ensureRunContainer } from './commit-run-container';
import { runStartServices, stopStartServices } from './serve-run';
import { handleServePorts } from './rpc-handlers';

export function createRunActions(projectRoot: string): RunActions {
  return {
    async listBranches({ refresh }): Promise<RunBranchList> {
      return handleListBranches(projectRoot, { refresh });
    },

    async listRuns(): Promise<RunView[]> {
      return (await handleListRuns(projectRoot)).runs;
    },

    async showRun(runId: string): Promise<RunDetail> {
      return handleShowRun(projectRoot, { runId });
    },

    async createRun(input, onProgress) {
      const result = await createCommitRun(projectRoot, {
        target: input.target,
        confirmDiscard: input.confirmDiscard,
        actor: await dashboardActor(projectRoot),
        progress: onProgress,
      });
      return { run: result.run, existed: result.existed };
    },

    async pullRun(runId, input, onProgress) {
      const result = await pullCommitRun(projectRoot, {
        runId,
        confirmDiscard: input.confirmDiscard,
        actor: await dashboardActor(projectRoot),
        progress: onProgress,
      });
      const { run: _run, ...rest } = result;
      return rest;
    },

    async removeRun(runId, input) {
      const result = await removeCommitRun(projectRoot, {
        runId,
        confirmDiscard: input.confirmDiscard,
        actor: await dashboardActor(projectRoot),
      });
      return { slug: result.slug, discarded: result.discarded, discardedCommits: result.discardedCommits };
    },

    async setImageChoice(runId, choice) {
      await handleSetRunImageChoice(projectRoot, { runId, choice });
    },

    async runServices(runId, onProgress) {
      await runStartServices(projectRoot, { runId }, { progress: onProgress });
    },

    async stopServices(runId) {
      return stopStartServices(projectRoot, { runId });
    },

    async stopEnvironment(runId) {
      return handleStopRunContainer(projectRoot, { runId });
    },

    async ensureContainer(runId, onProgress) {
      const result = await ensureRunContainer(projectRoot, {
        runId,
        ...(onProgress ? { notify: onProgress } : {}),
      });
      return { containerName: result.containerName, alreadyRunning: result.alreadyRunning };
    },

    async serveState(runId): Promise<RunServeView> {
      const answer = await handleServePorts(projectRoot, { runId, includeServicesRun: true });
      return answer as unknown as RunServeView;
    },
  };
}
