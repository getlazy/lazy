/**
 * The ONE rule for the host name Lazy Teams gives a `[serve]` service:
 *
 *   <subject>-<port>-<project>-<team>-<tag><short>.<SERVICES_HOST>
 *   ui-fix-3000-web-acme-k3x73f9a1c2e
 *
 * - `<subject>`: the task's host label (its code, else its short id) or a
 *   commit run's slug — readable only, truncated to fit, never parsed.
 * - `<port>`: the service's CONTAINER port, never its name.
 * - `<project>-<team>`: the Teams slugs, at most 16 characters together —
 *   readable only, never parsed.
 * - `<tag>`: 4 base32 characters naming the Teams project. Teams computes it
 *   (an HMAC of the project id under the installation's own secret, so it is
 *   neither a counter nor reversible from public code) and hands it in; the
 *   daemon only places it.
 * - `<short>`: the first 8 hex characters of the task's or run's UUID.
 *
 * The last 12 characters are the route; everything before them is for people.
 * Single hyphens only — every part is squeezed — so a label can never carry the
 * reserved `xx--` form (RFC 5890 §2.3.1) that `ui--9000--p15` did, and every
 * label fits one 63-character DNS label, so every service gets a link.
 *
 * The daemon owns this rule: `servePorts` answers each service's label
 * (`teamsHostLabel`) and `resolveServiceHost` turns a label back into its
 * task or run, so Teams never composes a name of its own. Design and the
 * decision record: docs/design/readable-service-hostnames.md.
 */

import { serviceHostLabel } from './subdomain';

export const MAX_TEAMS_HOST_LABEL = 63;
/** `<project>-<team>` together, hyphen included. */
export const MAX_PROJECT_TEAM = 16;
export const PROJECT_TAG_LENGTH = 4;
export const SHORT_ID_LENGTH = 8;
const TAIL_LENGTH = PROJECT_TAG_LENGTH + SHORT_ID_LENGTH;

const PROJECT_TAG_RE = /^[a-z2-7]{4}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The fixed tail: `-<tag><short>` at the very end of a well-formed label. */
const TAIL_RE = /-([a-z2-7]{4})([0-9a-f]{8})$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** What Teams hands the daemon so it can name a project's services. */
export interface TeamsServiceHostContext {
  projectTag: string;
  projectSlug: string;
  teamSlug: string;
}

/**
 * The `serviceHost` RPC parameter, validated at the boundary: absent → null,
 * present but malformed → throws naming what is wrong. Never silently ignored,
 * because a caller that sent it expects labels back.
 */
export function parseTeamsServiceHostContext(value: unknown): TeamsServiceHostContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('serviceHost must be an object { projectTag, projectSlug, teamSlug }');
  }
  const record = value as Record<string, unknown>;
  const projectTag = record.projectTag;
  const projectSlug = record.projectSlug;
  const teamSlug = record.teamSlug;
  if (typeof projectTag !== 'string' || !PROJECT_TAG_RE.test(projectTag)) {
    throw new Error(`serviceHost.projectTag must be 4 characters of lowercase base32 (a-z, 2-7), got ${JSON.stringify(projectTag)}`);
  }
  // No length cap: Teams puts none on slugs, and the label uses only 16
  // characters of the two (projectTeamPart cuts them), so a long rename must
  // still name its services rather than break them.
  for (const [key, slug] of [['projectSlug', projectSlug], ['teamSlug', teamSlug]] as const) {
    if (typeof slug !== 'string' || slug.length === 0 || !SLUG_RE.test(slug)) {
      throw new Error(`serviceHost.${key} must be a slug (lowercase letters, digits, single hyphens), got ${JSON.stringify(slug)}`);
    }
  }
  return { projectTag, projectSlug: projectSlug as string, teamSlug: teamSlug as string };
}

/** Lowercase, anything outside `[a-z0-9]` becomes `-`, runs squeezed, ends trimmed. */
function squeeze(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `value` cut to `max` characters, never ending in a hyphen. */
function cut(value: string, max: number): string {
  return value.slice(0, Math.max(0, max)).replace(/-+$/, '');
}

/** The first 8 hex characters of a UUID (lazy's short id). */
export function shortIdOf(id: string): string {
  const hex = id.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < SHORT_ID_LENGTH) throw new Error(`cannot take a short id from ${JSON.stringify(id)}`);
  return hex.slice(0, SHORT_ID_LENGTH);
}

/**
 * `<project>-<team>` in at most 16 characters: the project gets 8 and the
 * team 7, and room one side leaves unused goes to the other.
 */
export function projectTeamPart(projectSlug: string, teamSlug: string): string {
  const room = MAX_PROJECT_TEAM - 1;
  const project = squeeze(projectSlug) || 'p';
  const team = squeeze(teamSlug) || 't';
  const teamShare = Math.min(team.length, Math.max(room - project.length, 7));
  const projectShare = Math.min(project.length, room - teamShare);
  return `${cut(project, projectShare)}-${cut(team, room - projectShare)}`;
}

/**
 * The label for one service of one task or run. Always a valid DNS label of
 * at most 63 characters, never with `--` anywhere.
 */
export function teamsServiceHostLabel(input: {
  /** The subject's daemon host label: a task's code (else short id) or a run's slug. */
  subjectLabel: string;
  /** The task's or run's UUID. */
  subjectId: string;
  /** The service's container port. */
  port: number;
  context: TeamsServiceHostContext;
}): string {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`service port must be 1-65535, got ${input.port}`);
  }
  const short = shortIdOf(input.subjectId);
  const tail = `${input.context.projectTag}${short}`;
  const middle = projectTeamPart(input.context.projectSlug, input.context.teamSlug);
  const port = String(input.port);
  const room = MAX_TEAMS_HOST_LABEL - tail.length - 1 - middle.length - 1 - port.length - 1;
  const subject = cut(squeeze(input.subjectLabel), room) || short;
  const label = `${subject}-${port}-${middle}-${tail}`;
  // Belt and braces: the construction above cannot produce either, and a
  // label that did would be refused by CAs and some URL parsers.
  if (label.length > MAX_TEAMS_HOST_LABEL || label.includes('--') || !LABEL_RE.test(label)) {
    throw new Error(`internal: composed an invalid service host label ${JSON.stringify(label)}`);
  }
  return label;
}

/** A label's route: the project tag, the short id, and the readable rest. */
export interface ParsedTeamsServiceHostLabel {
  projectTag: string;
  shortId: string;
  /** Everything before `-<tag><short>`: `<subject>-<port>-<project>-<team>`. */
  prefix: string;
}

/** Parse a label written by {@link teamsServiceHostLabel}, or null. */
export function parseTeamsServiceHostLabel(label: string): ParsedTeamsServiceHostLabel | null {
  const value = label.trim().toLowerCase();
  if (value.length > MAX_TEAMS_HOST_LABEL || value.includes('--') || !LABEL_RE.test(value)) return null;
  const match = TAIL_RE.exec(value);
  if (!match) return null;
  const prefix = value.slice(0, value.length - TAIL_LENGTH - 1);
  if (prefix.length === 0) return null;
  return { projectTag: match[1]!, shortId: match[2]!, prefix };
}

/**
 * Which declared service a label names, for one candidate subject.
 *
 * Exact first: the label this daemon would write today for each declared
 * service. A label written before a rename no longer matches exactly, so the
 * fallback is the one declared port that appears as `-<port>-` in the
 * readable part — and null when none or several do, which the caller shows
 * as "pick the service" rather than guessing.
 */
export function serviceForLabel(
  label: string,
  subject: { subjectLabel: string; subjectId: string },
  declared: Array<{ name: string; port: number }>,
  context: TeamsServiceHostContext,
): { name: string; port: number; label: string } | null {
  const wanted = label.trim().toLowerCase();
  for (const service of declared) {
    if (teamsServiceHostLabel({ ...subject, port: service.port, context }) === wanted) {
      return { name: service.name, port: service.port, label: serviceHostLabel(service) };
    }
  }
  const parsed = parseTeamsServiceHostLabel(wanted);
  if (!parsed) return null;
  const padded = `-${parsed.prefix}-`;
  const hits = declared.filter((service) => padded.includes(`-${service.port}-`));
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  return { name: hit.name, port: hit.port, label: serviceHostLabel(hit) };
}
