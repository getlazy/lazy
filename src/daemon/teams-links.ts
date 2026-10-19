/**
 * `setTeamsLinks` — Lazy Teams telling the daemon how a PR/MR description links
 * back into Teams.
 *
 * Teams owns its own address and its URL scheme for task pages and service
 * doors, so it pushes two URL TEMPLATES and the daemon substitutes `{task}` and
 * `{service}`. The daemon never reads `APP_HOST` or guesses a host, and no URL
 * rule is copied into TypeScript. The record lives in the project settings so a
 * restarted daemon still has it; Teams re-pushes on every start.
 */

import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { optionalString } from './rpc-params';
import { updateProjectSettings } from './project-settings';

function validateTemplate(name: string, value: string, placeholders: string[]): string {
  const template = value.trim();
  for (const placeholder of placeholders) {
    if (!template.includes(placeholder)) {
      throw new RpcError(400, `${name} must contain ${placeholder}, got "${template}".`);
    }
  }
  let sample: URL;
  try {
    sample = new URL(placeholders.reduce((url, p) => url.split(p).join('sample'), template));
  } catch {
    throw new RpcError(400, `${name} is not a URL, got "${template}".`);
  }
  if (sample.protocol !== 'http:' && sample.protocol !== 'https:') {
    throw new RpcError(400, `${name} must be an http(s) URL, got "${template}".`);
  }
  return template;
}

/**
 * Record (or, with no `taskUrlTemplate`, clear) the Teams link templates.
 * A solo install never calls this, so its descriptions get no links.
 */
export async function handleSetTeamsLinks(params: Record<string, unknown>) {
  const rawTask = optionalString(params, 'taskUrlTemplate')?.trim();
  const rawService = optionalString(params, 'serviceUrlTemplate')?.trim();
  const teamsLinks = rawTask
    ? {
        taskUrlTemplate: validateTemplate('taskUrlTemplate', rawTask, ['{task}']),
        ...(rawService
          ? { serviceUrlTemplate: validateTemplate('serviceUrlTemplate', rawService, ['{task}', '{service}']) }
          : {}),
      }
    : undefined;

  const storage = await getOrCreateStorage();
  await updateProjectSettings(storage, (previous) => {
    const next = { ...(previous ?? {}) };
    if (teamsLinks) next.teamsLinks = teamsLinks;
    else delete next.teamsLinks;
    return next;
  });
  return { teamsLinks: teamsLinks ?? null };
}
