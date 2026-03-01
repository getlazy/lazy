import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { theme } from '../theme';

/**
 * Represents a built-in prompt file from src/prompts/.
 */
export interface BuiltinPrompt {
  /** Human-readable code with lazy-prompt- prefix, e.g. "lazy-prompt-system-instructions" */
  code: string;
  /** Original filename, e.g. "system-instructions.md" */
  filename: string;
  /** Absolute path to the file */
  path: string;
  /** Short description derived from the first non-empty line of content */
  description: string;
}

export const BUILTIN_PROMPT_PREFIX = 'lazy-prompt-';

/**
 * Check if a code string refers to a built-in prompt (has lazy-prompt- prefix).
 */
export function isBuiltinPromptCode(code: string): boolean {
  return code.startsWith(BUILTIN_PROMPT_PREFIX);
}

/**
 * Get the directory containing built-in prompt files.
 * This resolves relative to this source file's location.
 */
function getPromptsDir(): string {
  return join(__dirname, '../../prompts');
}

/**
 * Derive a prompt code from a filename.
 * E.g. "system-instructions.md" -> "lazy-prompt-system-instructions"
 */
function filenameToCode(filename: string): string {
  const stem = basename(filename, '.md');
  return BUILTIN_PROMPT_PREFIX + stem;
}

/**
 * Extract a short description from prompt content.
 * Uses the first non-empty, non-heading line, truncated.
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and markdown headings
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Skip template variable lines
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) continue;
    // Truncate long lines
    if (trimmed.length > 80) {
      return trimmed.substring(0, 77) + '...';
    }
    return trimmed;
  }
  return '(empty)';
}

/**
 * List all built-in prompts from src/prompts/.
 */
export function listBuiltinPrompts(): BuiltinPrompt[] {
  const dir = getPromptsDir();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort();

  return files.map(filename => {
    const filePath = join(dir, filename);
    const content = readFileSync(filePath, 'utf-8');
    return {
      code: filenameToCode(filename),
      filename,
      path: filePath,
      description: extractDescription(content),
    };
  });
}

/**
 * Read a built-in prompt by its code.
 * Returns the file content or null if not found.
 */
export function readBuiltinPrompt(code: string): string | null {
  if (!isBuiltinPromptCode(code)) return null;

  const dir = getPromptsDir();
  const stem = code.slice(BUILTIN_PROMPT_PREFIX.length);
  try {
    return readFileSync(join(dir, stem + '.md'), 'utf-8');
  } catch {
    return null;
  }
}

export function printBuiltinPrompts(): void {
  const prompts = listBuiltinPrompts();

  if (prompts.length === 0) {
    console.log('No built-in system prompts found.');
    return;
  }

  console.log(`${theme.label('Built-in System Prompts')} (${theme.count(String(prompts.length))})\n`);
  console.log(`${theme.header('CODE'.padEnd(44))} ${theme.header('DESCRIPTION')}`);
  console.log(theme.separator(`${'─'.repeat(44)} ${'─'.repeat(50)}`));

  for (const prompt of prompts) {
    console.log(
      `${theme.pad(theme.taskId(prompt.code), 44)} ${prompt.description}`
    );
  }

  console.log(`\nView a prompt with: ${theme.command('lazy show <code>')}`);
}
