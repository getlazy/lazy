/**
 * The task page's Artifacts tab: every file attached to the task (inputs a
 * human handed in, outputs the agent published), with download, inline
 * preview, and an upload form for a new input.
 *
 * Reads and writes go through the same Storage artifact methods the CLI
 * (`lazy artifact`) and MCP (`lazy_artifact_*`) use — there is no second
 * storage path. The bytes route ({@link artifactFileResponse}) is the only
 * place content leaves the dashboard, and it is where the safety rules live.
 */

import type { TaskArtifact, TaskArtifactContent } from '../types';
import { formatArtifactBytes, MAX_ARTIFACT_BYTES } from '../artifacts/limits';
import { escapeHtml } from './escape';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import { timestampHtml } from './timestamps';

/** Raster types a browser shows as a picture and never executes. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/**
 * The lowercased, parameter-free MIME type when it is one the browser may show
 * inline on the dashboard's own origin, else null.
 *
 * An ALLOWLIST over the normalized type, because the stored MIME string is
 * caller-supplied (an agent may set any value): a denylist of the exact
 * spelling `image/svg+xml` let `image/SVG+XML` or `image/svg+xml; charset=…`
 * through. SVG is a document that can carry script.
 */
export function inlineImageType(mimeType: string): string | null {
  const bare = mimeType.split(';')[0]!.trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(bare) ? bare : null;
}

export function isInlineImage(mimeType: string): boolean {
  return inlineImageType(mimeType) !== null;
}

function isMarkdown(a: TaskArtifact): boolean {
  return a.mime_type === 'text/markdown' || /\.(md|markdown)$/i.test(a.name);
}

/** Text shown as a preview. HTML and SVG are text too, but shown as SOURCE, never rendered. */
export function hasTextPreview(a: TaskArtifact): boolean {
  return !a.binary;
}

export function artifactFileHref(seg: string, name: string, download = false): string {
  return `/tasks/${seg}/artifacts/file?name=${encodeURIComponent(name)}${download ? '&download=1' : ''}`;
}

export interface ArtifactsTabInput {
  /** The task's URL segment, already escaped (task-urls). */
  taskId: string;
  artifacts: TaskArtifact[];
  /** Decoded text of the non-binary artifacts, keyed by name. Missing = no preview. */
  texts?: ReadonlyMap<string, string>;
  markdown?: RenderMarkdownOptions;
  /** A one-line result of the last upload (from the redirect's query). */
  notice?: { text: string; error?: boolean } | null;
}

function previewHtml(seg: string, a: TaskArtifact, text: string | undefined, markdown?: RenderMarkdownOptions): string {
  if (isInlineImage(a.mime_type)) {
    return `<a href="${escapeHtml(artifactFileHref(seg, a.name))}" target="_blank" rel="noopener">` +
      `<img class="lz-artifact-image" src="${escapeHtml(artifactFileHref(seg, a.name))}" alt="${escapeHtml(a.name)}" loading="lazy"></a>`;
  }
  if (text === undefined) return '';
  if (isMarkdown(a)) {
    return `<div class="lz-artifact-text markdown-body">${renderMarkdown(text, markdown)}</div>`;
  }
  return `<pre class="lz-artifact-text">${escapeHtml(text)}</pre>`;
}

function rowHtml(seg: string, a: TaskArtifact, text: string | undefined, markdown?: RenderMarkdownOptions): string {
  const preview = previewHtml(seg, a, text, markdown);
  const originTag = a.origin === 'output'
    ? `<span class="tag tag-neutral" title="Published by the task">output</span>`
    : `<span class="tag tag-neutral" title="Handed to the task's agent">input</span>`;
  // Images open by default — a screenshot is the thing a reviewer came for;
  // text stays folded so a long log does not bury the rest of the list.
  const open = isInlineImage(a.mime_type) ? ' open' : '';
  return `
        <li class="lz-artifact" data-artifact-name="${escapeHtml(a.name)}">
          <div class="lz-artifact-head">
            <code class="lz-artifact-name">${escapeHtml(a.name)}</code>
            ${originTag}
            <span class="text-muted">${escapeHtml(formatArtifactBytes(a.size))} · ${escapeHtml(a.mime_type)} · added by ${escapeHtml(a.created_by)} ${timestampHtml(a.created_at)}</span>
            <a class="btn btn-sm" href="${escapeHtml(artifactFileHref(seg, a.name, true))}" download>Download</a>
          </div>
          ${preview ? `<details class="lz-artifact-preview"${open}><summary>Preview</summary>${preview}</details>` : ''}
        </li>`;
}

function uploadFormHtml(seg: string): string {
  return `
      <form method="post" action="/tasks/${escapeHtml(seg)}/artifacts/upload" enctype="multipart/form-data" class="lz-artifact-upload">
        <h3>Add an input file</h3>
        <p class="rv-hint">The agent finds it in <code>.lazy-task-sandbox/artifacts/</code> on its next turn. Adding a file never starts a turn. A file with the same name replaces the old one. Up to ${escapeHtml(formatArtifactBytes(MAX_ARTIFACT_BYTES))} per file.</p>
        <label>File <input type="file" name="file" required></label>
        <label>Name (optional) <input class="input" type="text" name="name" placeholder="e.g. design/mockup.png"></label>
        <div class="rv-form-actions"><button type="submit" class="btn">Upload</button></div>
      </form>`;
}

export function artifactsTabHtml(input: ArtifactsTabInput): string {
  const { taskId: seg, artifacts } = input;
  const ordered = [...artifacts].sort((a, b) => a.name.localeCompare(b.name));
  const notice = input.notice
    ? `<div class="rv-notice${input.notice.error ? ' rv-notice-err' : ''}">${escapeHtml(input.notice.text)}</div>`
    : '';
  const list = ordered.length
    ? `<ul class="lz-artifact-list">${ordered.map((a) => rowHtml(seg, a, input.texts?.get(a.name), input.markdown)).join('')}</ul>`
    : `<p class="lz-empty-tab">No artifacts. Artifacts are files attached to a task — screenshots and reports its agent publishes, and input files handed to it. Add one below, or with <code>lazy artifact add &lt;task&gt; &lt;file&gt;</code>.</p>`;
  return `
      <div class="detail-section">
        <h2>Artifacts (${artifacts.length})</h2>
        ${notice}
        ${list}
        ${uploadFormHtml(seg)}
      </div>`;
}

/** Filename for a Content-Disposition header: the last path segment, RFC 5987-encoded. */
function dispositionOf(kind: 'inline' | 'attachment', name: string): string {
  const base = name.split('/').pop() || 'artifact';
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // A header value, not HTML: the ASCII fallback already has quotes and
  // backslashes replaced.
  return kind + '; filename="' + ascii + '"; filename*=UTF-8\'\'' +encodeURIComponent(base);
}

/**
 * The bytes of one artifact, with headers that never let its content run on
 * the dashboard's origin.
 *
 * Only a non-SVG image is served `inline`, under its own type. Everything else
 * — HTML, SVG, text, archives — is an ATTACHMENT, and a type the browser cannot
 * execute is not what stops it: `nosniff` plus a `sandbox` CSP make even a
 * direct navigation to the URL inert. Text previews never come through here;
 * the tab renders them escaped server-side.
 */
export function artifactFileResponse(artifact: TaskArtifactContent, download: boolean): Response {
  const image = inlineImageType(artifact.mime_type);
  const inline = !download && image !== null;
  return new Response(Buffer.from(artifact.content_base64, 'base64'), {
    headers: {
      'Content-Type': inline ? image! : artifact.mime_type || 'application/octet-stream',
      'Content-Disposition': dispositionOf(inline ? 'inline' : 'attachment', artifact.name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    },
  });
}
