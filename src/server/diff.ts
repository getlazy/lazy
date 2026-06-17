/**
 * Diff rendering for the lazy server
 *
 * Uses @pierre/diffs for syntax-highlighted, feature-rich diff rendering.
 * The SSR API generates pre-rendered HTML that is placed inside <diffs-container>
 * web components. A small client-side script registers the web component which
 * creates Shadow DOM and applies styles.
 */

import { preloadPatchFile } from '@pierre/diffs/ssr';
import type { FileDiffOptions } from '@pierre/diffs';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a unified diff using @pierre/diffs SSR.
 *
 * Returns HTML containing <diffs-container> web components (one per file)
 * with pre-rendered diff content. The companion `diffScripts` must be
 * included on the page to register the web component.
 */
export async function renderDiff(
  diffText: string,
  mode: 'split' | 'unified' = 'split',
): Promise<string> {
  if (!diffText.trim()) {
    return '<div class="empty-state">No changes</div>';
  }

  const options: FileDiffOptions<undefined> = {
    diffStyle: mode,
    theme: { dark: 'github-dark', light: 'github-light' },
  };

  try {
    const results = await preloadPatchFile({ patch: diffText, options });

    if (results.length === 0) {
      return `<pre class="diff-raw">${escapeHtml(diffText)}</pre>`;
    }

    const parts: string[] = [];

    for (const result of results) {
      const fileName = result.fileDiff?.name ?? '(unknown)';
      const additions = result.fileDiff?.additionLines?.length ?? 0;
      const deletions = result.fileDiff?.deletionLines?.length ?? 0;

      parts.push(`<div class="diff-file">`);
      parts.push(`<div class="diff-file-header" data-diff-collapsed="false">`);
      parts.push(`<span class="diff-file-toggle">&#9660;</span> `);
      parts.push(`<span class="diff-file-name">${escapeHtml(fileName)}</span>`);
      parts.push(`<span class="diff-file-stats">`);
      if (additions > 0) parts.push(`<span class="diff-stat-add">+${additions}</span>`);
      if (deletions > 0) parts.push(`<span class="diff-stat-del">-${deletions}</span>`);
      parts.push(`</span>`);
      parts.push(`</div>`);
      parts.push(`<div class="diff-file-content">`);
      parts.push(`<diffs-container>${result.prerenderedHTML}</diffs-container>`);
      parts.push(`</div>`);
      parts.push(`</div>`);
    }

    return parts.join('\n');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `<pre class="diff-raw">${escapeHtml(diffText)}</pre>
<div class="diff-error">Diff rendering failed: ${escapeHtml(message)}</div>`;
  }
}

/** CSS styles for diff file wrappers (the diffs themselves are styled by @pierre/diffs) */
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
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .diff-file-header:hover {
    background: var(--border);
  }
  .diff-file-toggle {
    font-size: 10px;
    transition: transform 0.15s;
  }
  .diff-file-header[data-diff-collapsed="true"] .diff-file-toggle {
    transform: rotate(-90deg);
  }
  .diff-file-header[data-diff-collapsed="true"] + .diff-file-content {
    display: none;
  }
  .diff-file-name {
    font-weight: bold;
    font-family: var(--font-mono);
  }
  .diff-file-stats {
    margin-left: auto;
    font-size: 12px;
    display: flex;
    gap: 8px;
  }
  .diff-stat-add {
    color: #16a34a;
  }
  .diff-stat-del {
    color: #dc2626;
  }
  .diff-file-content {
    overflow-x: auto;
  }
  diffs-container {
    display: block;
  }
  .diff-raw {
    padding: 12px;
    font-size: 12px;
    overflow-x: auto;
  }
  .diff-error {
    padding: 8px 12px;
    color: #dc2626;
    font-size: 12px;
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

/**
 * Client-side script that registers the <diffs-container> web component
 * and handles file collapse/expand. Include once per page that shows diffs.
 */
export const diffScripts = `
<script type="module">
// Register the diffs-container web component
if (!customElements.get('diffs-container')) {
  class DiffsContainer extends HTMLElement {
    constructor() {
      super();
      if (this.shadowRoot != null) return;
      const shadow = this.attachShadow({ mode: 'open' });
      // Move pre-rendered content into shadow DOM
      while (this.firstChild) {
        shadow.appendChild(this.firstChild);
      }
    }
  }
  customElements.define('diffs-container', DiffsContainer);
}

// File collapse/expand toggle
document.addEventListener('click', function(e) {
  const header = e.target.closest('.diff-file-header');
  if (!header) return;
  const collapsed = header.getAttribute('data-diff-collapsed') === 'true';
  header.setAttribute('data-diff-collapsed', collapsed ? 'false' : 'true');
});
</script>
`;
