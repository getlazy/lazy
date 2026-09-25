/**
 * Review page navigation — prev/next controls, keyboard shortcuts, and the
 * explicit "current card" state (src/server/review-navigation.ts), plus the
 * approve⇒viewed rule.
 *
 * SCOPE OF THESE TESTS, stated plainly: this project has no DOM harness, so
 * the island's BEHAVIOR (the initialization rule, key handling, scrolling) is
 * not executed here. What these tests execute is the server-side rendering —
 * the markup contract (controls present, hidden without JS, one shared
 * viewable-section island) — and they pin the load-bearing wiring of the
 * emitted script as text, so that removing or renaming a seam the design
 * depends on fails a test instead of silently shipping a page whose shortcuts
 * do nothing.
 */

import { describe, test, expect } from 'bun:test';
import {
  reviewNavControlsHtml,
  reviewNavigationScript,
} from '../../src/server/review-navigation';

/**
 * The legend markup the island seeds into `innerHTML`.
 *
 * It travels as a JSON string (src/server/escape.ts's scriptJson, not a bare
 * JSON.stringify — the HTML parser ends a <script> at the first `</script`,
 * whoever wrote it), so these assertions decode it rather than matching its
 * escaped spelling: what matters is the legend's CONTENT, not its encoding.
 */
function seededLegend(js: string): string {
  const seed = js.match(/legend\.innerHTML = (".*?");/);
  if (!seed) throw new Error('no legend seed found in the navigation island');
  return JSON.parse(seed[1]!) as string;
}

import { reviewTaskHtml } from '../../src/server/review';
import { fileSectionId } from '../../src/server/review-diff';
import { bundledStylesheet } from '../../src/server/styles';
import type { Task } from '../../src/types';

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

function task(): Task {
  return {
    id: 'task1234abcd',
    code: 'demo-task',
    goal: 'Do the thing',
    prompt: 'The prompt body',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
  } as unknown as Task;
}

describe('nav controls markup', () => {
  // Unlabeled <prev next> sat next to `?` with no explanation (the engineer
  // complaint). j/k still move between cards; only `?` ships. Hidden until
  // the island unhides it, same as every JS-only control.
  test('help ships hidden; unlabeled section prev/next do not', () => {
    const html = reviewNavControlsHtml();
    expect(html).toMatch(/<span class="rv-nav" hidden data-rv-nav>/);
    expect(html).not.toContain('data-rv-nav-prev');
    expect(html).not.toContain('data-rv-nav-next');
    expect(html).toContain('data-rv-nav-help');
  });

  test('the review page renders the help control and the navigation island', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    expect(html).toContain('data-rv-nav');
    expect(html).toContain('data-rv-nav-help');
    expect(html).not.toContain('data-rv-nav-next');
    // The island itself is emitted (identified by its section selector +
    // current-state attribute wiring).
    expect(html).toContain("'.rv-viewable[data-viewed-key]'");
    expect(html).toContain('data-current');
  });
});

/**
 * p/n ARE ALIASES OF k/j, on every page.
 *
 * They were briefly overloaded: a page could declare itself one item of a
 * sequence (PageStepNav) and p/n would then LEAVE it for the previous/next
 * item. The only page that did was the turn detail page, which is gone — a
 * turn now opens inside its chunk on the Turns tab. The option, its controls,
 * its legend branch and the STEPS variable went with it rather than staying as
 * an unused branch with passing tests, which is harder to remove later than
 * unused code without them. If a genuinely sequential page appears, the shape
 * is in git history at this commit.
 */
describe('p/n are aliases of k/j', () => {
  test('the island has no page-stepping branch left', () => {
    const js = reviewNavigationScript();
    expect(js).not.toContain('STEPS');
    expect(js).not.toContain('function step(');
    expect(js).toMatch(/case 'n': move\(1\);/);
    expect(js).toMatch(/case 'p': move\(-1\);/);
  });

  test('the controls are the ? help and nothing else', () => {
    const html = reviewNavControlsHtml();
    expect(html).toContain('data-rv-nav-help');
    expect(html).not.toContain('data-rv-step');
    expect(html).not.toContain('data-rv-nav-prev');
    expect(html).not.toContain('data-rv-nav-next');
  });

  test('the legend documents the aliases and keeps approve/reject', () => {
    const legend = seededLegend(reviewNavigationScript());
    expect(legend).toContain('<kbd>j / n</kbd>');
    expect(legend).toContain('<kbd>k / p</kbd>');
    expect(legend).toContain('approve the current protected file');
  });
});

describe('navigation island wiring (script text — not executed, no DOM harness)', () => {
  const js = reviewNavigationScript();

  // The island must drive the SAME sections the shared viewable island drives
  // (viewed-cards.ts): files and markdown cards, one contract, one sequence.
  test('navigates the shared viewable-section contract', () => {
    expect(js).toContain("'.rv-viewable[data-viewed-key]'");
  });

  // "Current card" is explicit state on exactly one section — an attribute,
  // not a scroll-derived guess. The island sets it, clears all others, and
  // click-inside-a-card claims it.
  test('current card is a data-current attribute, claimed by click', () => {
    expect(js).toContain("setAttribute('data-current', '')");
    expect(js).toContain("removeAttribute('data-current')");
    expect(js).toMatch(/addEventListener\('click',[\s\S]*closest[\s\S]*setCurrent\(section\)/);
  });

  // The initialization rule: when navigation begins with no current card, the
  // first section whose top is at or below the viewport top becomes current —
  // and the first move SELECTS it rather than skipping past it.
  test('initialization picks the first section at/below the viewport top', () => {
    expect(js).toContain('getBoundingClientRect().top >= 0');
    expect(js).toMatch(/idx < 0[\s\S]*navigateTo\(firstOnScreen\(secs\)\)/);
  });

  // Navigating to a collapsed section used to expand it without clearing the
  // Viewed tick — the card opened, the checkbox stayed checked. n/p/j/k now
  // scroll and focus only; a viewed card stays collapsed. Re-opening is the
  // chevron (viewed-cards.ts), which clears the tick.
  test('navigating to a viewed card leaves it collapsed and focuses it', () => {
    expect(js).not.toMatch(/function navigateTo\(section, target\) \{[\s\S]*dataset\.collapsed === '1'[\s\S]*dataset\.collapsed = '0'/);
    expect(js).toContain('window.scrollTo');
    expect(js).toMatch(/function navigateTo\(section, target\) \{[\s\S]*setAttribute\('tabindex', '-1'\)/);
    expect(js).toMatch(/function navigateTo\(section, target\) \{[\s\S]*section\.focus\(\{ preventScroll: true \}\)/);
  });

  // j/k move the current card within the page, and n/p are aliases of them on
  // every page (see the "p/n are aliases of k/j" describe above).
  test('keyboard map: j/n next, k/p prev, v viewed, a approve, r reject, ? legend', () => {
    expect(js).toMatch(/case 'j': move\(1\);/);
    expect(js).toMatch(/case 'k': move\(-1\);/);
    expect(js).toMatch(/case 'n': move\(1\);/);
    expect(js).toMatch(/case 'p': move\(-1\);/);
    expect(js).toMatch(/case 'v': toggleViewed\(\);/);
    expect(js).toMatch(/case 'a': decide\('1'\);/);
    expect(js).toMatch(/case 'r': decide\('0'\);/);
    expect(js).toMatch(/case '\?': toggleLegend\(\);/);
    expect(js).toContain("case '[': switchTab(-1);");
    expect(js).toContain("case ']': switchTab(1);");
    expect(js).toContain('jumpTab(parseInt(ev.key, 10) - 1)');
    expect(seededLegend(js)).toContain('<h3>Tabs</h3>');
  });

  // Never intercept keys while typing or while a dialog is open — the accept
  // dialog takes real text; stealing 'a' from it would be a disaster.
  test('shortcuts yield to inputs and open dialogs', () => {
    expect(js).toMatch(/tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/);
    expect(js).toContain('isContentEditable');
    expect(js).toContain("querySelector('dialog[open]')");
  });

  // 'v' routes through the shared island: it ticks the section's own checkbox
  // and dispatches change, so persistence/collapse/count stay in one place.
  test("'v' toggles the section's own .rv-viewed-box via a change event", () => {
    expect(js).toMatch(
      /querySelector\('\.rv-viewed-box'\)[\s\S]*box\.checked = nowViewed;[\s\S]*dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/,
    );
  });

  // TICKING MEANS MOVING ON: 'v' marks viewed AND advances, because the point
  // of ticking a section off is to get to the next one. Un-viewing is a
  // correction and must NOT advance — hence the guard, not a bare move(1).
  test("'v' advances after marking viewed, and only when it marked viewed", () => {
    expect(js).toMatch(/var nowViewed = !box\.checked;/);
    expect(js).toMatch(/dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);\s*\n\s*if \(nowViewed\) move\(1\);/);
    // n/j stay plain next — the tick is what advances, not every key.
    expect(js).toMatch(/case 'j': move\(1\);/);
    expect(js).toMatch(/case 'n': move\(1\);/);
  });

  test('the legend documents both halves of the v rule, Shift hints, and viewed-stay-collapsed', () => {
    expect(js).toContain('mark the current section Viewed and go to the next one');
    expect(js).toContain('un-view it and stay put');
    expect(js).toContain('show key hints next to the controls that have one');
    expect(js).toContain('Navigating to a Viewed section leaves it collapsed');
  });

  // 'a'/'r' click the REAL decision buttons, so the existing decision island
  // owns the POST — and only when the answer would actually change.
  test("'a'/'r' click the real .rv-decide buttons, skipping the standing answer", () => {
    expect(js).toContain("querySelector('.rv-decide')");
    expect(js).toMatch(/rv-decide-btn\[value=[\s\S]*rv-decide-on'\)\) return;[\s\S]*btn\.click\(\)/);
    // An interleaved leftover hunk card has no form — look up the file's one.
    expect(js).toContain('function decideForm(');
    expect(js).toContain('dataset.file');
  });

  // The accept-checklist hash (`#f-…`) must land ON the file card: expand
  // collapsed presentation groups, switch Presented/Raw if the target is
  // hidden, scroll it into view, mark it current, and focus it. Focus lives
  // in navigateTo so n/p and a hash use the same path.
  test('a file-section hash scrolls the card into view, marks it current, and focuses it', () => {
    expect(js).toContain('function revealFileHash(');
    expect(js).toMatch(/addEventListener\('hashchange', function \(\) \{ revealFileHash\(true\); \}\)/);
    // The load-time reveal still runs; what it does NOT do is claim the
    // reader acted. `isFreshNavigation()` answers that, so a reload reveals
    // and scrolls without taking a Viewed tick away.
    expect(js).toMatch(/setTimeout\(function \(\) \{ revealFileHash\(isFreshNavigation\(\)\); \}, 0\)/);
    expect(js).toContain("entries[0].type === 'navigate'");
    expect(js).toContain('data-file-section');
    expect(js).toContain('function openAncestors(');
    expect(js).toContain("n.tagName === 'DETAILS'");
    expect(js).toContain('function revealContainingView(');
    expect(js).toContain("setAttribute('tabindex', '-1')");
    expect(js).toMatch(/section\.focus\(\{ preventScroll: true \}\)/);
  });

  // INVARIANT: ONLY `#turn-<seq>` re-opens a ticked chunk. Re-opening CLEARS
  // the Viewed tick, and that tick is persisted to the review draft — it
  // follows the reviewer across reloads and devices. A note anchor
  // (`#comment-<id>`, `#journal-<id>`) is "show me what that said", not a
  // request to re-read the chunk, and silently rolling back recorded review
  // progress with no prompt and no undo is not something a note link may do.
  // The guard must therefore be an exact pattern, never "the hash names
  // something inside the section".
  test('only a turn anchor re-opens a ticked chunk', () => {
    // The exact pattern, and the collapse check gated behind it. `acted` is
    // the third condition — see the reload test below and the DOM-level
    // proof in test/e2e/turn-deeplink-viewed-state.test.ts.
    expect(js).toContain('if (acted && inner && inner !== section');
    expect(js).toContain('/^turn-\\d+$/.test(id)');
    expect(js).toMatch(
      /\/\^turn-\\d\+\$\/\.test\(id\)[\s\S]{0,120}dataset\.collapsed === '1'[\s\S]{0,120}rv-vw-toggle/,
    );
    // The toggle is CLICKED, not a second implementation of collapse state:
    // the chevron handler is what clears the tick, so the checkbox cannot lie.
    expect(js).toMatch(/querySelector\('\.rv-vw-toggle'\);\s*\n\s*if \(toggle\) toggle\.click\(\);/);
  });

  // INVARIANT: the reveal is told whether the reader ACTED; the hash merely
  // being in the URL is not the act. Without this a reload, a Back, or a
  // restored tab cleared the tick again — a persisted write on a plain GET,
  // which viewed-cards refuses to do (`SAVE_ON_LOAD = false`). The DOM-level
  // proof is test/e2e/turn-deeplink-viewed-state.test.ts; this pins the wiring.
  test('a load claims the act only when the navigation carried the hash', () => {
    // Never a bare `true` at the load call site.
    expect(js).not.toMatch(/setTimeout\(function \(\) \{ revealFileHash\(true\)/);
    expect(js).toContain('function isFreshNavigation()');
    expect(js).toContain("performance.getEntriesByType('navigation')");
    expect(js).toContain("entries[0].type === 'navigate'");
    // Unknown navigation type must not clear: the fallback is `false`.
    expect(js).toMatch(/catch \(e\) \{[^}]*\}\s*\n(\s*\/\/[^\n]*\n)*\s*return false;/);
  });

  // The behavioural statement of the same rule, read off the emitted source:
  // there is exactly one `.click()` on a chevron, and it is inside the
  // turn-anchor branch. A note anchor cannot reach it.
  test('no other path in the island clicks a chunk chevron', () => {
    const clicks = js.match(/rv-vw-toggle/g) ?? [];
    expect(clicks.length).toBe(1);
    const guardAt = js.indexOf('/^turn-\\d+$/.test(id)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(js.indexOf('rv-vw-toggle')).toBeGreaterThan(guardAt);
  });
});

describe('discoverable shortcuts (Shift-held key hints)', () => {
  const js = reviewNavigationScript();

  // Holding Shift is the discovery gesture; ~400ms so a Shift+key combo (like
  // typing '?') never flashes hints on its way through.
  test('a held Shift arms a delayed reveal, and releasing it hides again', () => {
    expect(js).toMatch(/ev\.key !== 'Shift'[\s\S]*setTimeout\([\s\S]*showHints\(\); \}, 400\)/);
    expect(js).toMatch(/addEventListener\('keyup'[\s\S]*ev\.key !== 'Shift'[\s\S]*hideHints\(\)/);
    // Alt-tabbing away with Shift down must not leave the hints stuck on.
    expect(js).toMatch(/addEventListener\('blur'[\s\S]*hideHints\(\)/);
  });

  // Hints attach to the REAL controls — never a parallel overlay that could
  // advertise a shortcut whose control is not on this page. A selector that
  // matches nothing is skipped rather than assumed, which is what lets the
  // tab-key hints sit in the same list as the page-wide help.
  test('hints attach to help, the tab keys and the current card’s own controls', () => {
    expect(js).toContain("[['[data-rv-nav-help]', '?']]");
    // The step controls are gone with the stepped page; no hint may advertise
    // a key whose control no longer exists.
    expect(js).not.toContain('data-rv-step');
    expect(js).toMatch(/var el = document\.querySelector\(STATIC_HINTS\[i\]\[0\]\);\s*\n\s*if \(el\) out\.push/);
    expect(js).toMatch(/currentSection\(\)[\s\S]*querySelector\('\.rv-viewed'\)[\s\S]*out\.push\(\[viewed, 'v'\]\)/);
    expect(js).toMatch(/rv-decide-btn\[value="1"\]'\)[\s\S]*out\.push\(\[yes, 'a'\]\)/);
    expect(js).toMatch(/rv-decide-btn\[value="0"\]'\)[\s\S]*out\.push\(\[no, 'r'\]\)/);
  });

  // Decoration only: a hint is aria-hidden and is removed wholesale by its
  // marker attribute, so nothing survives a release.
  test('hints are aria-hidden decoration, removed by their marker', () => {
    expect(js).toContain("hint.className = 'rv-keyhint'");
    expect(js).toContain("hint.setAttribute('aria-hidden', 'true')");
    expect(js).toContain("querySelectorAll('[data-rv-keyhint]')");
  });

  // Asking "what can I press" with '?' answers on the page too, not only in
  // the dialog — and the open legend pins the hints against a Shift release.
  test('the legend shows the hints as well, and pins them while it is open', () => {
    expect(js).toMatch(/if \(legend\.showModal\) legend\.showModal\(\);[\s\S]*showHints\(\);/);
    expect(js).toMatch(/function hideHints\(\) \{[\s\S]*if \(legend && legend\.open\) return;/);
  });

  test('the stylesheet ships the hint chip', () => {
    expect(bundledStylesheet()).toContain('.rv-keyhint');
  });
});

describe('approve ⇒ viewed', () => {
  // The decision island (review.ts) announces a successful decision POST as an
  // rv:decided event carrying which file and which answer. That dispatch is
  // client-only (Viewed lives in localStorage), so per the task spec we assert
  // the script wires .rv-viewed-box on approve rather than asserting server
  // state.
  test('the decision island dispatches rv:decided after a successful POST', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    expect(html).toContain("new CustomEvent('rv:decided'");
    expect(html).toMatch(/approved: body\.get\('approved'\) === '1'/);
  });

  test('the navigation island ticks the approved file, and only on approve', () => {
    const js = reviewNavigationScript();
    expect(js).toContain("addEventListener('rv:decided'");
    // Reject must NOT tick — the reviewer may want to look again.
    expect(js).toMatch(/if \(!d \|\| !d\.approved\) return;/);
    expect(js).toMatch(
      /rv-file\[data-viewed-key\]'[\s\S]*box\.checked = true;[\s\S]*dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/,
    );
  });

  // Markup basis for the rule: a protected file's decision control and its
  // Viewed checkbox live in the same section header, addressable together.
  test('a violation file section carries both the decision form and the viewed box', () => {
    const html = reviewTaskHtml(task(), PATCH, [], undefined, undefined, [
      { file: 'src/foo.ts', status: 'pending' } as never,
    ]);
    const section = html.slice(html.indexOf('rv-file-protected'));
    const header = section.slice(0, section.indexOf('</header>'));
    expect(header).toContain('data-rv-decide="src/foo.ts"');
    expect(header).toContain('class="rv-viewed-box"');
    expect(section).toContain(`data-file-section="${fileSectionId('src/foo.ts')}"`);
  });
});

describe('view-mode shortcuts reach the diff toolbar', () => {
  const js = reviewNavigationScript();

  // 's'/'w'/'f' click the diff toolbar's REAL buttons (review-diff.ts) rather
  // than reimplementing layout/wrap/presented state — same rule as a/r/v
  // above. Disabled (the narrow-viewport Split lock) means .click() is a
  // no-op, so a shortcut can never route around it.
  test('s/w/f toggle layout, wrap and presented by clicking the toolbar buttons', () => {
    expect(js).toMatch(/case 's': toggleMode\('layout', \['unified', 'split'\]\);/);
    expect(js).toMatch(/case 'w': toggleMode\('wrap', \['0', '1'\]\);/);
    expect(js).toMatch(/case 'f': toggleMode\('presented', \['presented', 'source'\]\);/);
    expect(js).toContain("querySelector('[data-rv-viewopts]')");
    expect(js).toMatch(/function toggleMode\(name, values\) \{[\s\S]*buttons\[\(activeIdx \+ 1\) % buttons\.length\]\.click\(\);/);
  });

  test('a page with no toolbar leaves the toggle a no-op', () => {
    expect(js).toMatch(/function toggleMode\(name, values\) \{\s*\n\s*var bar = viewOptsBar\(\);\s*\n\s*if \(!bar\) return;/);
  });

  test('the legend documents the three toggles', () => {
    expect(js).toContain('toggle diff layout (Unified / Split)');
    expect(js).toContain('toggle Wrap for long lines');
    expect(js).toContain('toggle Files (Presented / Source)');
  });

  // Hints land on the option NOT pressed (what the key would switch you to),
  // and skip a disabled button so a hint never advertises a shortcut that is
  // currently a no-op.
  test('toggle hints point at the unpressed, enabled option', () => {
    expect(js).toContain("var TOGGLE_HINTS = [['layout', 's'], ['wrap', 'w'], ['presented', 'f']];");
    expect(js).toMatch(
      /getAttribute\('aria-pressed'\) !== 'true' && !buttons\[i\]\.disabled\) return buttons\[i\];/,
    );
  });
});

describe('current-card styling', () => {
  test('the stylesheet marks [data-current] with an accent bar and outline', () => {
    const css = bundledStylesheet();
    expect(css).toContain('.rv-viewable[data-current]');
    expect(css).toMatch(/\.rv-viewable\[data-current\][^}]*box-shadow: inset 3px 0 0 0 var\(--color-accent\)/);
    expect(css).toMatch(/\.rv-viewable\[data-current\][^}]*outline: 1px solid var\(--color-accent\)/);
  });
});
