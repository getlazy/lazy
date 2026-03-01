/**
 * Diff rendering for the lazy server
 *
 * Parses unified diff format and renders as side-by-side or unified HTML.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'header';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for diff --git header
    if (lines[i].startsWith('diff --git ')) {
      const diffHeader = lines[i];
      const pathMatch = diffHeader.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      const oldPath = pathMatch?.[1] ?? '(unknown)';
      const newPath = pathMatch?.[2] ?? '(unknown)';

      const file: DiffFile = { oldPath, newPath, hunks: [] };
      i++;

      // Skip index, ---/+++ lines
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        i++;
      }

      // Parse hunks
      while (i < lines.length && !lines[i].startsWith('diff --git ')) {
        if (lines[i].startsWith('@@')) {
          const hunkHeader = lines[i];
          const hunkMatch = hunkHeader.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          let oldLine = hunkMatch ? parseInt(hunkMatch[1], 10) : 1;
          let newLine = hunkMatch ? parseInt(hunkMatch[2], 10) : 1;

          const hunk: DiffHunk = { header: hunkHeader, lines: [] };
          hunk.lines.push({ type: 'header', content: hunkHeader, oldLineNum: null, newLineNum: null });
          i++;

          while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
            const line = lines[i];
            if (line.startsWith('+')) {
              hunk.lines.push({ type: 'add', content: line.slice(1), oldLineNum: null, newLineNum: newLine });
              newLine++;
            } else if (line.startsWith('-')) {
              hunk.lines.push({ type: 'remove', content: line.slice(1), oldLineNum: oldLine, newLineNum: null });
              oldLine++;
            } else if (line.startsWith(' ') || line === '') {
              hunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, oldLineNum: oldLine, newLineNum: newLine });
              oldLine++;
              newLine++;
            } else if (line.startsWith('\\')) {
              // "\ No newline at end of file" - skip
            } else {
              // Unknown line format, treat as context
              hunk.lines.push({ type: 'context', content: line, oldLineNum: oldLine, newLineNum: newLine });
              oldLine++;
              newLine++;
            }
            i++;
          }

          file.hunks.push(hunk);
        } else {
          i++;
        }
      }

      files.push(file);
    } else {
      i++;
    }
  }

  return files;
}

/**
 * Render a unified diff as side-by-side HTML
 */
export function renderDiffSideBySide(diffText: string): string {
  if (!diffText.trim()) {
    return '<div class="empty-state">No changes</div>';
  }

  const files = parseDiff(diffText);
  if (files.length === 0) {
    return `<pre class="diff-raw">${escapeHtml(diffText)}</pre>`;
  }

  const parts: string[] = [];

  for (const file of files) {
    parts.push(`<div class="diff-file">`);
    parts.push(`<div class="diff-file-header">${escapeHtml(file.newPath)}</div>`);
    parts.push(`<table class="diff-table side-by-side">`);

    for (const hunk of file.hunks) {
      // Pair up remove/add lines for side-by-side display
      const sideBySideLines = buildSideBySideLines(hunk.lines);

      for (const pair of sideBySideLines) {
        if (pair.type === 'header') {
          parts.push(`<tr class="diff-hunk-header"><td colspan="4">${escapeHtml(pair.content)}</td></tr>`);
          continue;
        }

        const leftNum = pair.leftNum !== null ? String(pair.leftNum) : '';
        const rightNum = pair.rightNum !== null ? String(pair.rightNum) : '';
        const leftClass = pair.leftType === 'remove' ? 'diff-remove' : (pair.leftType === 'empty' ? 'diff-empty' : '');
        const rightClass = pair.rightType === 'add' ? 'diff-add' : (pair.rightType === 'empty' ? 'diff-empty' : '');

        parts.push(`<tr>`);
        parts.push(`<td class="diff-linenum ${leftClass}">${leftNum}</td>`);
        parts.push(`<td class="diff-code ${leftClass}">${escapeHtml(pair.leftContent)}</td>`);
        parts.push(`<td class="diff-linenum ${rightClass}">${rightNum}</td>`);
        parts.push(`<td class="diff-code ${rightClass}">${escapeHtml(pair.rightContent)}</td>`);
        parts.push(`</tr>`);
      }
    }

    parts.push(`</table></div>`);
  }

  return parts.join('\n');
}

/**
 * Render a unified diff in traditional unified format with syntax highlighting
 */
export function renderDiffUnified(diffText: string): string {
  if (!diffText.trim()) {
    return '<div class="empty-state">No changes</div>';
  }

  const files = parseDiff(diffText);
  if (files.length === 0) {
    return `<pre class="diff-raw">${escapeHtml(diffText)}</pre>`;
  }

  const parts: string[] = [];

  for (const file of files) {
    parts.push(`<div class="diff-file">`);
    parts.push(`<div class="diff-file-header">${escapeHtml(file.newPath)}</div>`);
    parts.push(`<table class="diff-table unified">`);

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'header') {
          parts.push(`<tr class="diff-hunk-header"><td colspan="3">${escapeHtml(line.content)}</td></tr>`);
        } else {
          const prefix = line.type === 'add' ? '+' : (line.type === 'remove' ? '-' : ' ');
          const cls = line.type === 'add' ? 'diff-add' : (line.type === 'remove' ? 'diff-remove' : '');
          const oldNum = line.oldLineNum !== null ? String(line.oldLineNum) : '';
          const newNum = line.newLineNum !== null ? String(line.newLineNum) : '';
          parts.push(`<tr class="${cls}"><td class="diff-linenum">${oldNum}</td><td class="diff-linenum">${newNum}</td><td class="diff-code">${escapeHtml(prefix + line.content)}</td></tr>`);
        }
      }
    }

    parts.push(`</table></div>`);
  }

  return parts.join('\n');
}

interface SideBySideLine {
  type: 'pair' | 'header';
  content: string;
  leftNum: number | null;
  leftContent: string;
  leftType: 'context' | 'remove' | 'empty';
  rightNum: number | null;
  rightContent: string;
  rightType: 'context' | 'add' | 'empty';
}

function buildSideBySideLines(lines: DiffLine[]): SideBySideLine[] {
  const result: SideBySideLine[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === 'header') {
      result.push({
        type: 'header',
        content: line.content,
        leftNum: null, leftContent: '', leftType: 'context',
        rightNum: null, rightContent: '', rightType: 'context',
      });
      i++;
      continue;
    }

    if (line.type === 'context') {
      result.push({
        type: 'pair',
        content: '',
        leftNum: line.oldLineNum,
        leftContent: line.content,
        leftType: 'context',
        rightNum: line.newLineNum,
        rightContent: line.content,
        rightType: 'context',
      });
      i++;
      continue;
    }

    // Collect consecutive removes then consecutive adds to pair them
    if (line.type === 'remove') {
      const removes: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'remove') {
        removes.push(lines[i]);
        i++;
      }
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'add') {
        adds.push(lines[i]);
        i++;
      }

      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const rem = j < removes.length ? removes[j] : null;
        const add = j < adds.length ? adds[j] : null;
        result.push({
          type: 'pair',
          content: '',
          leftNum: rem?.oldLineNum ?? null,
          leftContent: rem?.content ?? '',
          leftType: rem ? 'remove' : 'empty',
          rightNum: add?.newLineNum ?? null,
          rightContent: add?.content ?? '',
          rightType: add ? 'add' : 'empty',
        });
      }
      continue;
    }

    if (line.type === 'add') {
      result.push({
        type: 'pair',
        content: '',
        leftNum: null,
        leftContent: '',
        leftType: 'empty',
        rightNum: line.newLineNum,
        rightContent: line.content,
        rightType: 'add',
      });
      i++;
      continue;
    }

    i++;
  }

  return result;
}

/** CSS styles for diff rendering */
export const diffStyles = `
  .diff-file {
    margin-bottom: 16px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .diff-file-header {
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    font-weight: bold;
    font-size: 13px;
  }
  .diff-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    line-height: 1.4;
    table-layout: fixed;
  }
  .diff-table.side-by-side td.diff-linenum { width: 40px; }
  .diff-table.side-by-side td.diff-code { width: calc(50% - 40px); }
  .diff-table.unified td.diff-linenum { width: 50px; }
  .diff-table td {
    padding: 0 8px;
    vertical-align: top;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--font-mono);
  }
  .diff-linenum {
    color: var(--text-secondary);
    text-align: right;
    user-select: none;
    border-right: 1px solid var(--border);
    padding-right: 8px !important;
  }
  .diff-hunk-header td {
    background: rgba(56, 139, 253, 0.1);
    color: var(--text-secondary);
    padding: 4px 8px;
    font-size: 12px;
  }
  .diff-add {
    background: rgba(46, 160, 67, 0.15);
  }
  .diff-remove {
    background: rgba(248, 81, 73, 0.15);
  }
  .diff-empty {
    background: var(--bg-secondary);
  }
  .diff-raw {
    padding: 12px;
    font-size: 12px;
    overflow-x: auto;
  }
  .diff-view-toggle {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .diff-view-toggle a {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
  }
  .diff-view-toggle a.active {
    background: var(--link);
    color: #fff;
    border-color: var(--link);
  }
`;
