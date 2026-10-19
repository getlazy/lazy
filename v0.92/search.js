/*
 * Offline search for the lazy docs site. Plain script: no dependency, no network,
 * no fetch (it must work from file://). It reads the global window.LAZY_DOCS_INDEX
 * written by the site generator (search-index.js) and adds a search box to the header.
 *
 * Index shape: { v: 1, pages: [{ p: 'how-to/x', t: 'Title', s: [[heading, id, body], ...] }] }
 * The first section of a page is the text before its first heading (heading '' and id '').
 */
(function () {
  'use strict';

  var MAX_RESULTS = 10;
  var W_TITLE = 30;
  var W_HEADING = 15;
  var W_BODY = 3;
  // A word found in the help text of a command (a flag, say) beats the same
  // word in a how-to's prose: the reader typing `--env-file` wants the command.
  var W_CLI = 12;
  var CLI_PREFIX = 'reference/cli/';

  function terms(query) {
    return String(query).toLowerCase().split(/\s+/).filter(Boolean);
  }

  function snippet(body, ts) {
    if (!body) return '';
    var lower = body.toLowerCase();
    var at = -1;
    for (var i = 0; i < ts.length; i++) {
      var found = lower.indexOf(ts[i]);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    if (at === -1) return body.length > 120 ? body.slice(0, 120) + '…' : body;
    var start = Math.max(0, at - 40);
    var end = Math.min(body.length, start + 130);
    return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
  }

  /**
   * Rank the index against a query. Every word must match somewhere in a section
   * (page title, heading or body); a title match outranks a heading match, which
   * outranks a body match. One result per page: its best section.
   */
  function search(index, query) {
    var ts = terms(query);
    if (ts.length === 0 || !index || !index.pages) return [];
    var phrase = ts.join(' ');
    var results = [];
    index.pages.forEach(function (page, order) {
      var title = page.t.toLowerCase();
      var best = null;
      page.s.forEach(function (section) {
        var heading = section[0].toLowerCase();
        var body = section[2].toLowerCase();
        var score = 0;
        for (var i = 0; i < ts.length; i++) {
          var w = 0;
          if (title.indexOf(ts[i]) !== -1) w = W_TITLE;
          else if (heading.indexOf(ts[i]) !== -1) w = W_HEADING;
          else if (body.indexOf(ts[i]) !== -1) w = page.p.indexOf(CLI_PREFIX) === 0 ? W_CLI : W_BODY;
          if (w === 0) return;
          score += w;
        }
        if (title.indexOf(phrase) !== -1) score += 20;
        if (heading !== '' && heading.indexOf(phrase) !== -1) score += 10;
        if (best === null || score > best.score) {
          best = { score: score, order: order, page: page, section: section };
        }
      });
      if (best) results.push(best);
    });
    results.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    return results.slice(0, MAX_RESULTS).map(function (r) {
      var heading = r.section[0];
      return {
        path: r.page.p,
        title: r.page.t,
        heading: heading === r.page.t ? '' : heading,
        // The title heading is the top of the page: no anchor.
        id: heading === r.page.t ? '' : r.section[1],
        snippet: snippet(r.section[2], ts),
        score: r.score,
      };
    });
  }

  /** Link built the way the generator builds links: directory links, or an explicit index.html. */
  function href(root, local, result) {
    var path = result.path === '' ? '' : result.path + '/';
    return root + path + (local ? 'index.html' : '') + (result.id ? '#' + result.id : '');
  }

  var api = { search: search, href: href };
  window.LazyDocsSearch = api;

  var script = document.currentScript;
  if (!script || !window.LAZY_DOCS_INDEX) return;
  var root = script.getAttribute('data-root') || './';
  var local = script.getAttribute('data-local') === '1';
  var host = document.querySelector('header.site .wrap');
  if (!host) return;

  var box = document.createElement('div');
  box.className = 'search';
  var input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search docs (/)';
  input.setAttribute('aria-label', 'Search the documentation');
  input.setAttribute('autocomplete', 'off');
  var list = document.createElement('ul');
  list.className = 'results';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  box.appendChild(input);
  box.appendChild(list);
  host.appendChild(box);

  var links = [];
  var active = -1;

  function setActive(n) {
    if (links.length === 0) return;
    active = (n + links.length) % links.length;
    links.forEach(function (a, i) {
      if (i === active) a.setAttribute('aria-selected', 'true');
      else a.removeAttribute('aria-selected');
    });
    links[active].scrollIntoView({ block: 'nearest' });
  }

  function close() {
    list.hidden = true;
    links = [];
    active = -1;
  }

  function render() {
    var q = input.value;
    list.textContent = '';
    links = [];
    active = -1;
    if (q.trim() === '') { close(); return; }
    var found = search(window.LAZY_DOCS_INDEX, q);
    if (found.length === 0) {
      var none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'No matches';
      list.appendChild(none);
    }
    found.forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = href(root, local, r);
      var t = document.createElement('strong');
      t.textContent = r.title + (r.heading ? ' › ' + r.heading : '');
      a.appendChild(t);
      if (r.snippet) {
        var s = document.createElement('span');
        s.textContent = r.snippet;
        a.appendChild(s);
      }
      li.appendChild(a);
      list.appendChild(li);
      links.push(a);
    });
    list.hidden = false;
    if (links.length > 0) setActive(0);
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', function () { if (input.value.trim() !== '') render(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      if (active >= 0) {
        e.preventDefault();
        var target = links[active].href;
        close();
        window.location.href = target;
      }
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  document.addEventListener('click', function (e) {
    // A click on a result also closes: a same-page hash link does not reload.
    if (!box.contains(e.target) || (e.target.closest && e.target.closest('a'))) close();
  });
})();
