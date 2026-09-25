/**
 * Shared validation for turn reports and file decisions.
 *
 * INVARIANT: external surfaces validate at the boundary — empty sections,
 * unknown kinds, and empty reasons are rejected loudly.
 */

import type {
  TurnReportSection,
  TurnReportSectionKind,
  FileDecisionScope,
} from '../types';

export const TURN_REPORT_SECTION_KINDS: readonly TurnReportSectionKind[] = [
  'capabilities_lost',
  'behavior_change',
  'implementation',
  'what_was_done',
  'how_to_verify',
  'commentary',
] as const;

const KIND_SET = new Set<string>(TURN_REPORT_SECTION_KINDS);

export function isTurnReportSectionKind(value: unknown): value is TurnReportSectionKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/**
 * Normalize and validate report sections. Rejects empty arrays, unknown kinds,
 * and empty bodies. Duplicate kinds are allowed (agent may want two commentary
 * blocks) — storage keeps array order; renderers apply src/review/report-policy.ts.
 */
export function normalizeTurnReportSections(raw: unknown): TurnReportSection[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Turn report sections must be a non-empty array');
  }
  const sections: TurnReportSection[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Turn report section[${i}] must be an object`);
    }
    const kind = (entry as { kind?: unknown }).kind;
    const body = (entry as { body?: unknown }).body;
    if (!isTurnReportSectionKind(kind)) {
      throw new Error(
        `Turn report section[${i}] has unknown kind ${JSON.stringify(kind)}; ` +
          `expected one of ${TURN_REPORT_SECTION_KINDS.join(', ')}`,
      );
    }
    if (typeof body !== 'string' || !body.trim()) {
      throw new Error(`Turn report section[${i}] body must be a non-empty string`);
    }
    sections.push({ kind, body: body.trimEnd() });
  }
  return sections;
}

export function normalizeFileDecisionScope(raw: unknown): FileDecisionScope {
  if (raw === 'protected' || raw === 'maintain') return raw;
  throw new Error(`File decision scope must be "protected" or "maintain", got ${JSON.stringify(raw)}`);
}

export function normalizeFileDecisionReason(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('File decision reason must be a non-empty string');
  }
  return raw.trim();
}

export function normalizeFileDecisionTarget(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('File decision target must be a non-empty string');
  }
  return raw.trim();
}
