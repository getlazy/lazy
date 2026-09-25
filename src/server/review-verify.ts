/**
 * The "How to verify" review block.
 *
 * The agent's verification steps are a first-class part of the review, the way
 * raised items and follow-ups are — not one card section among the report
 * prose. The section body stays plain markdown (no new storage entity, no
 * rigid schema); this module pre-splits that markdown into an ordered list of
 * steps — prose paragraphs and fenced code blocks — and renders each code
 * block as a command panel with one-click Copy and Run buttons.
 *
 * Run sends exactly what Copy would put on the clipboard into the task's
 * CONTAINER shell (the web-shell panel, src/server/shell-ui.ts) — never the
 * host: the container is where the agent's work lives, and the host/container
 * distinction only exists when developing lazy with lazy. It appears only on
 * blocks whose language tag could be shell input, and is disabled — carrying
 * the Shell button's own reason — when no shell can be opened.
 *
 * The split happens on the SOURCE, before rendering, so the markdown renderer
 * (src/server/markdown.ts) stays the single markdown implementation: prose
 * segments go through renderMarkdown unchanged, and the fence-detection rule
 * here mirrors its classifier (any line whose trimmed start is ``` toggles a
 * fence; an unterminated fence runs to the end).
 *
 * When the report has no how_to_verify section the block still renders, with
 * an honest empty state — an absent block would hide the gap, and a visible
 * gap is what makes agents fill it. Groundwork for a future `lazy qa`.
 *
 * NO-JS FALLBACK: the Copy buttons ship `hidden` and the island unhides them
 * only when the clipboard API exists; without JS each command is still a
 * selectable <pre>, plus one line naming `lazy shell <code>`.
 *
 * The Verify tab (slice 5) treats the latest agent turn's how_to_verify as THE
 * current set. Earlier sessions with steps are collapsed history, each labelled
 * superseded — an older command was written against a branch that may no
 * longer exist in that shape. Per-step verified ticks live in the review draft
 * alongside viewed ticks (`verify:<turn-sequence>:<step-index>` + content hash).
 */

import { PROSE_REPORT_FILE, proseAnchorLine } from '../review/prose-anchor';

/**
 * The prose-anchor kind a current verify step hashes under. It is the report
 * section the steps came from, so a step's anchor is the one the same text
 * would have in the report's own how_to_verify section.
 */
const VERIFY_PROSE_KIND = 'how_to_verify';
import { renderMarkdown } from './markdown';
import { escapeHtml } from './review-diff';
import { shortHash, viewedCardHtml } from './viewed-cards';
import type { ShellAvailability } from './shell-ui';
import type { TurnReport } from '../types';

export type VerifyStep =
  | { kind: 'prose'; markdown: string }
  | { kind: 'code'; lang: string; code: string };

/**
 * Split a how_to_verify markdown body into ordered prose/code steps.
 *
 * Everything between fences (paragraphs, lists, headings — however nested) is
 * one prose step; each fenced block is one code step. An unterminated fence
 * takes the rest of the document as code rather than dropping it.
 */
export function splitVerifySteps(markdown: string): VerifyStep[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const steps: VerifyStep[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join('\n').trim();
    if (text) steps.push({ kind: 'prose', markdown: text });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      flushProse();
      const lang = line.trimStart().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence (or past the end when unterminated)
      steps.push({ kind: 'code', lang, code: code.join('\n') });
      continue;
    }
    prose.push(line);
    i++;
  }
  flushProse();
  return steps;
}

/** Non-empty lines of a code block. */
function contentLines(code: string): string[] {
  return code.split('\n').filter((l) => l.trim() !== '');
}

/**
 * True when every non-empty line is `$ `-prefixed — the console convention
 * where the prefix marks a prompt, not part of the command.
 */
export function isPromptPrefixed(code: string): boolean {
  const lines = contentLines(code);
  return lines.length > 0 && lines.every((l) => /^\s*\$\s/.test(l));
}

/**
 * What the whole-block Copy button puts on the clipboard: the code verbatim,
 * except that a `$ `-prefixed console block has its prompt markers stripped —
 * pasting `$ foo` into a shell breaks, and the marker is presentation.
 */
export function copyTextFor(code: string): string {
  if (!isPromptPrefixed(code)) return code;
  return code
    .split('\n')
    .map((l) => l.replace(/^\s*\$\s/, ''))
    .join('\n');
}

/**
 * Per-line copy targets: only offered for `$ `-prefixed blocks of two or more
 * commands, where each line is unambiguously one command. Guessing "one
 * command per line" on unprefixed blocks would split multi-line commands.
 */
export function perLineCommands(code: string): string[] {
  if (!isPromptPrefixed(code)) return [];
  const lines = contentLines(code).map((l) => l.replace(/^\s*\$\s/, ''));
  return lines.length >= 2 ? lines : [];
}

/**
 * Language tags that are clearly not shell input — data, source and output
 * blocks. A denylist, not an allowlist: agents tag their commands a dozen ways
 * (`bash`, `sh`, `console`, `shell-session`, or nothing at all), and refusing
 * to run an unrecognised tag would silently drop the common untagged case.
 */
const NON_SHELL_LANGS = new Set([
  'json', 'jsonc', 'json5', 'toml', 'yaml', 'yml', 'ini', 'xml', 'html', 'css', 'scss',
  'ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'py', 'python', 'rb', 'ruby',
  'go', 'rs', 'rust', 'java', 'kt', 'c', 'cpp', 'cs', 'php', 'swift', 'sql', 'graphql',
  'md', 'mdx', 'markdown', 'diff', 'patch', 'text', 'txt', 'log', 'output', 'csv', 'tsv',
  'dockerfile', 'makefile', 'powershell', 'ps1',
]);

/**
 * Whether a fenced block's language tag says it can be typed at a shell.
 * Untagged blocks are runnable — an untagged fence in "How to verify" is
 * overwhelmingly a command.
 */
export function isRunnableLang(lang: string): boolean {
  const tag = lang.trim().toLowerCase().split(/[^a-z0-9+#-]/)[0] ?? '';
  if (!tag) return true;
  return !NON_SHELL_LANGS.has(tag);
}

/** Attribute-safe escaping for the data-copy payload. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, '&#10;');
}

/** The concatenated how_to_verify bodies of one report, or empty. */
export function howToVerifySource(report: TurnReport | null): string {
  return (report?.sections ?? [])
    .filter((s) => s.kind === 'how_to_verify')
    .map((s) => s.body)
    .join('\n\n')
    .trim();
}

/** Review-draft key for a per-step verified tick. */
export function verifyTickKey(turnSequence: number, stepIndex: number): string {
  return `verify:${turnSequence}:${stepIndex}`;
}

/** The text a verified tick is taken over — prose markdown or the fence body. */
export function stepSource(step: VerifyStep): string {
  return step.kind === 'prose' ? step.markdown : step.code;
}

/**
 * How many of the CURRENT turn's steps are ticked in the draft with a matching
 * content hash. Superseded history is not counted — those steps are not the
 * live set.
 */
export function countVerifiedSteps(
  viewedFiles: Record<string, string>,
  turnSequence: number,
  steps: VerifyStep[],
): { verified: number; total: number } {
  const total = steps.length;
  let verified = 0;
  for (let i = 0; i < steps.length; i++) {
    const key = verifyTickKey(turnSequence, i);
    if (viewedFiles[key] === shortHash(stepSource(steps[i]))) verified++;
  }
  return { verified, total };
}

export interface VerifyHistoryEntry {
  turnSequence: number;
  createdAt: number;
  report: TurnReport;
}

/**
 * Latest agent turn's report is current (even when it has no steps — that is
 * the honest empty state). Every OTHER report that still has how_to_verify
 * is superseded history. Reports are latest-wins per session, so this is
 * one row per earlier session, not per turn inside a session.
 */
export function partitionVerifyReports(
  reports: TurnReport[],
  lastAgentTurn: { session_id: string; sequence: number } | null,
): { current: TurnReport | null; currentSequence: number; earlier: VerifyHistoryEntry[] } {
  const withBody = reports.filter((r) => howToVerifySource(r).length > 0);
  const currentSession = lastAgentTurn?.session_id;
  let current: TurnReport | null = null;
  if (currentSession) {
    // The latest agent turn owns "current", even when it has not reported
    // yet — falling back to another session's report would present superseded
    // steps as if they were for this branch.
    current = reports.find((r) => r.session_id === currentSession) ?? null;
  } else if (reports.length > 0) {
    // getTaskTurnReports is oldest-first; the last row is the newest session.
    current = reports[reports.length - 1] ?? null;
  }
  const currentSequence = current?.turn_sequence ?? lastAgentTurn?.sequence ?? 0;
  const earlier: VerifyHistoryEntry[] = [];
  for (const r of withBody) {
    if (current && r.session_id === current.session_id) continue;
    earlier.push({
      turnSequence: r.turn_sequence ?? 0,
      createdAt: r.updated_at ?? r.created_at,
      report: r,
    });
  }
  earlier.sort((a, b) => b.turnSequence - a.turnSequence || b.createdAt - a.createdAt);
  return { current, currentSequence, earlier };
}

function isoDay(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The Run control: opens a NEW shell tab in the task's container — always the
 * container, never the host — and runs this block there.
 *
 * A new tab per block, rather than typing into whichever shell happens to be
 * open, is the point: each block's output stays whole, and a shell the reviewer
 * is already using is never written into behind their back. The label goes on
 * the tab so several blocks in flight stay tellable apart.
 *
 * The button says so, and the block it will run is rendered directly beneath it
 * — the reviewer reads the commands before deciding to click, and the terminal
 * echoes them again on the way in. When no shell can be opened the button
 * carries the same reason the Shell button shows, so a reviewer learns why
 * rather than clicking a control that quietly does nothing.
 */
function runButtonHtml(
  shell: ShellAvailability,
  text: string,
  label: string,
  origin?: string,
): string {
  if (!shell.available) {
    return `<button type="button" class="rv-cmd-run" disabled title="${escapeHtml(shell.reason)}" hidden>Run in shell</button>`;
  }
  const title = `Run these commands in a new shell (${label}) in the task's container`;
  const originAttr = origin ? ` data-lz-shell-origin="${escapeAttr(origin)}"` : '';
  return (
    `<button type="button" class="rv-cmd-run" data-run="${escapeAttr(text)}"` +
    ` data-run-label="${escapeAttr(label)}"${originAttr} title="${escapeHtml(title)}" hidden>Run in shell</button>` +
    `<button type="button" class="rv-cmd-open" hidden>Open</button>` +
    `<button type="button" class="rv-cmd-rerun" hidden>Re-run</button>`
  );
}

function codePanelHtml(
  step: { lang: string; code: string },
  shell: ShellAvailability | null,
  runLabel: string,
  opts: { mount?: boolean; origin?: string; ask?: boolean } = {},
): string {
  const label = step.lang || 'shell';
  const perLine = perLineCommands(step.code);
  const codeHtml = perLine.length
    ? step.code
        .split('\n')
        .map((line) => {
          if (line.trim() === '') return escapeHtml(line);
          const cmd = line.replace(/^\s*\$\s/, '');
          return (
            `<span class="rv-cmd-line">${escapeHtml(line)}` +
            `<button type="button" class="rv-cmd-copy-line" data-copy="${escapeAttr(cmd)}" title="Copy this command" hidden>⧉</button></span>`
          );
        })
        .join('\n')
    : escapeHtml(step.code);
  const copyText = copyTextFor(step.code);
  const runnable = Boolean(shell && isRunnableLang(step.lang));
  const runHtml = runnable && shell ? runButtonHtml(shell, copyText, runLabel, opts.origin) : '';
  // A CURRENT step's command block is askable like a report paragraph: the
  // panel is itself the anchored block (so its threads render under it), and
  // its Comment button opens the Ask / Add comment / Unblock row with the
  // commands as the quote the comment or unblock carries.
  const askLine = opts.ask ? proseAnchorLine(VERIFY_PROSE_KIND, step.code) : 0;
  const anchorAttrs = opts.ask
    ? ` data-rv-present-host data-file="${escapeAttr(PROSE_REPORT_FILE)}" data-side="new" data-line="${askLine}"`
    : '';
  const askHtml = opts.ask
    ? `<button type="button" class="rv-cmd-ask" hidden data-rv-present-ask="Ask, comment or unblock on this step"` +
      ` data-file="${escapeAttr(PROSE_REPORT_FILE)}" data-side="new" data-line="${askLine}"` +
      ` data-rv-present-quote="${escapeAttr(step.code)}"` +
      ` title="Ask the agent about this step, comment on it, or unblock with it">Comment</button>`
    : '';
  const panel = `<div class="rv-cmd-panel${opts.ask ? ' rv-prose-block' : ''}"${anchorAttrs}>
      <div class="rv-cmd-head">
        <span class="rv-cmd-lang">${escapeHtml(label)}</span>
        <span class="rv-cmd-actions">${runHtml}${askHtml}<button type="button" class="rv-cmd-copy" data-copy="${escapeAttr(copyText)}" hidden>Copy</button></span>
      </div>
      <pre class="rv-cmd-pre"><code>${codeHtml}</code></pre>
    </div>`;
  if (!opts.mount || !runnable) return panel;
  // Empty slot directly beneath the command. lzShellRun appends the terminal
  // here so the reviewer is not yanked to a panel at the top of the page.
  return (
    `<div class="lz-verify-run" data-lz-shell-step>` +
    panel +
    `<div class="lz-shell-mount" data-lz-shell-mount hidden></div>` +
    `</div>`
  );
}

/**
 * The report minus its how_to_verify sections, for the Agent report card —
 * the dedicated block below is where they render now, and rendering them twice
 * would be noise. The remaining sections keep their agent-chosen order.
 */
export function stripVerifySections(report: TurnReport | null): TurnReport | null {
  if (!report) return null;
  const sections = report.sections.filter((s) => s.kind !== 'how_to_verify');
  if (sections.length === report.sections.length) return report;
  return { ...report, sections };
}

/**
 * The block itself — a viewable card like the agent report, keyed and hashed
 * so the tick clears when the agent reports different steps.
 *
 * When the shell is unavailable the reason renders ONCE at the top of the card
 * rather than beside every Run button — the reason is the card's, not each
 * block's. No Start container button rides along with it: a container that is
 * merely stopped is started by the Run itself, and the reasons that can still
 * reach here (no session yet, a runner with no container) are not ones a Start
 * button fixes.
 */
export function verifyReportBlockHtml(
  report: TurnReport | null,
  shell: ShellAvailability | null = null,
): string {
  const source = (report?.sections ?? [])
    .filter((s) => s.kind === 'how_to_verify')
    .map((s) => s.body)
    .join('\n\n')
    .trim();

  if (!source) {
    return viewedCardHtml({
      key: 'how-to-verify',
      content: 'no-verification-steps',
      headHtml: '<strong>How to verify</strong>',
      bodyHtml: '<p class="rv-hint rv-verify-empty">The agent gave no verification steps.</p>',
      sectionClass: 'rv-verify',
    });
  }

  const steps = splitVerifySteps(source);
  const commandCount = steps.filter((s) => s.kind === 'code').length;
  // Blocks are numbered in the order the agent wrote them, and that number is
  // the shell tab's name — "Verify 2" in the tab strip is the second block on
  // the page, with no cross-referencing needed.
  let runNo = 0;
  const bodyHtml = steps
    .map((s) => {
      if (s.kind !== 'code') return `<div class="rv-verify-prose turn-content">${renderMarkdown(s.markdown)}</div>`;
      runNo++;
      return codePanelHtml(s, shell, `Verify ${runNo}`);
    })
    .join('\n');
  // The reason, once, above the steps: the blocks below still carry disabled Run
  // buttons with the same reason in their tooltips, but a reviewer should read it
  // before they go hunting for a control that will not help.
  const downHtml =
    shell && !shell.available && commandCount > 0
      ? `<div class="rv-verify-shell-down"><span class="rv-hint">${escapeHtml(shell.reason)}</span></div>`
      : '';
  const countHint = commandCount
    ? ` <span class="rv-hint">${commandCount} command block${commandCount === 1 ? '' : 's'}</span>`
    : '';
  return viewedCardHtml({
    key: 'how-to-verify',
    content: source,
    headHtml: `<strong>How to verify</strong>${countHint}`,
    bodyHtml: downHtml + bodyHtml,
    sectionClass: 'rv-verify',
  });
}

export interface VerifyTabInput {
  current: TurnReport | null;
  currentSequence: number;
  earlier: VerifyHistoryEntry[];
  shell: ShellAvailability | null;
  /** Task code for the JS-off `lazy shell <code>` line. */
  taskCode: string;
  markdown?: import('./markdown').RenderMarkdownOptions;
}

function verifyStepHtml(
  step: VerifyStep,
  index: number,
  turnSequence: number,
  shell: ShellAvailability | null,
  opts: { current: boolean; markdown?: import('./markdown').RenderMarkdownOptions; runNo?: number },
): string {
  const key = verifyTickKey(turnSequence, index);
  const hash = shortHash(stepSource(step));
  const tick =
    `<label class="lz-verified" hidden>` +
    `<input type="checkbox" class="lz-verified-box"> Verified` +
    `</label>`;
  const body =
    step.kind === 'prose'
      ? // The CURRENT steps are prose anchors on the agent's report — they ARE
        // its how_to_verify section — so each paragraph gets the review "+"
        // and its [Ask agent] [Add comment] [Unblock] [Cancel] row, with the
        // step's own text as the quote the comment or unblock carries.
        // Superseded steps are not: they describe a branch that is gone.
        `<div class="rv-verify-prose turn-content"${opts.current ? ` data-rv-prose="${escapeAttr(PROSE_REPORT_FILE)}" data-rv-prose-kind="${VERIFY_PROSE_KIND}"` : ''}>${renderMarkdown(step.markdown, opts.markdown)}</div>`
      : codePanelHtml(step, opts.current ? shell : null, `Verify ${opts.runNo ?? index + 1}`, {
          mount: opts.current,
          ask: opts.current,
          origin: `Verification, step ${opts.runNo ?? index + 1}`,
        });
  const currentAttr = opts.current ? ' data-verify-current' : '';
  return (
    `<div class="lz-verify-step rv-viewable" data-verify-step${currentAttr}` +
    ` data-viewed-key="${escapeAttr(key)}" data-content-hash="${hash}">` +
    `<div class="lz-verify-step-head">${tick}` +
    `<span class="lz-verify-step-n">${index + 1}.</span></div>` +
    body +
    `</div>`
  );
}

function renderVerifySteps(
  report: TurnReport | null,
  turnSequence: number,
  shell: ShellAvailability | null,
  opts: { current: boolean; markdown?: import('./markdown').RenderMarkdownOptions },
): { html: string; commandCount: number; stepCount: number } {
  const source = howToVerifySource(report);
  if (!source) {
    return { html: '', commandCount: 0, stepCount: 0 };
  }
  const steps = splitVerifySteps(source);
  const commandCount = steps.filter((s) => s.kind === 'code').length;
  // Command panels are numbered in report order so "Verify 2" on a Run
  // button is the second runnable block, not the second step of any kind.
  let runNo = 0;
  const html = steps
    .map((s, i) => {
      const extra = s.kind === 'code' ? { runNo: ++runNo } : {};
      return verifyStepHtml(s, i, turnSequence, shell, { ...opts, ...extra });
    })
    .join('\n');
  return { html, commandCount, stepCount: steps.length };
}

/**
 * The Verify tab: the latest agent turn's steps are current; earlier sessions
 * with how_to_verify are collapsed, labelled superseded. Per-step verified
 * ticks share the review-draft viewed_files map.
 */
export function verifyTabHtml(input: VerifyTabInput): string {
  const { current, currentSequence, earlier, shell, taskCode } = input;
  const rendered = renderVerifySteps(current, currentSequence, shell, {
    current: true,
    markdown: input.markdown,
  });
  const commandCount = rendered.commandCount;
  const downHtml =
    shell && !shell.available && commandCount > 0
      ? `<div class="rv-verify-shell-down"><span class="rv-hint">${escapeHtml(shell.reason)}</span></div>`
      : '';
  const empty = rendered.stepCount === 0
    ? viewedCardHtml({
        key: 'how-to-verify',
        content: 'no-verification-steps',
        headHtml: '<strong>How to verify</strong>',
        bodyHtml: '<p class="rv-hint rv-verify-empty">The agent gave no verification steps.</p>',
        sectionClass: 'rv-verify',
      })
    : '';
  const turnLabel = currentSequence > 0 ? `turn #${currentSequence}` : 'latest turn';
  const countLine = rendered.stepCount
    ? `<span class="lz-verify-progress" data-lz-verify-count></span>`
    : '';
  const jsOff =
    `<noscript><p class="rv-hint lz-verify-js-off">With scripting off there is no terminal here. ` +
    `Commands are selectable text; run them with <code>lazy shell ${escapeHtml(taskCode)}</code>.</p></noscript>`;

  const history = earlier.length === 0
    ? ''
    : `<details class="lz-verify-history">` +
      `<summary>Earlier verification steps (${earlier.length})</summary>` +
      earlier.map((entry) => {
        const seqLabel = entry.turnSequence > 0 ? `Turn #${entry.turnSequence}` : 'Earlier session';
        const inner = renderVerifySteps(entry.report, entry.turnSequence || 0, null, {
          current: false,
          markdown: input.markdown,
        }).html;
        return (
          `<section class="lz-verify-superseded">` +
          `<h3>${escapeHtml(seqLabel)} · superseded · ${escapeHtml(isoDay(entry.createdAt))}</h3>` +
          `<p class="rv-hint">These steps were written against that turn's branch. They can be wrong for the branch as it is now.</p>` +
          inner +
          `</section>`
        );
      }).join('\n') +
      `</details>`;

  const currentCard = rendered.stepCount === 0
    ? empty
    : `<section class="lz-verify-current rv-verify">` +
      `<header class="lz-verify-current-head">` +
      `<strong>How to verify</strong>` +
      ` <span class="rv-hint">${escapeHtml(turnLabel)}</span>` +
      countLine +
      `</header>` +
      downHtml +
      rendered.html +
      `</section>`;

  // Copy/Run islands live on the page (taskPageHtml), not in this fragment,
  // on purpose: they delegate their click handling on \`document\` and bind
  // exactly once, at page load, so no re-init is needed on any later in-place
  // switch onto Verify — a tab-local island re-run by task-tabs.ts's
  // activateScripts would add a duplicate \`document\` listener on every
  // switch instead. verifyCopyScript / verifyRunScript register that
  // listener unconditionally (no early return when this fragment's buttons
  // are not on the page yet), and viewed-cards.ts's unhideVerifyControls()
  // unhides whatever buttons a later switch brings in.
  return (
    `<div class="lz-verify-tab">` +
    currentCard +
    jsOff +
    history +
    `</div>`
  );
}

/**
 * The copy island. Buttons stay hidden unless the async clipboard API exists,
 * so a browser that cannot copy shows no dead control. A successful copy
 * flashes a confirmation on the button itself.
 */
export function verifyCopyScript(): string {
  return `<script>
(function () {
  if (!(navigator.clipboard && navigator.clipboard.writeText)) return;
  // No length guard: this is page-level and runs exactly once, at whichever
  // tab happened to be current on load. A page loaded on a tab with no Copy
  // button yet (landing is the normal entry point) must still bind the
  // delegated listener below, or Copy stays dead for the rest of the session
  // once the reviewer switches to a tab that has one — viewed-cards.ts's
  // unhideVerifyControls() already re-unhides buttons on every in-place
  // switch, so the buttons themselves were never the missing half.
  var buttons = document.querySelectorAll('.rv-cmd-copy, .rv-cmd-copy-line');
  for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false;
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.rv-cmd-copy, .rv-cmd-copy-line') : null;
    if (!btn) return;
    ev.preventDefault();
    navigator.clipboard.writeText(btn.dataset.copy || '').then(function () {
      btn.classList.add('rv-cmd-copied');
      if (btn.classList.contains('rv-cmd-copy')) {
        var label = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = label; btn.classList.remove('rv-cmd-copied'); }, 1500);
      } else {
        setTimeout(function () { btn.classList.remove('rv-cmd-copied'); }, 1500);
      }
    }).catch(function () { /* clipboard refused (permissions): the <pre> is still selectable */ });
  });
})();
</script>`;
}

/**
 * The Run island. Like Copy, the buttons ship hidden and are unhidden only here
 * — without JS there is no shell panel to run into, so a visible Run would be a
 * dead control. Disabled buttons are unhidden too: their tooltip is the reason.
 *
 * A click hands the block to `window.lzShellRun`. When the button sits in a
 * `[data-lz-shell-step]` wrap, the session mounts in the empty slot beneath
 * the step (no scroll) — the Services card's "Start services" and the
 * down-service notice's own button use the same wrap (services-card.ts,
 * serve-notice.ts). Otherwise it opens in the persist panel. Nothing runs
 * without that click.
 */
export function verifyRunScript(): string {
  return `<script>
(function () {
  // No length guard: see the matching comment in verifyCopyScript. A page
  // loaded on a tab with no Run button yet must still bind the delegated
  // listener, or Run stays dead for the whole session the first time the
  // reviewer switches into Verify instead of landing there directly — which
  // is exactly the "often does not work" the buttons being visible (unhidden
  // by unhideVerifyControls on every switch) but unresponsive reported.
  var buttons = document.querySelectorAll('.rv-cmd-run');
  for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false;
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.rv-cmd-run') : null;
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    var text = btn.dataset.run || '';
    if (!text || typeof window.lzShellRun !== 'function') return;
    var step = btn.closest('[data-lz-shell-step]');
    var mount = step ? step.querySelector('[data-lz-shell-mount]') : null;
    var opts = {};
    if (mount) {
      opts.mount = mount;
      opts.origin = btn.getAttribute('data-lz-shell-origin') || btn.dataset.runLabel || 'Verify';
    }
    if (!window.lzShellRun(text.replace(/\\n+$/, '') + '\\n', null, btn.dataset.runLabel || 'Verify', opts)) return;
    if (step) {
      // Mounted: Open / Re-run take over. Do not flash "Opened shell" over Run
      // — setStepLive already hid it.
      return;
    }
    var label = btn.textContent;
    btn.classList.add('rv-cmd-ran');
    btn.textContent = 'Opened shell';
    setTimeout(function () { btn.textContent = label; btn.classList.remove('rv-cmd-ran'); }, 1500);
  });
})();
</script>`;
}
