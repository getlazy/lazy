/** Deployment facts come from the daemon, never from an agent's environment. */
import { platform, arch } from 'node:os';
import { isManagedMode, MANAGED_BACKEND_ENV } from './config/managed-mode';
import type { Command } from './protocol/types';
import type { HostPermissionMode, RunnerType } from './config/types';
import template from './prompts/runtime-context.md' with { type: 'text' };
import { VERSION } from './version';
import teamsSection from './prompts/runtime-context-teams.md' with { type: 'text' };
import soloSection from './prompts/runtime-context-solo.md' with { type: 'text' };
import unknownSection from './prompts/runtime-context-unknown.md' with { type: 'text' };
import containerAccess from './prompts/runtime-context-builder-container.md' with { type: 'text' };
import hostAccess from './prompts/runtime-context-builder-host.md' with { type: 'text' };
import taskAccess from './prompts/runtime-context-task.md' with { type: 'text' };
import taskHostAccess from './prompts/runtime-context-task-host.md' with { type: 'text' };
import readWork from './prompts/runtime-context-read-work.md' with { type: 'text' };
import cliTaskOperations from './prompts/runtime-context-read-work-cli.md' with { type: 'text' };
import mcpTaskOperations from './prompts/runtime-context-read-work-mcp.md' with { type: 'text' };

export interface RuntimeFacts {
  managed: boolean;
  backend: string | null;
  daemonPlatform: string;
  daemonArch: string;
  version: string;
  team: string | null;
  project: string | null;
  teamsUrl: string | null;
}

/** Called in the daemon; the fleet owns these deployment settings. */
export function daemonRuntimeFacts(env: NodeJS.ProcessEnv = process.env): RuntimeFacts {
  return {
    managed: isManagedMode(env), backend: env[MANAGED_BACKEND_ENV] ?? null,
    daemonPlatform: platform(), daemonArch: arch(), version: VERSION,
    team: env.LAZY_MANAGED_TEAM ?? null, project: env.LAZY_MANAGED_PROJECT ?? null,
    teamsUrl: env.LAZY_MANAGED_TEAMS_URL ?? null,
  };
}

export function appendRuntimeContext(prompt: string, opts: {
  facts?: RuntimeFacts;
  runner: RunnerType;
  audience: 'builder' | 'task';
  scratch?: string;
  dataDir?: string;
  permissionMode?: HostPermissionMode;
  dashboardUrl?: string | null;
}): string {
  const f = opts.facts;
  const hostProcess = opts.runner === 'dangerously-host-process-without-any-isolation';
  const managed = f?.managed;
  const fill = (text: string, values: Record<string, string>) => text.trimEnd().replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? 'unknown');
  const surface = !f ? unknownSection : managed ? fill(teamsSection, {
    team: f.team ?? 'unknown', project: f.project ?? 'unknown', teamsUrl: f.teamsUrl ?? 'unknown',
  }) : fill(soloSection, { dashboardUrl: opts.dashboardUrl ?? 'unknown' });
  const accessTemplate = opts.audience === 'task'
    ? (hostProcess ? taskHostAccess : taskAccess)
    : (hostProcess ? hostAccess : containerAccess);
  const values = {
    surface,
    runner: [hostProcess ? 'host process' : opts.runner, managed ? f.backend === 'microvm' ? 'smolvm microVM per project' : f.backend === 'local-docker' ? 'Teams local Docker' : 'Teams backend unknown' : ''].filter(Boolean).join('; '),
    host: managed ? f.backend === 'microvm' ? 'project microVM (daemon and dockerd), not the human’s laptop' : f.backend === 'local-docker' ? 'Teams deployment machine (shared dockerd), not the human’s laptop' : 'daemon machine; topology unknown' : 'daemon machine',
    platforms: `daemon ${f ? `${f.daemonPlatform}/${f.daemonArch}` : 'OS/architecture unknown'}; runner ${hostProcess && f ? `${f.daemonPlatform}/${f.daemonArch}` : 'OS/architecture unknown (not probed at launch)'}`,
    access: fill(accessTemplate, {
      scratch: opts.scratch ?? 'unknown',
      dataDir: opts.dataDir ?? 'the project’s configured lazy data directory',
      permissionMode: opts.permissionMode ?? 'unknown',
    }),
    readWork: fill(readWork, {
      taskOperations: (hostProcess && opts.audience === 'builder' ? cliTaskOperations : mcpTaskOperations).trimEnd(),
    }),
    version: f?.version ?? 'unknown',
  };
  return `${prompt.trimEnd()}\n\n${fill(template, values)}`;
}

/** The supervisor adds the daemon-owned section before choosing a harness or turn type. */
export function withRuntimeContext(command: Command): Command {
  if (!command.runtime_context || !(command.type === 'start' || command.type === 'unblock' || command.type === 'ask' || command.type === 'review')) return command;
  return { ...command, system_prompt: [command.system_prompt, command.runtime_context].filter(Boolean).join('\n\n') };
}
