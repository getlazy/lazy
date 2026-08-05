/**
 * `lazy report` — produce an LLM-summarized markdown digest of recent activity.
 *
 * Map-reduce shape:
 *   - Map: one LLM call per lazy task with in-window activity, one per
 *     non-lazy main-branch commit. Runs in parallel.
 *   - Reduce: one final LLM call assembles map outputs + orphan
 *     builder/engineer conversations into a three-section digest.
 *
 * Covers ALL main-branch activity in the window — both lazy-managed work
 * and direct (non-lazy) commits by collaborators not using lazy.
 */

import { writeFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { requireLazyRoot, requireStorage, displayId, parseFlags, getBranchName } from '../helpers';
import type { Storage, Task, Turn, Commit, Comment, StoredConversation, StatusChange } from '../../storage';
import { runClaudeOneshot } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { logger } from '../../utils/logger';
import { runGit } from '../../utils/git';
import { getCommitDiff, getRemoteDefaultBranch } from '../../git/operations';
import { spawn } from '../../utils/spawn';
import { renderMarkdown } from '../../server/markdown';
import reportTaskPrompt from '../../prompts/report-task.md' with { type: 'text' };
import reportCommitPrompt from '../../prompts/report-commit.md' with { type: 'text' };
import reportReducePrompt from '../../prompts/report-reduce.md' with { type: 'text' };
import { turnText } from '../../utils/turn-content';

interface Window {
  startMs: number;
  endMs: number;
}

function parseTimeSpec(spec: string, now: number): number {
  const m = spec.match(/^-(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
    return now - n * unitMs[m[2]];
  }
  const parsed = Date.parse(spec);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid time spec: "${spec}". Use a relative offset like "-3d" / "-12h" or an ISO timestamp.`);
  }
  return parsed;
}

function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

function inWindow(ts: number | null | undefined, win: Window): boolean {
  if (ts === null || ts === undefined) return false;
  return ts >= win.startMs && ts <= win.endMs;
}

function conversationStartedAtMs(conv: StoredConversation): number {
  const t = conv.startedAt ? Date.parse(conv.startedAt) : conv.importedAt;
  return Number.isNaN(t) ? conv.importedAt : t;
}

// ---------------------------------------------------------------------------
// Lazy task activity collection
// ---------------------------------------------------------------------------

interface MainBranchCommit {
  sha: string;
  subject: string;
  author: string;
  authorDate: string;
}

interface TaskActivity {
  task: Task;
  createdInWindow: boolean;
  completedInWindow: boolean;
  statusChanges: StatusChange[];
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  conversations: StoredConversation[];
  /** Accept/merge commits on the main branch in-window that resolve to this task. */
  mainBranchCommits: MainBranchCommit[];
}

interface LazyActivity {
  tasks: TaskActivity[];
  orphanConversations: StoredConversation[];
  /** Map from session-commit SHA → task id, for cross-referencing main-branch SHAs. */
  sessionCommitShas: Set<string>;
  /** Map from task id → TaskActivity, for attaching cross-referenced main commits. */
  tasksById: Map<string, TaskActivity>;
}

async function collectLazyActivity(storage: Storage, win: Window): Promise<LazyActivity> {
  const allTasks = await storage.listTasks();

  const allConversations = await storage.listConversations();
  const conversationsInWindow = allConversations.filter(c => {
    const t = conversationStartedAtMs(c);
    return t >= win.startMs && t <= win.endMs;
  });
  const conversationsByBranch = new Map<string, StoredConversation[]>();
  for (const conv of conversationsInWindow) {
    if (!conv.gitBranch) continue;
    const existing = conversationsByBranch.get(conv.gitBranch);
    if (existing) existing.push(conv);
    else conversationsByBranch.set(conv.gitBranch, [conv]);
  }
  const claimedConvSessionIds = new Set<string>();

  // Serialize storage calls. Fanning out with Promise.all over N tasks
  // overwhelms the daemon's unix-socket accept queue on busy projects,
  // surfacing as `RemoteStorage.<method> failed: Was there a typo in the
  // url or port?` (Bun fetch's ECONNREFUSED text). The CLI runs once and
  // the daemon is local — sequential calls are cheap enough.
  const sessionCommitShas = new Set<string>();
  const activities: TaskActivity[] = [];
  const tasksById = new Map<string, TaskActivity>();

  for (const task of allTasks) {
    const session = await storage.getSessionByTaskId(task.id);
    const allTurns = session ? await storage.getSessionTurns(session.id) : [];
    const allCommits = session ? await storage.getSessionCommits(session.id) : [];
    const allComments = await storage.getTaskComments(task.id);
    const allStatus = await storage.getStatusHistory(task.id);

    // Always grow the session-commit SHA set (used by main-branch classifier).
    for (const c of allCommits) sessionCommitShas.add(c.sha);

    const turns = allTurns.filter(t => inWindow(t.timestamp, win));
    const commits = allCommits.filter(c => inWindow(c.timestamp, win));
    const comments = allComments.filter(c => inWindow(c.created_at, win));
    const statusChanges = allStatus.filter(s => inWindow(s.timestamp, win));

    const branchName = getBranchName(task);
    const taskConversations = conversationsByBranch.get(branchName) ?? [];
    for (const conv of taskConversations) {
      claimedConvSessionIds.add(conv.sessionId);
    }

    const createdInWindow = inWindow(task.created_at, win);
    const completedInWindow = inWindow(task.completed_at ?? undefined, win);

    const touched = createdInWindow || completedInWindow
      || statusChanges.length > 0
      || turns.length > 0
      || commits.length > 0
      || comments.length > 0
      || taskConversations.length > 0;
    if (!touched) continue;

    const activity: TaskActivity = {
      task,
      createdInWindow,
      completedInWindow,
      statusChanges,
      turns,
      commits,
      comments,
      conversations: taskConversations,
      mainBranchCommits: [],
    };
    activities.push(activity);
    tasksById.set(task.id, activity);
  }

  const orphanConversations = conversationsInWindow.filter(c => !claimedConvSessionIds.has(c.sessionId));
  return { tasks: activities, orphanConversations, sessionCommitShas, tasksById };
}

// ---------------------------------------------------------------------------
// Main-branch commit enumeration + classification
// ---------------------------------------------------------------------------

interface ClassifiedMainCommit {
  commit: MainBranchCommit;
  kind: 'lazy' | 'non-lazy';
  /** When kind=lazy: the task id this commit resolved to, if any. */
  resolvedTaskId?: string;
}

async function enumerateMainCommits(root: string, mainBranch: string, win: Window): Promise<MainBranchCommit[]> {
  // Use NUL between fields and \x1e (record separator) between commits so
  // commit subjects with embedded newlines parse correctly.
  const result = await runGit(
    [
      'log', mainBranch,
      `--since=${formatIso(win.startMs)}`,
      `--until=${formatIso(win.endMs)}`,
      '--format=%H%x00%s%x00%an%x00%aI%x1e',
    ],
    { cwd: root },
  );
  if (result.exitCode !== 0) {
    logger.warn(`lazy report: git log on ${mainBranch} failed (${result.stderr.trim()}); skipping main-branch enumeration.`);
    return [];
  }
  if (!result.stdout.trim()) return [];

  const entries = result.stdout.split('\x1e').map(e => e.trim()).filter(Boolean);
  const commits: MainBranchCommit[] = [];
  for (const entry of entries) {
    const [sha, subject, author, authorDate] = entry.split('\x00');
    if (!sha) continue;
    commits.push({
      sha,
      subject: subject ?? '',
      author: author ?? '',
      authorDate: authorDate ?? '',
    });
  }
  return commits;
}

async function classifyMainCommit(
  commit: MainBranchCommit,
  sessionCommitShas: Set<string>,
  storage: Storage,
): Promise<ClassifiedMainCommit> {
  // Direct SHA match against session-tracked commits (non-squash merges).
  if (sessionCommitShas.has(commit.sha)) {
    return { commit, kind: 'lazy' };
  }

  // Accept-commit pattern: "Accept task <ref>: <goal>".
  // <ref> is a task code or short id; resolve it via storage.
  const acceptMatch = commit.subject.match(/^Accept task (\S+?):/);
  if (acceptMatch) {
    const ref = acceptMatch[1];
    try {
      const { task } = await storage.resolveTask(ref);
      if (task) {
        return { commit, kind: 'lazy', resolvedTaskId: task.id };
      }
    } catch {
      // Resolution failed — still treat as lazy-managed (the message is the
      // strong signal), just without a task linkage.
    }
    return { commit, kind: 'lazy' };
  }

  return { commit, kind: 'non-lazy' };
}

// ---------------------------------------------------------------------------
// Bundle formatting for map inputs
// ---------------------------------------------------------------------------

function formatTaskActivityBundle(a: TaskActivity): string {
  const t = a.task;
  const lines: string[] = [];
  lines.push(`### Task ${displayId(t)} — ${t.goal}`);
  lines.push('');
  lines.push(`- id: ${t.id.slice(0, 8)}  type: ${t.type}  status: ${t.status}  model: ${t.model ?? '-'}`);
  if (a.createdInWindow) {
    lines.push(`- created at ${formatIso(t.created_at)}`);
  }
  if (a.completedInWindow && t.completed_at) {
    const reason = t.close_reason ? `, reason="${t.close_reason}"` : '';
    lines.push(`- completed at ${formatIso(t.completed_at)} (status=${t.status}${reason})`);
  }
  if (a.statusChanges.length > 0) {
    lines.push(`- status transitions:`);
    for (const sc of a.statusChanges) {
      lines.push(`  - ${formatIso(sc.timestamp)} → ${sc.status}${sc.actor ? ` (by ${sc.actor})` : ''}`);
    }
  }
  if (a.turns.length > 0) {
    lines.push(`- turns (${a.turns.length}):`);
    for (const turn of a.turns) {
      const who = turn.role === 'human' ? (turn.actor ?? 'human') : 'agent';
      lines.push(`  - ${formatIso(turn.timestamp)} [${who}]${turn.turn_type === 'ask' ? ' (ask)' : turn.turn_type === 'nudge' ? ' (nudge)' : turn.turn_type === 'sync' ? ' (sync)' : ''}`);
      lines.push(`    ${turnText(turn)}`);
    }
  }
  if (a.commits.length > 0) {
    lines.push(`- task-branch commits (${a.commits.length}):`);
    for (const c of a.commits) {
      lines.push(`  - ${formatIso(c.timestamp)} ${c.sha.slice(0, 7)} ${c.message}`);
    }
  }
  if (a.mainBranchCommits.length > 0) {
    lines.push(`- accept/merge commits on main (${a.mainBranchCommits.length}):`);
    for (const mc of a.mainBranchCommits) {
      lines.push(`  - ${mc.authorDate} ${mc.sha.slice(0, 7)} ${mc.subject} (author: ${mc.author})`);
    }
  }
  if (a.comments.length > 0) {
    lines.push(`- comments (${a.comments.length}):`);
    for (const c of a.comments) {
      lines.push(`  - ${formatIso(c.created_at)}${c.actor ? ` [${c.actor}]` : ''}: ${c.content}`);
    }
  }
  if (a.conversations.length > 0) {
    lines.push(`- builder/engineer conversations (${a.conversations.length}):`);
    for (const conv of a.conversations) {
      lines.push(`  - ${conv.startedAt ?? '?'} session=${conv.sessionId.slice(0, 8)} msgs=${conv.stats.messageCount} (user=${conv.stats.userMessageCount}/assistant=${conv.stats.assistantMessageCount}) summary="${conv.summary}"`);
    }
  }
  return lines.join('\n');
}

async function formatCommitBundle(root: string, commit: MainBranchCommit): Promise<string> {
  const lines: string[] = [];
  lines.push(`### Commit ${commit.sha.slice(0, 7)} on main`);
  lines.push('');
  lines.push(`- sha: ${commit.sha}`);
  lines.push(`- author: ${commit.author}`);
  lines.push(`- date: ${commit.authorDate}`);
  lines.push(`- subject: ${commit.subject}`);
  lines.push('');
  // Full commit body + diff.
  const showResult = await runGit(
    ['show', '--no-color', '--format=%B', commit.sha],
    { cwd: root },
  );
  if (showResult.exitCode === 0 && showResult.stdout) {
    lines.push('Full commit body and diff:');
    lines.push('');
    lines.push('```diff');
    lines.push(showResult.stdout);
    lines.push('```');
  } else {
    // Best-effort fallback: just the patch via getCommitDiff.
    const diff = await getCommitDiff(commit.sha, root);
    if (diff) {
      lines.push('Diff:');
      lines.push('');
      lines.push('```diff');
      lines.push(diff);
      lines.push('```');
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Map / Reduce orchestration
// ---------------------------------------------------------------------------

interface MapResult {
  /** Stable identifier for this unit (task code/shortId, or commit short SHA). */
  unitId: string;
  /** Display label, e.g. "lazy task `foo-bar`" or "non-lazy commit `abc1234` (Alice)". */
  label: string;
  /** Markdown summary from the LLM. */
  summary: string;
}

interface FailedUnit {
  unitId: string;
  label: string;
  error: string;
}

async function mapTaskUnit(
  activity: TaskActivity,
  win: Window,
  model: string | undefined,
): Promise<MapResult> {
  const bundle = formatTaskActivityBundle(activity);
  const prompt = reportTaskPrompt
    .replace('{{window}}', `${formatIso(win.startMs)} → ${formatIso(win.endMs)}`)
    .replace('{{bundle}}', bundle);
  const response = await runClaudeOneshot(prompt, model);
  const code = displayId(activity.task);
  return {
    unitId: `task:${code}`,
    label: `lazy task \`${code}\``,
    summary: response.result.trim(),
  };
}

async function mapCommitUnit(
  root: string,
  commit: MainBranchCommit,
  win: Window,
  model: string | undefined,
): Promise<MapResult> {
  const bundle = await formatCommitBundle(root, commit);
  const prompt = reportCommitPrompt
    .replace('{{window}}', `${formatIso(win.startMs)} → ${formatIso(win.endMs)}`)
    .replace('{{bundle}}', bundle);
  const response = await runClaudeOneshot(prompt, model);
  const sha7 = commit.sha.slice(0, 7);
  return {
    unitId: `commit:${sha7}`,
    label: `non-lazy commit \`${sha7}\` (${commit.author})`,
    summary: response.result.trim(),
  };
}

function formatOrphanConversationsBundle(orphans: StoredConversation[]): string {
  if (orphans.length === 0) return '_None._';
  const lines: string[] = [];
  for (const conv of orphans) {
    lines.push(`- ${conv.startedAt ?? '?'} session=${conv.sessionId.slice(0, 8)} branch=${conv.gitBranch ?? '-'} msgs=${conv.stats.messageCount} summary="${conv.summary}"`);
  }
  return lines.join('\n');
}

function formatUnitsBundle(results: MapResult[]): string {
  if (results.length === 0) return '_No units in this window._';
  return results.map(r => `#### Unit: ${r.label}\n\n${r.summary}`).join('\n\n');
}

function formatFailedUnits(failed: FailedUnit[]): string {
  if (failed.length === 0) return '_None._';
  return failed.map(f => `- ${f.label}: ${f.error}`).join('\n');
}

// ---------------------------------------------------------------------------
// PDF rendering (markdown → HTML → headless-Chrome → PDF) + open
// ---------------------------------------------------------------------------

/** Wrap rendered HTML in a print-friendly document. */
function buildPrintableHtml(body: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</title>
<style>
  @page { margin: 1.5cm 2cm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font: 11pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1c1c1c;
    max-width: 760px;
    margin: 0 auto;
  }
  h1 { font-size: 22pt; margin: 0 0 0.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
  h2 { font-size: 15pt; margin-top: 1.4em; border-bottom: 1px solid #eee; padding-bottom: 0.15em; }
  h3 { font-size: 12.5pt; margin-top: 1.2em; color: #2a2a2a; }
  h4 { font-size: 11pt; margin-top: 1em; }
  p, li, blockquote { font-size: 11pt; }
  p { margin: 0.5em 0; }
  code { font: 10pt/1.4 "SF Mono", Menlo, Consolas, monospace; background: #f4f4f6; padding: 0 4px; border-radius: 3px; }
  pre { background: #f6f6f8; padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #d0d0d6; margin: 0.6em 0; padding: 0.1em 0.9em; color: #555; }
  a { color: #0a58c2; text-decoration: none; }
  ul, ol { padding-left: 1.4em; margin: 0.4em 0; }
  li { margin: 0.2em 0; }
  /* Nested-list affordances. Our markdown renderer emits nested <ul>s
     as siblings to <li>s (not strictly inside) — descendant selectors
     style them anyway, and the outer <ul>'s padding-left still gives
     the visual indent. */
  ul ul, ol ol, ul ol, ol ul { margin: 0.15em 0 0.3em; }
  ul ul { list-style-type: circle; }
  ul ul ul { list-style-type: square; }
  hr { border: none; border-top: 1px solid #e0e0e6; margin: 1.4em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Locate a Chrome/Chromium binary suitable for headless PDF rendering. */
async function findChromeBinary(): Promise<string | null> {
  // macOS .app bundles (most likely on this user's environment).
  const macAppPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const p of macAppPaths) {
    try {
      await access(p);
      return p;
    } catch {
      // Not present — try the next candidate.
    }
  }
  // PATH-based lookup (Linux, or macOS via Homebrew).
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
    const proc = spawn(['which', name], { stdout: 'pipe', stderr: 'ignore' });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const path = stdout.trim();
    if (exitCode === 0 && path) return path;
  }
  return null;
}

/**
 * Render markdown to a PDF on disk using headless Chrome.
 * Throws with an actionable message if no Chrome variant is available.
 *
 * Test seam: under `LAZY_REPORT_PDF_STUB=1` this writes a minimal stub
 * PDF and returns without shelling out to a browser, so e2e tests can
 * exercise the flag wiring without a Chrome dependency. Distinct from
 * `LAZY_TEST` so it works in `withDaemon: true` tests that need the
 * real daemon-RPC path.
 */
async function renderPdf(markdown: string, outPath: string): Promise<void> {
  if (process.env.LAZY_REPORT_PDF_STUB === '1') {
    // Minimal valid-enough PDF stub for tests. The marker is unique
    // enough that test assertions can spot a real-vs-stub mistake.
    const stub = `%PDF-1.4\n% lazy report test stub (markdown length=${markdown.length})\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n`;
    await writeFile(outPath, stub, 'utf-8');
    return;
  }

  const chrome = await findChromeBinary();
  if (!chrome) {
    throw new Error(
      'No headless Chrome found. `lazy report --pdf` uses an existing ' +
      'Chrome/Chromium/Brave/Edge install in headless mode; lazy does not ' +
      'bundle one. Install any of those, or drop `--pdf` and redirect ' +
      'markdown to a file: `lazy report > report.md`.',
    );
  }

  const html = buildPrintableHtml(renderMarkdown(markdown), 'Lazy activity report');
  const tmpHtml = join(tmpdir(), `lazy-report-${process.pid}-${Date.now()}.html`);
  await writeFile(tmpHtml, html, 'utf-8');

  // Chrome runs sandboxed by default — the HTML we're rendering contains
  // the LLM's reduce-phase output, which is technically untrusted. The
  // env-var escape hatch is for the rare container/CI setup where the
  // kernel namespacing the sandbox needs isn't available; it should never
  // be the documented happy path.
  const chromeArgs = [
    chrome,
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${outPath}`,
    `file://${tmpHtml}`,
  ];
  if (process.env.LAZY_REPORT_CHROME_NO_SANDBOX === '1') {
    chromeArgs.splice(3, 0, '--no-sandbox');
  }

  try {
    const proc = spawn(chromeArgs, { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`Chrome exited with code ${exitCode} while rendering PDF: ${stderr.trim().split('\n').slice(-5).join('\n')}`);
    }
  } finally {
    // Clean up the intermediate HTML — the user wanted PDF, not bookkeeping.
    await rm(tmpHtml, { force: true });
  }
}

/** Open a file with the OS's default app association. Fire-and-forget. */
function openWithDefaultApp(path: string): void {
  // Tests can't observe a detached child usefully, and we don't want
  // CI runs popping open PDF viewers. Same gate as the PDF stub.
  if (process.env.LAZY_REPORT_PDF_STUB === '1') return;

  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' :
    'xdg-open';
  try {
    const proc = spawn([opener, path], { stdout: 'ignore', stderr: 'ignore' });
    // Detach so the CLI exits without waiting for the viewer to close.
    proc.unref?.();
  } catch (err) {
    logger.warn(`lazy report: could not auto-open ${path} via ${opener}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function commandReport(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'start', takesValue: true },
    { name: 'end', takesValue: true },
    { name: 'pdf', takesValue: false },
    { name: 'out', takesValue: true },
  ], 'report');

  const now = Date.now();
  const startSpec = (parsed.flags.get('start') as string | undefined) ?? '-24h';
  const endSpec = parsed.flags.get('end') as string | undefined;
  const wantPdf = parsed.flags.get('pdf') === true;
  const outSpec = parsed.flags.get('out') as string | undefined;
  if (outSpec && !wantPdf) {
    throw new Error('`--out` only applies with `--pdf` — drop the flag, or redirect markdown to a file with `lazy report > file.md`.');
  }

  const startMs = parseTimeSpec(startSpec, now);
  const endMs = endSpec ? parseTimeSpec(endSpec, now) : now;
  if (endMs < startMs) {
    throw new Error(`Resolved end (${formatIso(endMs)}) is before start (${formatIso(startMs)}).`);
  }
  const win: Window = { startMs, endMs };

  const root = requireLazyRoot();
  const storage = await requireStorage();

  const windowDescription = `${formatIso(startMs)} → ${formatIso(endMs)}`;
  logger.info(`lazy report: window ${windowDescription}`);

  try {
    logger.info(`lazy report: collecting lazy task activity...`);
    const lazyActivity = await collectLazyActivity(storage, win);
    logger.info(`lazy report: collected ${lazyActivity.tasks.length} lazy task(s) with in-window activity`);

    // Resolve the main branch and enumerate its commits in-window.
    const mainBranch = await getRemoteDefaultBranch(root).catch(() => 'main');
    logger.info(`lazy report: enumerating main-branch commits on '${mainBranch}'...`);
    const mainCommits = await enumerateMainCommits(root, mainBranch, win);
    logger.info(`lazy report: found ${mainCommits.length} main-branch commit(s) in window; classifying...`);

    // Classify each main commit. Cross-reference lazy-managed accept
    // commits to their task so the lazy-task map call includes them.
    // Serialized to keep the daemon's socket accept queue happy — see
    // the comment in collectLazyActivity.
    const classified: ClassifiedMainCommit[] = [];
    for (const c of mainCommits) {
      classified.push(await classifyMainCommit(c, lazyActivity.sessionCommitShas, storage));
    }
    const nonLazyCommits: MainBranchCommit[] = [];
    for (const c of classified) {
      if (c.kind === 'non-lazy') {
        nonLazyCommits.push(c.commit);
      } else if (c.resolvedTaskId) {
        const taskActivity = lazyActivity.tasksById.get(c.resolvedTaskId);
        if (taskActivity) {
          taskActivity.mainBranchCommits.push(c.commit);
        } else {
          // Accept commit for a task whose own activity is outside the
          // window — synthesize a minimal activity entry so we still
          // surface the merge.
          const task = await storage.getTask(c.resolvedTaskId);
          if (task) {
            const synthetic: TaskActivity = {
              task,
              createdInWindow: false,
              completedInWindow: false,
              statusChanges: [],
              turns: [],
              commits: [],
              comments: [],
              conversations: [],
              mainBranchCommits: [c.commit],
            };
            lazyActivity.tasks.push(synthetic);
            lazyActivity.tasksById.set(task.id, synthetic);
          }
        }
      }
    }

    logger.info(`lazy report: ${lazyActivity.tasks.length} lazy task unit(s), ${nonLazyCommits.length} non-lazy commit unit(s), ${lazyActivity.orphanConversations.length} orphan conversation(s)`);

    const config = await loadConfig(root);
    const model = config.models.default;

    // -----------------------------------------------------------------
    // Map phase — run all unit calls in parallel; per-call failures are
    // logged and recorded in failedUnits but do not abort the report.
    // Each call gets a label so progress messages are meaningful (the
    // human watching this CLI sees N+1 Claude calls fire and wants to
    // know what each one is for).
    // -----------------------------------------------------------------
    type Unit =
      | { kind: 'task'; activity: TaskActivity; label: string; unitId: string }
      | { kind: 'commit'; commit: MainBranchCommit; label: string; unitId: string };
    const units: Unit[] = [
      ...lazyActivity.tasks.map(a => ({
        kind: 'task' as const,
        activity: a,
        label: `lazy task \`${displayId(a.task)}\``,
        unitId: `task:${displayId(a.task)}`,
      })),
      ...nonLazyCommits.map(c => ({
        kind: 'commit' as const,
        commit: c,
        label: `non-lazy commit \`${c.sha.slice(0, 7)}\` (${c.author})`,
        unitId: `commit:${c.sha.slice(0, 7)}`,
      })),
    ];

    const totalMap = units.length;
    if (totalMap === 0) {
      logger.info(`lazy report: no units to summarize; skipping map phase`);
    } else {
      logger.info(`lazy report: map phase — running ${totalMap} Claude call(s) in parallel`);
    }

    // Wrap each map call so we can log per-unit start + finish progress.
    // `started` ticks first, then each settles to either `done` or
    // `failed`. `completed` is the running tally across both outcomes.
    let started = 0;
    let completed = 0;
    const settled = await Promise.allSettled(
      units.map(async u => {
        started += 1;
        const idx = started;
        logger.info(`lazy report: [${idx}/${totalMap}] summarizing ${u.label}...`);
        try {
          const result = u.kind === 'task'
            ? await mapTaskUnit(u.activity, win, model)
            : await mapCommitUnit(root, u.commit, win, model);
          completed += 1;
          logger.info(`lazy report: [${completed}/${totalMap}] done: ${u.label}`);
          return result;
        } catch (err) {
          completed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`lazy report: [${completed}/${totalMap}] FAILED: ${u.label}: ${msg}`);
          throw err;
        }
      }),
    );

    const mapResults: MapResult[] = [];
    const failedUnits: FailedUnit[] = [];
    settled.forEach((s, idx) => {
      const u = units[idx];
      if (s.status === 'fulfilled') {
        mapResults.push(s.value);
      } else {
        const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
        failedUnits.push({ unitId: u.unitId, label: u.label, error });
      }
    });

    // -----------------------------------------------------------------
    // Reduce phase
    // -----------------------------------------------------------------
    const reducePrompt = reportReducePrompt
      .replace('{{window}}', windowDescription)
      .replace('{{units}}', formatUnitsBundle(mapResults))
      .replace('{{orphan_conversations}}', formatOrphanConversationsBundle(lazyActivity.orphanConversations))
      .replace('{{failed_units}}', formatFailedUnits(failedUnits));

    logger.info(`lazy report: reduce phase — composing digest from ${mapResults.length} unit summary(ies)${failedUnits.length > 0 ? ` (${failedUnits.length} failed)` : ''}`);
    logger.debug(`lazy report: reduce prompt size = ${reducePrompt.length} chars`);

    const reduceResponse = await runClaudeOneshot(reducePrompt, model);

    // Assemble the full markdown digest (used either as stdout output
    // or as PDF input).
    const markdownLines: string[] = [
      '# Lazy activity report',
      '',
      `**Window:** ${windowDescription}`,
      '',
    ];
    if (failedUnits.length > 0) {
      markdownLines.push(`> ${failedUnits.length} unit(s) could not be summarized (see stderr).`);
      markdownLines.push('');
    }
    markdownLines.push(reduceResponse.result.trim());
    const markdown = markdownLines.join('\n');

    if (wantPdf) {
      // Auto-open only on the "no --out" convenience path. When the
      // user supplied --out, they signaled they're archiving / managing
      // the file themselves — don't surprise them by popping a viewer.
      const usingTmp = outSpec === undefined;
      const outPath = resolve(outSpec ?? join(tmpdir(), `lazy-report-${Date.now()}.pdf`));
      logger.info(`lazy report: rendering PDF to ${outPath}...`);
      await renderPdf(markdown, outPath);
      logger.info(`lazy report: done`);
      console.log(`Wrote PDF: ${outPath}`);
      if (usingTmp) {
        openWithDefaultApp(outPath);
      }
    } else {
      logger.info(`lazy report: done`);
      console.log(markdown);
    }
  } finally {
    await storage.close();
  }
}

export function reportUsage(): void {
  console.log(`Usage: lazy report [--start <spec>] [--end <spec>]

Print an LLM-summarized markdown digest of recent activity to stdout.
Covers ALL main-branch activity in the window — both lazy-managed
tasks AND direct (non-lazy) commits by collaborators not using lazy.

Three layered sections in the final output:
  Brief                       Skimmable overview (paragraph + bullets)
  For the engineering manager Decisions, direction, releases
  For the engineering lead    Substance — clustered thematically, with
                              lazy vs non-lazy work called out

Implementation note: this runs a map-reduce of LLM calls — one per
lazy task with activity, one per non-lazy main-branch commit, then a
final reduce. Per-run cost scales with activity volume.

Options:
  --start <spec>   Window start. Default: -24h. Accepts relative offsets
                   (-7d, -12h, -30m) or ISO timestamps.
  --end <spec>     Window end. Default: now. Same format as --start.
  --pdf            Render the digest as a PDF. Auto-opens with the OS
                   default viewer UNLESS --out is also provided (treat
                   --out as the archival path; --pdf alone as read-now).
                   Requires a Chrome/Chromium/Brave/Edge binary on the
                   host (used in headless mode); none is bundled.
  --out <path>     Write the PDF to <path> instead of a temp file. Does
                   NOT auto-open. Only valid with --pdf.

Examples:
  lazy report                              # last 24h, markdown to stdout
  lazy report --start -3d                  # last 3 days
  lazy report --start 2026-05-01 --end 2026-05-08
  lazy report --pdf                        # PDF in tmpdir, auto-opened
  lazy report --pdf --out ~/report.pdf     # PDF saved here, NOT opened`);
}

