/**
 * Confirmation protocol for MCP tool handlers.
 *
 * Implements the two-step confirmation pattern: when a tool call requires
 * confirmation, step 1 returns guidance + a confirmation code, step 2
 * validates the code and executes. Codes are scoped to (operation, taskId),
 * single-use, and expire after 5 minutes.
 */

import { randomBytes } from 'crypto';

export type ConfirmationLevel = 'none' | 'light' | 'standard' | 'stern';

export interface ConfirmationRequest {
  level: ConfirmationLevel;
  guidance: string;
  code: string;
  operation: string;
  taskId: string;
}

export interface PendingConfirmation {
  code: string;
  operation: string;
  taskId: string;
  createdAt: number;
}

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const pending = new Map<string, PendingConfirmation>();

/** Generate a confirmation code with verb prefix. Format: `verb-4hex` */
export function generateCode(verbPrefix: string): string {
  const hex = randomBytes(2).toString('hex');
  return `${verbPrefix}-${hex}`;
}

/** Store a pending confirmation, garbage-collecting expired entries first. */
export function storePending(conf: PendingConfirmation): void {
  const now = Date.now();
  for (const [key, val] of pending) {
    if (now - val.createdAt > EXPIRY_MS) pending.delete(key);
  }
  pending.set(conf.code, conf);
}

/**
 * Validate and consume a confirmation code.
 * Returns true if the code is valid for the given operation and task.
 * The code is consumed (deleted) on successful validation — single-use.
 */
export function validateCode(
  code: string,
  operation: string,
  taskId: string,
): boolean {
  const conf = pending.get(code);
  if (!conf) return false;
  if (conf.operation !== operation) return false;
  if (conf.taskId !== taskId) return false;
  if (Date.now() - conf.createdAt > EXPIRY_MS) {
    pending.delete(code);
    return false;
  }
  pending.delete(code); // single-use
  return true;
}

/** Clear all pending confirmations. Primarily for testing. */
export function clearPending(): void {
  pending.clear();
}

/** Get the number of pending confirmations. Primarily for testing. */
export function pendingCount(): number {
  return pending.size;
}

// --- Template rendering ---

import acceptLightTemplate from '../prompts/confirmations/accept-light.md' with { type: 'text' };
import acceptStandardTemplate from '../prompts/confirmations/accept-standard.md' with { type: 'text' };
import acceptSternTemplate from '../prompts/confirmations/accept-stern.md' with { type: 'text' };
import abandonLightTemplate from '../prompts/confirmations/abandon-light.md' with { type: 'text' };
import abandonStandardTemplate from '../prompts/confirmations/abandon-standard.md' with { type: 'text' };
import abandonSternTemplate from '../prompts/confirmations/abandon-stern.md' with { type: 'text' };
import rejectTemplate from '../prompts/confirmations/reject.md' with { type: 'text' };
import closeLightTemplate from '../prompts/confirmations/close-light.md' with { type: 'text' };
import closeStandardTemplate from '../prompts/confirmations/close-standard.md' with { type: 'text' };
import closeSternTemplate from '../prompts/confirmations/close-stern.md' with { type: 'text' };
import redoStandardTemplate from '../prompts/confirmations/redo-standard.md' with { type: 'text' };
import redoSternTemplate from '../prompts/confirmations/redo-stern.md' with { type: 'text' };
import reopenStandardTemplate from '../prompts/confirmations/reopen-standard.md' with { type: 'text' };
import createParentWarningTemplate from '../prompts/confirmations/create-parent-warning.md' with { type: 'text' };
import createParentWarningSternTemplate from '../prompts/confirmations/create-parent-warning-stern.md' with { type: 'text' };

const templates: Record<string, string> = {
  'accept-light': acceptLightTemplate,
  'accept-standard': acceptStandardTemplate,
  'accept-stern': acceptSternTemplate,
  'abandon-light': abandonLightTemplate,
  'abandon-standard': abandonStandardTemplate,
  'abandon-stern': abandonSternTemplate,
  'reject': rejectTemplate,
  'close-light': closeLightTemplate,
  'close-standard': closeStandardTemplate,
  'close-stern': closeSternTemplate,
  'redo-standard': redoStandardTemplate,
  'redo-stern': redoSternTemplate,
  'reopen-standard': reopenStandardTemplate,
  'create-parent-warning': createParentWarningTemplate,
  'create-parent-warning-stern': createParentWarningSternTemplate,
};

/**
 * Render a guidance template by substituting `{{placeholder}}` variables.
 * Throws if the template name is unknown.
 */
export function renderGuidance(
  templateName: string,
  vars: Record<string, string | number>,
): string {
  const template = templates[templateName];
  if (!template) {
    throw new Error(`Unknown confirmation template: ${templateName}`);
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = vars[key];
    if (value === undefined) return match; // leave unresolved placeholders as-is
    return String(value);
  });
}
