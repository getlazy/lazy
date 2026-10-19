/**
 * The links at the top of a PR/MR description that take a reviewer from the PR
 * to the task in Lazy Teams and to its running app.
 *
 * Present only when Teams pushed link templates (`setTeamsLinks`); a solo
 * install has none, and a localhost dashboard link is useless to a reviewer.
 * Teams owns the URL scheme — this only substitutes `{task}` and `{service}`.
 * The service is `[serve] main_service`, else the first declared one.
 */

import type { Storage } from '../storage';
import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';
import { mainServiceOf } from '../serve/ports';
import { serviceHostLabel } from '../serve/subdomain';
import { logger } from '../utils/logger';

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(task|service)\}/g, (_, key: string) => encodeURIComponent(values[key] ?? ''));
}

/** One compact markdown line, or null when this install has nothing to link to. */
export async function resolveDescriptionLinks(
  storage: Storage,
  config: ResolvedConfig,
  task: Task,
): Promise<string | null> {
  const links = (await storage.getProjectSettings())?.teamsLinks;
  if (!links) return null;

  const taskRef = task.code ?? task.id;
  const parts = [`[**Task in Lazy Teams**](${fill(links.taskUrlTemplate, { task: taskRef })})`];

  const service = links.serviceUrlTemplate
    ? mainServiceOf(config.serve.services, config.serve.main_service)
    : null;
  if (links.serviceUrlTemplate && service) {
    const url = fill(links.serviceUrlTemplate, { task: taskRef, service: serviceHostLabel(service) });
    parts.push(`[**Running app**](${url}) (${service.name})`);
  }
  return `🔗 ${parts.join(' · ')}`;
}

/**
 * What a driver should write for the links block: the line, `null` (this
 * install has none — remove any block lazy wrote), or `undefined` (could not
 * be determined — leave the description's block alone).
 */
export async function descriptionLinksFor(
  context: { storage: Storage } | undefined,
  config: ResolvedConfig,
  task: Task,
): Promise<string | null | undefined> {
  if (!context) return undefined;
  try {
    return await resolveDescriptionLinks(context.storage, config, task);
  } catch (err) {
    logger.warn(`Could not resolve the Teams links for the description of task ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
