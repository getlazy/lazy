/**
 * Markdown formatting utilities for terminal output.
 */

import { ansi } from './ansi';

/**
 * Format markdown text for terminal display with ANSI color codes.
 * Handles headers, bold, code blocks, and list items.
 */
export function formatMarkdown(text: string): string[] {
  // Convert literal \n escape sequences to actual newlines
  // (can happen when prompts are stored in JSON or passed via CLI with escaped newlines)
  text = text.replace(/\\n/g, '\n');
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(ansi.dim + line + ansi.reset);
      continue;
    }

    if (inCodeBlock) {
      result.push(ansi.dim + line + ansi.reset);
      continue;
    }

    // Headers
    if (line.startsWith('#### ')) {
      result.push(ansi.bold + line.substring(5) + ansi.reset);
    } else if (line.startsWith('### ')) {
      result.push(ansi.bold + ansi.fg.cyan + line.substring(4) + ansi.reset);
    } else if (line.startsWith('## ')) {
      result.push(ansi.bold + ansi.fg.blue + line.substring(3) + ansi.reset);
    } else if (line.startsWith('# ')) {
      result.push(ansi.bold + ansi.fg.magenta + line.substring(2) + ansi.reset);
    }
    // Bold markers: **text**
    else if (line.includes('**')) {
      let formatted = line;
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, ansi.bold + '$1' + ansi.reset);
      result.push(formatted);
    }
    // List items
    else if (line.match(/^\s*[-*]\s/)) {
      result.push(ansi.fg.cyan + '•' + ansi.reset + line.substring(line.indexOf('-') + 1 || line.indexOf('*') + 1));
    }
    // Numbered list
    else if (line.match(/^\s*\d+\.\s/)) {
      result.push(ansi.fg.cyan + line + ansi.reset);
    }
    else {
      result.push(line);
    }
  }

  return result;
}
