// The two HTML pages: the home page (a form plus the newest links) and a
// link's stats page. Plain template strings; there is no frontend build.

import type { Link, LinkStats } from './store';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.6rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 2rem; }
  input { padding: .4rem .6rem; font: inherit; }
  input[name=url] { flex: 1 1 16rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #eee; }
  .muted { color: #777; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function homePage(links: Link[]): string {
  const rows = links.map(link => `
    <tr>
      <td><a href="/${escapeHtml(link.slug)}">/${escapeHtml(link.slug)}</a></td>
      <td>${escapeHtml(link.url)}</td>
      <td><a href="/links/${escapeHtml(link.slug)}/stats">stats</a></td>
    </tr>`).join('');

  return layout('Linkshelf', `
<h1>Linkshelf</h1>
<p class="muted">A tiny link shortener.</p>
<form method="post" action="/links">
  <input name="url" type="url" placeholder="https://example.com/a/long/address" required>
  <input name="slug" placeholder="custom slug (optional)">
  <button type="submit">Shorten</button>
</form>
${links.length === 0
    ? '<p class="muted">No links yet.</p>'
    : `<table><tr><th>Short</th><th>Goes to</th><th></th></tr>${rows}</table>`}
`);
}

export function statsPage(stats: LinkStats): string {
  const last = stats.lastClickedAt === null ? 'never' : new Date(stats.lastClickedAt).toISOString();
  return layout(`/${stats.slug} · Linkshelf`, `
<h1>/${escapeHtml(stats.slug)}</h1>
<p>Goes to <a href="${escapeHtml(stats.url)}">${escapeHtml(stats.url)}</a></p>
<p><strong>${stats.clicks}</strong> click${stats.clicks === 1 ? '' : 's'}, last ${escapeHtml(last)}</p>
<p><a href="/">← all links</a></p>
`);
}
