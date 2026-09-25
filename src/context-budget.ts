/**
 * Measure the context lazy injects into a session before its first message.
 *
 * Every launch pays for the same four things — the CLAUDE.md files the agent
 * harness loads, lazy's own system prompt (which carries the project's LAZY.md
 * instructions), the shared-memory index, and the MCP tool schemas — and none
 * of them had a number attached anywhere in lazy. The
 * only place they showed up was Claude Code's own `/context` screen, which
 * nobody opens until a session is already behaving oddly, and its "CLAUDE.md is
 * over the 40.0k-char limit" line scrolls past at startup.
 *
 * This module produces the numbers; `lazy doctor` renders them, one line per
 * contributor per role, as the single surface where they live.
 *
 * BUILDER AND AGENT ARE MEASURED SEPARATELY because they genuinely differ:
 *   - different system prompts (builder-system-prompt.md, plus dashboard,
 *     system messages and model guidance, vs the agent's tool instructions +
 *     system instructions);
 *   - different memory templates (the two surfaces of `assembleMemorySection`);
 *   - different CLAUDE.md sets — the builder container mounts the human's
 *     `~/.claude`, so their user-level CLAUDE.md is loaded too, while a task
 *     container is handed a fresh `.claude` and never sees it.
 * The MCP tool list also differs: each role is advertised only the tools it can
 * actually call, so neither pays for the other's schemas.
 *
 * FIDELITY — the numbers are the launch's own bytes, not a re-assembly. Every
 * contributor is measured by calling the function the launch path calls:
 * `assembleBuilderSystemPrompt` for the builder (its `announceMemorySize: false`
 * suppresses one `logger.warn` and nothing else — the returned string is
 * byte-identical), `buildSystemPrompt` for the agent with the same three
 * arguments the daemon passes, `assembleMemorySection` for the memory index, and
 * `serializedToolSurface(role)` — the MCP server's own advertised-list builder —
 * for the tool surface, which is the shape `tools/list` puts on the wire. The
 * CLAUDE.md files are read from disk. Nothing here re-implements a prompt.
 *
 * Where a launch can still differ, and why:
 *   - RESUME turns use a different prompt (`buildSystemPromptForResume`), so an
 *     interrupted task's next turn is not the number below. Same order of
 *     magnitude, different bytes.
 *   - READ-ONLY (ask) turns advertise fewer tools, so their tool surface is
 *     smaller. The role's full list is the honest default: it is what an
 *     ordinary turn pays.
 *   - The BUILDER prompt embeds a dashboard section chosen by a live daemon
 *     health check, an unread-system-messages block, and either a short
 *     model-selection note or the full model-guidance template depending on
 *     whether the project pins a model. All three are read at measurement time
 *     from the same sources a launch reads, so the number tracks the project's
 *     current state — including the daemon being down, which selects the
 *     "unavailable" dashboard variant a real launch would then also select.
 *   - RUNNER instructions differ per runner; the project's configured runner is
 *     the one measured, because that is the one a launch would use.
 *
 * WHAT IS DELIBERATELY NOT COUNTED, and why it is not a gap:
 *   - Per-turn and per-task text: the task prompt and goal, turn history, the
 *     notes/comments block, remote comments, the journal-count line, the
 *     artifacts listing, the maintained-files nudge and the protected-file
 *     push-back. Every one is conditional or grows with the task; averaging them
 *     into a "before the first message" total would make the total unfalsifiable.
 *   - Nested CLAUDE.md files in subdirectories: Claude Code loads those on
 *     demand, when the agent reads a file in that directory, not at startup.
 *     Nested LAZY.md files ARE counted, because lazy has no on-demand hook and
 *     injects them up front — the asymmetry is real, not an oversight.
 *   - The harness's OWN system prompt, its built-in tools and its
 *     `<system-reminder>` machinery. Those are Claude Code's, not lazy's, and no
 *     project setting changes them. This is why the total here is much smaller
 *     than the one on `/context`: doctor reports what LAZY costs a session, plus
 *     the CLAUDE.md files it is lazy's business to warn about.
 *
 * This lives outside `src/cli/` deliberately: it is domain logic (what does a
 * launch cost), not presentation, so the daemon can serve it later without
 * importing a CLI module.
 *
 * The evidence behind every claim above — the fidelity table, the classification
 * of what is and is not counted, how the limit formula was read and how to
 * re-read it, why the token figures are not scaled, and the side-effect audit —
 * is in docs/context-budget-measurement.md.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { assembleMemorySection } from './memory';
import { buildSystemPrompt } from './task/turn-context';
import { collectLazyMdFiles, renderLazyMdSection } from './task/lazy-md';
import { assembleBuilderSystemPrompt } from './builder/system-prompt';
import { renderChattinessSnippet, resolveAgentChattiness } from './config/chattiness';
import { serializedToolSurface } from './mcp/tool-surface';
import { resolveRoleTarget } from './utils/role-target';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  effectiveContextWindow,
  type EffectiveContextWindow,
} from './agent/context-window';
import { countTokens, type TokenCountMethod } from './utils/token-count';
import type { ResolvedConfig } from './config/types';
import type { Runner } from './runner';
import type { Storage } from './storage/interface';

import mcpServerInstructions from './prompts/mcp-server-instructions.md' with { type: 'text' };
import goalContextStartText from './prompts/goal-context-start.md' with { type: 'text' };

/**
 * The Claude Code release the memory-file limit below was read out of.
 *
 * The limit is not documented anywhere lazy can query, so it was read from the
 * shipped bundle rather than guessed — and a number read from one release can
 * go stale in the next. Nothing in lazy detects that: `Dockerfile.lazy` installs
 * Claude Code unpinned (`claude.ai/install.sh`), so the agent's harness is
 * whatever was current when the image was built, and the host may have a
 * different one again. Naming the verified version is what makes a wrong number
 * findable — the reader can see what it was checked against, and
 * `test/unit/context-budget.test.ts` pins the version and the formula together
 * so changing either is a deliberate edit.
 *
 * To re-verify: find the memory-file size check in the installed bundle
 * (`~/.local/bin/claude` → its `cli.js`) and confirm the floor, the window
 * fraction and the chars-per-token factor below still match.
 */
export const CLAUDE_MD_LIMIT_VERIFIED_VERSION = '2.1.266';

/** Floor of the memory-file limit — the limit never goes below this. */
export const CLAUDE_MD_LIMIT_FLOOR = 40_000;

/** Fraction of the context window the memory-file limit is allowed to reach. */
export const CLAUDE_MD_LIMIT_WINDOW_FRACTION = 0.05;

/** Characters per token Claude Code assumes when it converts that fraction to chars. */
export const CLAUDE_MD_LIMIT_CHARS_PER_TOKEN = 4;

/**
 * The per-file character limit Claude Code warns about, as a function of the
 * context window — the form it actually takes in the bundle:
 *
 *   limit = max(40000, round(contextWindowTokens * 0.05 * charsPerToken))
 *
 * DERIVED, not hardcoded, because the two halves move together: a 200k-token
 * window lands exactly on the 40,000 floor, but a 1M-token window raises the
 * limit to 200,000. Hardcoding 40,000 would make doctor warn "over the
 * 40,000-char limit" at a window where Claude Code says nothing at all — a
 * false positive on the one line this whole section exists to surface early.
 *
 * The comparison is applied to EACH memory file's length independently — not to
 * their sum — and only to the user / project / local / managed kinds.
 *
 * It is a WARNING ONLY: the file is still injected in full, nothing is
 * truncated and nothing is blocked, for the project file and the user-level one
 * alike. Claude Code renders it at startup ("… is over the 40.0k-char limit
 * (41.9k chars)") and in `/doctor` ("Large project memory will impact
 * performance"). Doctor says the same thing on a surface the human is already
 * reading.
 */
export function claudeMdCharLimit(windowTokens: number): number {
  return Math.max(
    CLAUDE_MD_LIMIT_FLOOR,
    Math.round(windowTokens * CLAUDE_MD_LIMIT_WINDOW_FRACTION * CLAUDE_MD_LIMIT_CHARS_PER_TOKEN),
  );
}

/**
 * The window used when a role's real one cannot be resolved.
 *
 * NOT "the context window": every number below is reported against the window
 * the role's own launch would get, resolved per role through
 * {@link effectiveContextWindow} from the model it runs and whether its traffic
 * reaches Anthropic's first-party API. This constant is only the fallback that
 * resolution itself falls back to — an unknown model, a non-Claude-Code
 * harness — and it is re-exported from `src/agent/context-window.ts` so there
 * is one default, not two.
 *
 * It used to be the whole story, and that was a real bug: with lazy's proxy in
 * front of every launch, Claude Code capped 1M-window models at 200k, and this
 * constant agreed with the symptom instead of exposing it.
 */
export const CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

/** The memory-file limit at the fallback window — 40,000. */
export const CLAUDE_MD_CHAR_LIMIT = claudeMdCharLimit(CONTEXT_WINDOW_TOKENS);

/**
 * Fraction of the window above which the static injection gets an advisory.
 *
 * A fifth of the window spent before the human's first word is where the cost
 * stops being an implementation detail: the session starts with less room for
 * the actual work, and every later turn re-reads it. Advisory only — lazy never
 * truncates any of it, and the threshold is a prompt to go look.
 */
export const CONTEXT_BUDGET_WARN_FRACTION = 0.2;

/**
 * Token total the advisory fires above, for a given window.
 *
 * A fraction of the ROLE's window, not of a constant: a 40k injection is a
 * fifth of a 200k session and four percent of a 1M one, and only the first is
 * worth a line telling the human to go trim something.
 */
export function contextBudgetWarnTokens(windowTokens: number): number {
  return Math.round(windowTokens * CONTEXT_BUDGET_WARN_FRACTION);
}

/** Token total the advisory fires above at the fallback window — 40,000. */
export const CONTEXT_BUDGET_WARN_TOKENS = contextBudgetWarnTokens(CONTEXT_WINDOW_TOKENS);

export type ContextRole = 'builder' | 'agent';

/** One measured contributor to a role's starting context. */
export interface ContextContributor {
  label: string;
  chars: number;
  /** Lower bound on tokens — see {@link measureText} for why it is a bound. */
  tokens: number;
  /**
   * True when the line breaks down another line and must NOT be added to the
   * total (the shared-memory index, which is part of the system prompt).
   */
  nested?: boolean;
  /** Neutral context, printed after the numbers. */
  note?: string;
  /** Something the human should act on. */
  warning?: string;
  /** What to change, and where. Only ever set when there is a real answer. */
  remedy?: string;
}

export interface RoleContextBudget {
  role: ContextRole;
  contributors: ContextContributor[];
  /** Exact — the sum of every non-nested contributor's characters. */
  totalChars: number;
  /** Lower bound, being a sum of lower bounds. */
  totalTokens: number;
  /**
   * The window THIS role's launch gets — the model it runs, judged against the
   * upstream its traffic reaches. See {@link effectiveContextWindow}; the two
   * roles genuinely differ when a project points them at different profiles.
   */
  windowTokens: number;
  /** How that window was arrived at, and whether it was read or assumed. */
  window: EffectiveContextWindow;
  /**
   * The token FLOOR is already over a fifth of THIS role's window.
   *
   * Comparing a floor against the threshold makes the advisory one-sided on
   * purpose: it cannot fire on a role that is genuinely under, and it stays
   * silent on some that are genuinely over. For a line whose whole job is to be
   * believed the first time, a missed warning beats a false one.
   */
  overAdvisory: boolean;
  /** How the token figures were produced, for the caveat line. */
  method: TokenCountMethod;
}

export interface ContextBudgetReport {
  roles: RoleContextBudget[];
  /** Set when measurement could not run; `roles` is then empty. */
  error?: string;
}

export interface MeasureContextBudgetOptions {
  lazyRoot: string;
  config: ResolvedConfig;
  storage: Storage;
  runner: Runner;
  /** Home directory whose `~/.claude/CLAUDE.md` the builder container mounts. */
  home: string;
}

/** A measured piece of injected text: exact characters, approximate tokens. */
export interface TextMeasurement {
  chars: number;
  tokens: number;
  method: TokenCountMethod;
}

/**
 * Measure one piece of injected text: exact characters, a LOWER BOUND on tokens.
 *
 * Tokens come from the project's own estimator (`src/utils/token-count.ts`) on
 * its offline BPE tier, so there is no second heuristic in the codebase. That
 * module is explicit that the tier "undercounts Claude by roughly 15-20% on
 * ordinary prose and by more on code", and equally explicit about what follows:
 * "Never publish an absolute Claude token count from this tier."
 *
 * So doctor does not publish one. It publishes the count as a FLOOR — "at least
 * N tokens" — which is a claim the estimator supports: every documented error is
 * in one direction, downwards, so the BPE count is a bound rather than a guess.
 * A floor stays true whatever the real bias turns out to be on a given file.
 *
 * Scaling by the quoted 15-20% instead was considered and rejected. The figure
 * is the estimator's own prose, unmeasured here (calibrating it needs the `api`
 * tier, which needs a spendable Anthropic credential doctor must not require),
 * it is a range rather than a factor, and the doc says the true bias is LARGER
 * on code — while the biggest contributor measured here is JSON tool schemas.
 * Multiplying by a number that is wrong for the dominant contributor would turn
 * a defensible bound into a confident fabrication.
 *
 * Characters are exact, and are the unit Claude Code's own limit is expressed
 * in, so both are reported and the character figure is the one to act on.
 *
 * Falls back to the chars/4 tier if the BPE tables cannot be loaded. A
 * diagnostic that prints no number because a tokenizer failed to import would
 * be worse than one that prints a coarser number and names the tier. That tier
 * is NOT a floor — it is the old uniform heuristic, which can land either side
 * of the truth — so `method` travels with the numbers and doctor says which it
 * got.
 */
export async function measureText(text: string): Promise<TextMeasurement> {
  const chars = text.length;
  try {
    const counted = await countTokens(text);
    return { chars, tokens: counted.tokens, method: counted.method };
  } catch {
    const counted = await countTokens(text, { method: 'chars' });
    return { chars, tokens: counted.tokens, method: counted.method };
  }
}

/** A CLAUDE.md-style memory file the agent harness loads at startup. */
export interface ClaudeMemoryFile {
  /** Absolute path on disk. */
  path: string;
  /** How doctor names it, e.g. "CLAUDE.md (project)". */
  label: string;
  content: string;
  /** The limit this file was compared against, derived from the window. */
  limit: number;
  /** Over {@link limit} — Claude Code warns; nothing truncates. */
  overLimit: boolean;
}

/**
 * The CLAUDE.md files a role's harness loads from disk at startup.
 *
 * Paths verified against Claude Code 2.1.266: project memory is `CLAUDE.md` in
 * the working directory (`.claude/CLAUDE.md` is treated the same way), local
 * memory is `CLAUDE.local.md` beside it, and user memory is
 * `~/.claude/CLAUDE.md`. Nested CLAUDE.md files deeper in the tree load ON
 * DEMAND, when the agent reads a file in that directory, so they are not part
 * of the starting budget and are deliberately not counted.
 *
 * A task agent reads its worktree's copy rather than the project root's, but
 * the two are the same file until a task edits it — the root's copy is the
 * honest answer to "what does a new task start with", and doctor prints the
 * path it read.
 */
export async function findClaudeMemoryFiles(
  role: ContextRole,
  opts: { lazyRoot: string; home: string; windowTokens?: number },
): Promise<ClaudeMemoryFile[]> {
  const limit = claudeMdCharLimit(opts.windowTokens ?? CONTEXT_WINDOW_TOKENS);
  const candidates: Array<{ path: string; label: string }> = [
    { path: join(opts.lazyRoot, 'CLAUDE.md'), label: 'CLAUDE.md (project)' },
    { path: join(opts.lazyRoot, '.claude', 'CLAUDE.md'), label: 'CLAUDE.md (project, .claude/)' },
    { path: join(opts.lazyRoot, 'CLAUDE.local.md'), label: 'CLAUDE.local.md (project)' },
  ];
  // Only the builder container mounts the human's ~/.claude, so only the
  // builder pays for their user-level memory file. A task container gets a
  // fresh .claude and never sees it — charging both roles for it would invent a
  // cost agents do not have.
  if (role === 'builder') {
    candidates.push({
      path: join(opts.home, '.claude', 'CLAUDE.md'),
      label: 'CLAUDE.md (user, ~/.claude)',
    });
  }

  const found: ClaudeMemoryFile[] = [];
  for (const candidate of candidates) {
    let content: string;
    try {
      content = await readFile(candidate.path, 'utf-8');
    } catch {
      // Absent is the normal case for three of these four paths, and an
      // unreadable one is not a project health problem — a memory file doctor
      // cannot read is one the agent cannot read either, and the files it does
      // read still give an accurate picture. Left out of the report.
      continue;
    }
    found.push({
      path: candidate.path,
      label: candidate.label,
      content,
      limit,
      overLimit: content.length > limit,
    });
  }
  return found;
}

/**
 * The MCP tool surface a role is served, as it goes over the wire in a
 * `tools/list` reply.
 *
 * Re-exported rather than re-derived: this is the same function the MCP server
 * builds its advertised list from (`src/mcp/tool-surface.ts`), so the number
 * reported here cannot drift from the tools a session is actually sent.
 */
export { serializedToolSurface };

/**
 * Build one role's report from its measured contributors.
 *
 * Exported for the tests that pin the nesting rule: a `nested` contributor is a
 * breakdown of a line already counted, so adding it to the total would charge
 * the shared-memory index twice.
 */
export function summarizeContextBudgetRole(
  role: ContextRole,
  contributors: ContextContributor[],
  method: TokenCountMethod,
  window: EffectiveContextWindow = UNRESOLVED_WINDOW,
): RoleContextBudget {
  const counted = contributors.filter(c => !c.nested);
  const totalChars = counted.reduce((sum, c) => sum + c.chars, 0);
  const totalTokens = counted.reduce((sum, c) => sum + c.tokens, 0);
  return {
    role,
    contributors,
    totalChars,
    totalTokens,
    windowTokens: window.tokens,
    window,
    overAdvisory: totalTokens > contextBudgetWarnTokens(window.tokens),
    method,
  };
}

/**
 * The window a caller that resolved none is reported against.
 *
 * Only the tests and any future non-measuring caller land here — the real
 * measurement resolves each role's own. It says `known: false` for the same
 * reason every other unresolved path does: an assumed number must never be
 * printed as a read one.
 */
const UNRESOLVED_WINDOW: EffectiveContextWindow = {
  tokens: CONTEXT_WINDOW_TOKENS,
  known: false,
  reason: 'no role target resolved — reporting the default',
};

/**
 * The context window a role's next launch will get.
 *
 * Built from config alone, deliberately. `proxyUrl` is left unset — it is the
 * proxy's ADDRESS, and the first-party question is about its UPSTREAM, so the
 * answer is the same whether or not a daemon happens to be up right now. A
 * doctor run on a stopped project must still be able to say what the window is.
 *
 * `preferredModel` carries `[models] default` for the same reason the launch
 * does: an unpinned profile returns an empty model meaning "caller's default",
 * and reporting a window for the empty string would report nothing useful.
 *
 * Never throws — `resolveRoleTarget` refuses a pinned profile with no model,
 * and a config problem is the config check's line to report, not this one's.
 */
export function windowForRole(role: ContextRole, config: ResolvedConfig): EffectiveContextWindow {
  try {
    const target = resolveRoleTarget(role, config, { preferredModel: config.models.default });
    return effectiveContextWindow({ ...target, primaryUpstream: config.proxy.upstream });
  } catch (err) {
    return {
      tokens: CONTEXT_WINDOW_TOKENS,
      known: false,
      reason:
        `could not resolve the ${role} role's model ` +
        `(${err instanceof Error ? err.message : String(err)}) — reporting the default`,
    };
  }
}

/** The remedy for a CLAUDE.md over Claude Code's per-file limit. */
export function claudeMdRemedy(path: string): string {
  return (
    `It is still injected in full — nothing is truncated — but the harness warns at every ` +
    `startup and re-reads the whole file every turn. Move the parts only some tasks need out ` +
    `of ${path} into a doc they can read on demand.`
  );
}

/**
 * Measure what lazy injects into a builder session and into a task agent
 * session, before either has read a word of the human's request.
 *
 * Never throws: a diagnostic that dies while measuring is worse than one that
 * says it could not measure. A failure comes back as `error` with no roles.
 */
export async function measureContextBudget(
  opts: MeasureContextBudgetOptions,
): Promise<ContextBudgetReport> {
  try {
    const warnBytes = opts.config.memory.warn_bytes;
    const records = await opts.storage.listMemories();
    const compact = await opts.storage.getMemoryCompact();

    const instructionsMeasured = await measureText(mcpServerInstructions);
    // The template with its {{goal}} placeholder removed — the goal itself is
    // per-task and belongs to the variable half, the wrapper around it does not.
    const goalContextMeasured = await measureText(
      goalContextStartText.replace(/\{\{goal\}\}/g, ''),
    );

    const roles: RoleContextBudget[] = [];

    for (const role of ['builder', 'agent'] as ContextRole[]) {
      // The window every number below is reported against, resolved the way the
      // launch resolves it: this role's profile, the model it lands on
      // (`[models] default` when the profile pins none), and `[proxy] upstream`
      // — which is what decides whether Claude Code grants a 1M-window model its
      // 1M window at all. Resolved here rather than read off the runner because
      // a live proxy address is not needed to answer it, and doctor must not
      // fail to report a window just because no daemon is up.
      const window = windowForRole(role, opts.config);

      // Per role: the two are served different tool lists (a builder is not
      // advertised the agent-only tools, and vice versa), so one shared
      // measurement would misreport both.
      const tools = serializedToolSurface(role);
      const toolsMeasured = await measureText(tools.text);

      // assembleMemorySection rather than buildMemorySection: the latter logs
      // the over-threshold CTA, and a diagnostic that tells you to run the
      // command you are already running is noise.
      const memory = assembleMemorySection(records, role, { compact, warnBytes });
      const memoryMeasured = await measureText(memory.section);

      // LAZY.md is injected into the AGENT system prompt only (src/task/lazy-md
      // — the builder is not handed it), and is read here from the project root
      // for the same reason the CLAUDE.md files are: a task reads its own
      // worktree's copy, but the two are the same file until a task edits one,
      // and the root's copy is the honest answer to "what does a new task start
      // with".
      const lazyMd =
        role === 'agent' ? renderLazyMdSection(await collectLazyMdFiles(opts.lazyRoot)) : '';
      const lazyMdMeasured = await measureText(lazyMd);

      const systemPrompt =
        role === 'builder'
          ? await assembleBuilderSystemPrompt({
              lazyRoot: opts.lazyRoot,
              runner: opts.runner,
              storage: opts.storage,
              // Measuring, not launching: the over-threshold memory line would
              // tell the human to run the command they are running.
              announceMemorySize: false,
            })
          : buildSystemPrompt(
              opts.runner.getAgentInstructions(),
              renderChattinessSnippet(resolveAgentChattiness(opts.config)),
              memory.section,
              lazyMd,
            );
      const promptMeasured = await measureText(systemPrompt);

      const contributors: ContextContributor[] = [];

      for (const file of await findClaudeMemoryFiles(role, {
        ...opts,
        windowTokens: window.tokens,
      })) {
        const measured = await measureText(file.content);
        contributors.push({
          label: file.label,
          chars: measured.chars,
          tokens: measured.tokens,
          ...(file.overLimit
            ? {
                warning:
                  `over the ${file.limit.toLocaleString('en-US')}-char per-file limit Claude Code ` +
                  `${CLAUDE_MD_LIMIT_VERIFIED_VERSION} warns at`,
                remedy: claudeMdRemedy(file.path),
              }
            : {}),
        });
      }

      contributors.push({
        label: 'lazy system prompt',
        chars: promptMeasured.chars,
        tokens: promptMeasured.tokens,
        note:
          role === 'builder'
            ? 'builder prompt, runner instructions, dashboard, system messages, model guidance, shared memory'
            : 'tool instructions, system instructions, runner instructions, shared memory, LAZY.md',
      });

      if (memory.section) {
        contributors.push({
          label: 'of which shared memory index',
          chars: memoryMeasured.chars,
          tokens: memoryMeasured.tokens,
          nested: true,
          ...(memory.measured.overThreshold
            ? { note: 'over [memory] warn_bytes — see the injected memory context check above' }
            : {}),
        });
      }

      // Nested for the same reason the memory index is: it is already inside
      // the system prompt line above, and adding it again would charge the
      // project's instructions twice.
      if (lazyMd) {
        contributors.push({
          label: 'of which LAZY.md (project instructions)',
          chars: lazyMdMeasured.chars,
          tokens: lazyMdMeasured.tokens,
          nested: true,
        });
      }

      contributors.push({
        label: `MCP tool schemas (${tools.count} tools)`,
        chars: toolsMeasured.chars,
        tokens: toolsMeasured.tokens,
        note:
          role === 'builder'
            ? 'the builder is not served the agent-only tools (raise, report, commit, …)'
            : 'a task agent is not served the builder-only tools (memory save, promote, clone, …); read-only ask turns serve fewer still',
      });

      contributors.push({
        label: 'MCP server instructions',
        chars: instructionsMeasured.chars,
        tokens: instructionsMeasured.tokens,
      });

      // Small, but real and unconditional: every task turn's user message opens
      // with this preamble. Listed so the parts add up to the total exactly —
      // a reader who checks the arithmetic should not find a silent remainder.
      // The builder has no equivalent: its first message is the human's.
      if (role === 'agent') {
        contributors.push({
          label: 'goal context preamble',
          chars: goalContextMeasured.chars,
          tokens: goalContextMeasured.tokens,
          note: "the task's own goal and prompt are per-task, on top of this",
        });
      }

      roles.push(summarizeContextBudgetRole(role, contributors, toolsMeasured.method, window));
    }

    return { roles };
  } catch (err) {
    return { roles: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The largest contributor the human can actually shrink, for the advisory's
 * remedy line.
 *
 * "Can shrink" is the point: the MCP tool schemas and lazy's system prompt are
 * lazy's own surface and no project setting trims them, so naming them would be
 * advice nobody can take. Only the CLAUDE.md files, the project's LAZY.md
 * instructions and the shared-memory index belong to the human.
 */
export function largestTrimmable(role: RoleContextBudget): ContextContributor | null {
  const trimmable = role.contributors.filter(
    c => c.label.startsWith('CLAUDE') || c.label.includes('LAZY.md') || c.label.includes('shared memory'),
  );
  if (trimmable.length === 0) return null;
  return trimmable.reduce((biggest, c) => (c.chars > biggest.chars ? c : biggest));
}

/** What to do about a role whose starting context is over the advisory. */
export function contextBudgetRemedy(role: RoleContextBudget): string {
  const biggest = largestTrimmable(role);
  if (!biggest) {
    return (
      `All of it is lazy's own prompt and tool surface, which a project cannot trim — ` +
      `nothing to do here.`
    );
  }
  if (biggest.label.includes('shared memory')) {
    return (
      `Largest thing you control: the shared memory index. Shrink it with ` +
      `\`lazy memory compact\`, or curate the records with \`lazy memory save\` / \`lazy memory rm\`.`
    );
  }
  return (
    `Largest thing you control: ${biggest.label}. Move the parts only some tasks need into a ` +
    `doc they can read on demand.`
  );
}
