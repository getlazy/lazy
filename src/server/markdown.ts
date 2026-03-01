/**
 * Lightweight Markdown to HTML renderer
 *
 * Handles the common Markdown constructs found in lazy turns:
 * - Headings (#, ##, ###, etc.)
 * - Code blocks (``` with language)
 * - Inline code (`code`)
 * - Bold (**text**) and italic (*text*)
 * - Links [text](url)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Blockquotes (> text)
 * - Horizontal rules (---)
 * - Paragraphs
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  let result = escapeHtml(text);

  // Inline code (must be before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (single asterisk, not preceded/followed by space for ambiguity)
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  let i = 0;
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  function closeList(): void {
    if (inList) {
      output.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks
    if (line.trimStart().startsWith('```')) {
      closeList();
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      output.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      output.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      output.push('<hr>');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      output.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        output.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      output.push(`<li>${renderInline(ulMatch[2])}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        output.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      output.push(`<li>${renderInline(olMatch[2])}</li>`);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }

    // Paragraph - collect consecutive non-empty lines
    closeList();
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^#{1,6}\s/) && !lines[i].trimStart().startsWith('```') && !lines[i].startsWith('> ') && !lines[i].match(/^(\s*)[-*+]\s+/) && !lines[i].match(/^(\s*)\d+\.\s+/) && !/^(\-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      output.push(`<p>${renderInline(paraLines.join('\n'))}</p>`);
    }
  }

  closeList();
  return output.join('\n');
}
