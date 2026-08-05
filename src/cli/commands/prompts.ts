import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { theme } from '../theme';
import { PROMPT_BUNDLE } from '../../prompts-bundle';

/**
 * Represents a built-in prompt file from src/prompts/.
 */
export interface BuiltinPrompt {
  /** Human-readable code with lazy-prompt- prefix, e.g. "lazy-prompt-system-instructions" */
  code: string;
  /** Original filename, e.g. "system-instructions.md" */
  filename: string;
  /**
   * Absolute path to the file on disk, or null when running from a compiled
   * binary (the prompt content is embedded, there is no file on disk).
   */
  path: string | null;
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
 * Get the directory containing built-in prompt files, resolved relative to this
 * source file's location.
 *
 * In dev (`bun run ./src/index.ts`) this points at the real src/prompts/
 * directory. In a compiled binary there is no such directory on disk — see
 * `usePromptFiles()`.
 */
function getPromptsDir(): string {
  return join(__dirname, '../../prompts');
}

/**
 * Whether to read built-in prompts from the real files on disk (dev) or from
 * the compiled-in PROMPT_BUNDLE (compiled binary).
 *
 * We prefer the real files in dev so editing a prompt is instantly reflected by
 * `lazy system prompts` / `lazy show`, per the "prompts are discoverable and
 * editable" rule in CLAUDE.md. When src/prompts/ isn't on disk — i.e. a
 * `bun build --compile` binary — we fall back to the embedded bundle.
 *
 * INVARIANT: dev reads live files; compiled mode reads the embedded bundle.
 * `existsSync` here is a one-shot CLI-path check (mirrors getLazySourceRoot in
 * src/capture/claude.ts); it does not run in any hot/async path.
 */
function usePromptFiles(): boolean {
  return existsSync(getPromptsDir());
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
 * List all built-in prompts.
 *
 * In dev, reads the real files from src/prompts/. In a compiled binary, reads
 * from the embedded PROMPT_BUNDLE (path is null since there is no file on disk).
 */
export async function listBuiltinPrompts(): Promise<BuiltinPrompt[]> {
  if (usePromptFiles()) {
    const dir = getPromptsDir();
    const files = (await readdir(dir)).filter(f => f.endsWith('.md')).sort();

    return Promise.all(
      files.map(async filename => {
        const filePath = join(dir, filename);
        const content = await readFile(filePath, 'utf-8');
        return {
          code: filenameToCode(filename),
          filename,
          path: filePath,
          description: extractDescription(content),
        };
      }),
    );
  }

  // Compiled binary: source the list from the embedded bundle.
  return Object.keys(PROMPT_BUNDLE)
    .sort()
    .map(filename => ({
      code: filenameToCode(filename),
      filename,
      path: null,
      description: extractDescription(PROMPT_BUNDLE[filename]!),
    }));
}

/**
 * Read a built-in prompt by its code.
 * Returns the content or null if not found.
 */
export async function readBuiltinPrompt(code: string): Promise<string | null> {
  if (!isBuiltinPromptCode(code)) return null;

  const stem = code.slice(BUILTIN_PROMPT_PREFIX.length);
  const filename = stem + '.md';

  if (usePromptFiles()) {
    try {
      return await readFile(join(getPromptsDir(), filename), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Failed to read built-in prompt ${filename}: ${(err as Error).message}`);
    }
  }

  // Compiled binary: read from the embedded bundle.
  return PROMPT_BUNDLE[filename] ?? null;
}

export async function printBuiltinPrompts(): Promise<void> {
  const prompts = await listBuiltinPrompts();

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
