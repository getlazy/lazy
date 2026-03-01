import { theme } from '../theme';
import { TOOLCHAIN_NAMES, getToolchainDockerfileContent } from '../../docker/toolchains';
import type { ToolchainName } from '../../docker/toolchains';

export const BUILTIN_TOOLCHAIN_PREFIX = 'lazy-toolchain-';

/**
 * Represents a built-in toolchain Dockerfile.
 */
export interface BuiltinToolchain {
  /** Code with lazy-toolchain- prefix, e.g. "lazy-toolchain-rust" */
  code: string;
  /** Toolchain name, e.g. "rust" */
  name: ToolchainName;
  /** Short description from the Dockerfile header comment */
  description: string;
}

/**
 * Check if a code string refers to a built-in toolchain (has lazy-toolchain- prefix).
 */
export function isBuiltinToolchainCode(code: string): boolean {
  return code.startsWith(BUILTIN_TOOLCHAIN_PREFIX);
}

/**
 * Extract a short description from the second line of a Dockerfile.
 * Toolchain Dockerfiles follow the convention:
 *   # Toolchain: <name>
 *   # <description>
 */
function extractToolchainDescription(content: string): string {
  const lines = content.split('\n');
  if (lines.length >= 2) {
    const descLine = lines[1].trim();
    if (descLine.startsWith('# ')) {
      return descLine.slice(2);
    }
  }
  return '(no description)';
}

/**
 * List all built-in toolchains.
 */
export function listBuiltinToolchains(): BuiltinToolchain[] {
  return TOOLCHAIN_NAMES.map(name => {
    const content = getToolchainDockerfileContent(name);
    return {
      code: BUILTIN_TOOLCHAIN_PREFIX + name,
      name,
      description: extractToolchainDescription(content),
    };
  });
}

/**
 * Read a built-in toolchain Dockerfile by its code.
 * Returns the Dockerfile content or null if not found.
 */
export function readBuiltinToolchain(code: string): { name: ToolchainName; description: string; content: string } | null {
  if (!isBuiltinToolchainCode(code)) return null;

  const name = code.slice(BUILTIN_TOOLCHAIN_PREFIX.length);
  if (!(TOOLCHAIN_NAMES as readonly string[]).includes(name)) {
    return null;
  }

  const content = getToolchainDockerfileContent(name as ToolchainName);
  return {
    name: name as ToolchainName,
    description: extractToolchainDescription(content),
    content,
  };
}

export function printBuiltinToolchains(): void {
  const toolchains = listBuiltinToolchains();

  if (toolchains.length === 0) {
    console.log('No built-in toolchains found.');
    return;
  }

  console.log(`${theme.label('Built-in Toolchains')} (${theme.count(String(toolchains.length))})\n`);
  console.log(`${theme.header('CODE'.padEnd(36))} ${theme.header('DESCRIPTION')}`);
  console.log(theme.separator(`${'─'.repeat(36)} ${'─'.repeat(50)}`));

  for (const tc of toolchains) {
    console.log(
      `${theme.pad(theme.taskId(tc.code), 36)} ${tc.description}`
    );
  }

  console.log(`\nView a toolchain with: ${theme.command('lazy show <code>')}`);
}
