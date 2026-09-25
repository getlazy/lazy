/**
 * `window.lzMorph(target, source)` — a small keyed DOM morph.
 *
 * WHY HAND-ROLLED RATHER THAN IDIOMORPH
 * idiomorph is the obvious candidate (htmx adopted it) and vendoring it would
 * follow the mermaid pattern — an npm dependency, a text import, an
 * `/assets/*.js` route. It was not worth it here. The fragments this morphs are
 * server-rendered lists and tables whose repeated items already carry stable
 * identity (`data-viewed-key` on every card, `id` on subtask groups, and the
 * `data-lz-key` added alongside this), so the matching half of a general morph
 * is three lines. What this page actually needs that a general morph does NOT
 * give it is the PRESERVE list below: live form values and the attributes the
 * viewed-cards / navigation islands write client-side. Vendoring a library and
 * then wrapping it in this policy is more moving parts than the policy alone.
 *
 * WHAT IT PRESERVES, AND WHY THAT IS THE POINT
 * A refresh that clears a half-typed comment is a bug, not a redraw. So on a
 * node that already exists:
 *   - `value` / `checked` of inputs, textareas and selects are never written.
 *     The server's copy is a stale default; the live one is the human's draft.
 *   - the attributes islands own client-side (`data-viewed`, `data-collapsed`,
 *     `data-current`, `aria-expanded`, `open`, `hidden`, `style`) are neither
 *     set nor removed, so a collapsed card stays collapsed and an open
 *     `<details>` stays open.
 * Nodes that are genuinely NEW arrive exactly as the server rendered them, and
 * the caller re-runs `lzRefreshViewable()` so their view state is applied.
 *
 * OPAQUE SUBTREES
 * A node carrying `data-lz-live-children` (e.g. a shell-mount slot a live
 * terminal has been appended into) is matched like any other so it is not
 * torn down and rebuilt, but neither its attributes nor its children are
 * touched at all — not even the PRESERVE-list treatment above, which still
 * lets non-preserved attributes and non-keyed children be added/removed. The
 * server always renders that slot empty, so ordinary morphing would delete a
 * live terminal on the very next poll. This is stronger than the form-control
 * case (which still syncs attributes): the whole subtree is the client's.
 */

import { scriptJson } from './escape';

/** Attributes the client owns once the page is live. Never written, never removed. */
export const MORPH_PRESERVED_ATTRIBUTES = [
  'data-viewed',
  'data-collapsed',
  'data-current',
  'aria-expanded',
  'open',
  'hidden',
  'style',
] as const;

/** Marks a node whose whole subtree (attributes AND children) is client-owned. */
export const MORPH_LIVE_CHILDREN_ATTR = 'data-lz-live-children';

export function domMorphScript(): string {
  return `<script>
(function () {
  if (window.lzMorph) return;

  var PRESERVE = ${scriptJson([...MORPH_PRESERVED_ATTRIBUTES])};
  var PRESERVE_SET = {};
  for (var i = 0; i < PRESERVE.length; i++) PRESERVE_SET[PRESERVE[i]] = 1;
  var LIVE_CHILDREN_ATTR = ${scriptJson(MORPH_LIVE_CHILDREN_ATTR)};

  function ownsSubtree(el) {
    return el.nodeType === 1 && el.hasAttribute(LIVE_CHILDREN_ATTR);
  }

  function keyOf(node) {
    if (node.nodeType !== 1) return null;
    return node.getAttribute('id')
      || node.getAttribute('data-lz-key')
      || node.getAttribute('data-viewed-key')
      || null;
  }

  function isFormControl(el) {
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }

  function syncAttributes(target, source) {
    // On a live control, \`value\` and \`checked\` are the DEFAULT the form would
    // reset to. Writing the server's copy there arms a reset that would throw
    // away what the human typed, even though the property itself is dirty and
    // unaffected.
    var control = isFormControl(target);
    var srcAttrs = source.attributes;
    for (var i = 0; i < srcAttrs.length; i++) {
      var a = srcAttrs[i];
      if (PRESERVE_SET[a.name]) continue;
      if (control && (a.name === 'value' || a.name === 'checked')) continue;
      if (target.getAttribute(a.name) !== a.value) target.setAttribute(a.name, a.value);
    }
    var tgtAttrs = Array.prototype.slice.call(target.attributes);
    for (var j = 0; j < tgtAttrs.length; j++) {
      var name = tgtAttrs[j].name;
      if (PRESERVE_SET[name]) continue;
      if (control && (name === 'value' || name === 'checked')) continue;
      if (!source.hasAttribute(name)) target.removeAttribute(name);
    }
  }

  function morphNode(target, source) {
    if (target.nodeType !== source.nodeType) return false;
    if (target.nodeType === 3 || target.nodeType === 8) {
      if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
      return true;
    }
    if (target.nodeType !== 1) return true;
    if (target.tagName !== source.tagName) return false;
    // The server always renders this slot empty — do not touch it at all, or
    // a live terminal appended into it is deleted on the next poll.
    if (ownsSubtree(target)) return true;
    syncAttributes(target, source);
    // A live form control's value belongs to the human typing into it. The
    // server's markup carries whatever was stored when the page rendered.
    if (isFormControl(target)) return true;
    morphChildren(target, source);
    return true;
  }

  function morphChildren(target, source) {
    var keyed = {};
    var child = target.firstChild;
    while (child) {
      var k = keyOf(child);
      if (k) keyed[k] = child;
      child = child.nextSibling;
    }

    var cursor = target.firstChild;
    var next = source.firstChild;
    while (next) {
      var incoming = next;
      next = next.nextSibling;
      var key = keyOf(incoming);
      var match = null;
      if (key && keyed[key]) {
        match = keyed[key];
        delete keyed[key];
      } else if (!key && cursor && !keyOf(cursor) && cursor.nodeType === incoming.nodeType
                 && (cursor.nodeType !== 1 || cursor.tagName === incoming.tagName)) {
        match = cursor;
      }
      if (match) {
        if (match !== cursor) target.insertBefore(match, cursor);
        else cursor = cursor.nextSibling;
        if (!morphNode(match, incoming)) {
          var fresh = incoming.cloneNode(true);
          target.replaceChild(fresh, match);
        }
      } else {
        target.insertBefore(incoming.cloneNode(true), cursor);
      }
    }

    // Anything left after the source ran out, plus keyed nodes the server no
    // longer sends, is gone.
    while (cursor) {
      var doomed = cursor;
      cursor = cursor.nextSibling;
      target.removeChild(doomed);
    }
    for (var leftover in keyed) {
      if (keyed[leftover].parentNode === target) target.removeChild(keyed[leftover]);
    }
  }

  /**
   * Morph \`target\`'s subtree to match \`source\`'s, preserving node identity.
   * Both are elements; \`source\` is detached markup and is not reused.
   */
  window.lzMorph = function (target, source) {
    if (!target || !source) return false;
    morphChildren(target, source);
    syncAttributes(target, source);
    return true;
  };
})();
</script>`;
}
