/**
 * Symbol table for review jump links — names declared in the parsed diff,
 * mapped to the existing line-anchor DOM id.
 *
 * No LLM. Scan added and context lines (the post-image) with per-language
 * declaration regexes. A name that appears in more than one changed file, or
 * twice in the same file, is omitted rather than guessed.
 *
 * Lives in its own module so `markdown.ts` never imports `review-diff.ts`
 * (that cycle is the reason the two linkifiers ship as tables passed in).
 */

import { anchorDomId, type DiffFile } from './review-diff';

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await',
  'typeof', 'new', 'throw', 'with', 'else', 'case', 'do', 'try', 'finally',
  'class', 'const', 'let', 'var', 'import', 'export', 'from', 'default',
  'yield', 'void', 'delete', 'in', 'of', 'instanceof', 'super', 'this',
]);

type Lang = 'js' | 'ruby' | 'python' | 'go' | 'rust';

function languageOf(path: string): Lang | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') {
    return 'js';
  }
  if (ext === 'rb') return 'ruby';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  return null;
}

/** Names declared on one source line, in left-to-right order. */
export function extractDeclarations(line: string, lang: Lang): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
    return [];
  }
  const names: string[] = [];
  const push = (m: RegExpMatchArray | null, group = 1) => {
    const name = m?.[group];
    if (name) names.push(name);
  };

  if (lang === 'js') {
    push(trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/));
    push(trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/));
    push(trimmed.match(/^(?:export\s+)?(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)\b/));
    const method = trimmed.match(
      /^(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (method && !JS_KEYWORDS.has(method[1]!)) names.push(method[1]!);
    return unique(names);
  }

  if (lang === 'ruby') {
    push(trimmed.match(/^(?:def\s+(?:self\.)?|class\s+|module\s+)([A-Za-z_]\w*)/));
    return unique(names);
  }

  if (lang === 'python') {
    push(trimmed.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/));
    return unique(names);
  }

  if (lang === 'go') {
    push(trimmed.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/));
    push(trimmed.match(/^type\s+([A-Za-z_]\w*)\s+/));
    return unique(names);
  }

  // rust
  push(trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/));
  push(trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/));
  return unique(names);
}

function unique(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  href: string;
}

/**
 * name → href for unique declarations in this diff.
 *
 * Hrefs always include the Changes tab path so a link from Landing or the
 * Raised dialog still lands on the row.
 */
export function buildSymbolTable(files: readonly DiffFile[], taskId: string): Map<string, string> {
  const hits = new Map<string, Hit | 'dup'>();
  for (const file of files) {
    const lang = languageOf(file.path);
    if (!lang) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== 'add' && line.kind !== 'context') continue;
        if (line.newLine == null) continue;
        for (const name of extractDeclarations(line.content, lang)) {
          const href = `/tasks/${taskId}/changes#${anchorDomId({
            file: file.path,
            side: 'new',
            line: line.newLine,
          })}`;
          const existing = hits.get(name);
          if (!existing) {
            hits.set(name, { file: file.path, line: line.newLine, href });
            continue;
          }
          if (existing === 'dup') continue;
          if (existing.file !== file.path || existing.line !== line.newLine) {
            hits.set(name, 'dup');
          }
        }
      }
    }
  }
  const lookup = new Map<string, string>();
  for (const [name, hit] of hits) {
    if (hit === 'dup') continue;
    lookup.set(name, hit.href);
  }
  return lookup;
}
