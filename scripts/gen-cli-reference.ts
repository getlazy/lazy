#!/usr/bin/env bun
/**
 * Generates public-docs/reference/cli/ from each command's own usage text.
 *
 * Enumeration reuses the convention the CLI guards scan for: `commandMap` in
 * src/index.ts declares `'<name>': { run: ..., usage: <fn>[, subcommands: <map>] }`.
 * index.ts cannot be imported (it runs the CLI), so its source is read for the
 * identifiers and the functions themselves come from src/cli/commands. Aliases
 * are not in the literal, so they get no page of their own.
 *
 * Usage: bun run scripts/gen-cli-reference.ts [outDir]   (default public-docs/reference/cli)
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { spawn } from './../src/utils/spawn';
import { DEFAULT_DOCS_URL, DOCS_DOMAIN, resetDocsBaseUrl } from '../src/docs/links';
import { IMAGE_TAG } from '../src/capture/image-tag';
import { VERSION } from '../src/version';

const ROOT = join(import.meta.dir, '..');

export interface CliPage {
  /** `system passphrase set` */
  command: string;
  /** `system-passphrase-set` */
  slug: string;
  usage: string;
}

/**
 * The docs pointers lazy prints carry this build's version segment; the pages are part of that
 * site, so they point at the unversioned root and never go stale on a version bump.
 */
function unpinDocsUrls(text: string): string {
  return text.split(`${DEFAULT_DOCS_URL}/`).join(`${DOCS_DOMAIN}/`);
}

/**
 * Usage text that names this build's version or image tag would make the committed pages stale on
 * every release; replace them with placeholders (after the docs-URL rewrite, which also carries one).
 */
function unpinVersion(text: string): string {
  return text.split(VERSION).join('<version>').split(`lazy-runner:${IMAGE_TAG}`).join('lazy-runner:<major.minor>');
}

/** Strip ANSI, trailing whitespace, surrounding blank lines and the machine's home directory. */
function normalise(text: string): string {
  const home = homedir();
  return unpinVersion(unpinDocsUrls(home.length > 1 ? text.split(home).join('~') : text))
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Run a usage function and capture what it prints. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return normalise(lines.join('\n'));
}

/** A usage page that is empty or not a usage text means capture missed the output. */
function checked(command: string, usage: string): string {
  if (!usage.startsWith('Usage:')) throw new Error(`usage text for 'lazy ${command}' is empty or does not start with 'Usage:'; the usage function may print outside console.log`);
  return usage;
}

export async function collectPages(): Promise<CliPage[]> {
  const indexSrc = await readFile(join(ROOT, 'src/index.ts'), 'utf8');
  // Always the built-in default base: a `[docs] url` installed by a config load must not leak in.
  resetDocsBaseUrl();
  const commands = await import('../src/cli/commands');
  const entryRe = /^ {2}'([a-z][a-z0-9-]*)':\s*\{\s*run:\s*[A-Za-z0-9_]+,\s*usage:\s*([A-Za-z0-9_]+)(?:,\s*subcommands:\s*([A-Za-z0-9_]+))?\s*\}/gm;
  const pages: CliPage[] = [];
  const seen = new Set<string>();
  for (const m of indexSrc.matchAll(entryRe)) {
    const [, name, usageIdent, mapIdent] = m;
    if (seen.has(name)) continue;
    seen.add(name);
    const usageFn = (commands as Record<string, unknown>)[usageIdent];
    if (typeof usageFn !== 'function') throw new Error(`index.ts names usage function ${usageIdent} for 'lazy ${name}' but src/cli/commands does not export it`);
    pages.push({ command: name, slug: name, usage: checked(name, capture(usageFn as () => void)) });
    const parentUsage = pages[pages.length - 1].usage;
    if (mapIdent) {
      const map = (commands as Record<string, unknown>)[mapIdent] as Record<string, () => void> | undefined;
      if (!map) throw new Error(`index.ts names subcommand map ${mapIdent} for 'lazy ${name}' but src/cli/commands does not export it`);
      for (const sub of Object.keys(map).sort()) {
        const usage = checked(`${name} ${sub}`, capture(map[sub]));
        // A subcommand that only shares its parent's usage text has nothing of its own to document.
        if (usage === parentUsage) continue;
        pages.push({ command: `${name} ${sub}`, slug: `${name}-${sub}`, usage });
      }
    }
  }
  // Every `'<name>': {` key of the commandMap literal must have been matched (init is the one inline-usage exception).
  const block = indexSrc.slice(indexSrc.indexOf('const commandMap'), indexSrc.indexOf('// Register alias entries'));
  const keys = [...block.matchAll(/^ {2}'([a-z][a-z0-9-]*)':/gm)].map((k) => k[1]);
  const missed = keys.filter((k) => k !== 'init' && !seen.has(k));
  if (seen.size === 0 || keys.length === 0 || missed.length > 0) throw new Error(`commandMap entries not matched by the generator: ${missed.join(', ') || '(none found at all)'}; the commandMap convention changed`);
  // `init` declares its usage inline in index.ts (no importable function), so
  // ask the CLI itself from a neutral cwd (outside any lazy project).
  const proc = spawn(['bun', 'run', join(ROOT, 'src/index.ts'), 'init', '--help'], { cwd: tmpdir(), timeout: 60_000 });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`'lazy init --help' exited ${code}`);
  pages.push({ command: 'init', slug: 'init', usage: checked('init', normalise(out)) });
  return pages.sort((a, b) => a.command.localeCompare(b.command));
}

/** First sentence of the first paragraph after the `Usage:` synopsis, as the table summary. */
function summaryOf(usage: string): string {
  const lines = usage.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() !== '') i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const para: string[] = [];
  for (; i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i].trim());
  const text = para.join(' ');
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/\|/g, '\\|');
}

export function render(pages: CliPage[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const p of pages) {
    files.set(
      `${p.slug}.md`,
      `# lazy ${p.command}\n\nThis page is generated from \`lazy ${p.command} --help\`.\n\n\`\`\`text\n${p.usage}\n\`\`\`\n`,
    );
  }
  const rows = pages.map((p) => `| [\`lazy ${p.command}\`](${p.slug}.md) | ${summaryOf(p.usage)} |`);
  files.set(
    'index.md',
    `# CLI reference\n\nEvery \`lazy\` command, generated from the usage text each command prints for \`--help\`.\n\n| Command | Summary |\n| --- | --- |\n${rows.join('\n')}\n`,
  );
  return files;
}

export async function generate(outDir: string): Promise<void> {
  const files = render(await collectPages());
  await mkdir(outDir, { recursive: true });
  for (const f of await readdir(outDir)) {
    if (f.endsWith('.md') && !files.has(f)) await rm(join(outDir, f));
  }
  for (const [name, body] of files) await writeFile(join(outDir, name), body);
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(ROOT, 'public-docs/reference/cli');
  await generate(out);
  console.log(`wrote CLI reference to ${out}`);
}
