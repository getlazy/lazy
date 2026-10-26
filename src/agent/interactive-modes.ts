/**
 * What each agent harness supports in an INTERACTIVE session lazy opens on a
 * task — Pair (the human takes over the agent's session) and Chat (a read-only
 * conversation with it) — and the flags that make a Chat read-only.
 *
 * One table for every surface: the CLI (`lazy pair`, `lazy chat`), the daemon
 * dashboard and Lazy Teams all refuse through {@link interactiveChatRefusal},
 * and the in-container session (`lazy-agent pair`) restates the refusal and
 * appends {@link interactiveChatArgs}, so a surface cannot offer a Chat the
 * session would run unlocked.
 */

import { PLAN_MODE_EXCLUDED_TOOLS } from './pi';
import { EXCLUDED_TOOLS_IN_PLAN_MODE as CURSOR_EXCLUDED_TOOLS } from './cursor';
import chatLiveSystemPrompt from '../prompts/chat-live-system-prompt.md' with { type: 'text' };
import chatLiveAnyAgentSystemPrompt from '../prompts/chat-live-any-agent-system-prompt.md' with { type: 'text' };

/**
 * Harnesses a Lazy Teams MEMBER can Pair or Chat with, in their own terminal
 * container (src/daemon/member-container.ts). Each one has its own isolation
 * in src/supervisor/pair.ts (prepareMemberSession): its home config is written
 * by lazy into the member's home, never read from the turn-writable sandbox,
 * and the worktree's own agent configuration is not loaded.
 */
export const MEMBER_SESSION_HARNESSES: readonly string[] = ['claude-code', 'codex', 'cursor', 'pi'];

/**
 * Why a read-only Chat cannot run on this harness, or null when it can.
 *
 * Codex is the one that cannot: its only read-only mode is its own sandbox,
 * which is bubblewrap, and bubblewrap cannot create a user namespace inside
 * lazy's containers — a read-only Codex session there can run no command at
 * all, so it could not even read the code it is asked about. Headless asks
 * avoid this by enforcing read-only in lazy instead (a read-only tool set plus
 * a write check after the turn, docs/codex-readonly-turns.md); an interactive
 * session has no "after" to check before the human acts on what it did.
 */
export function interactiveChatRefusal(harness: string): string | null {
  if (harness === 'codex') {
    return (
      'Chat is not available for Codex: its read-only mode needs a sandbox that cannot run inside a task\'s ' +
      'container, so a read-only Codex session could not even read the code. Use Ask for a read-only question ' +
      '(it runs Codex with lazy\'s own read-only checks), or Pair to work with the agent directly.'
    );
  }
  if (!['claude-code', 'cursor', 'pi'].includes(harness)) {
    return `Chat is not available for the '${harness}' agent: it has no read-only interactive mode. Use Ask instead.`;
  }
  return null;
}

/**
 * Flags that lock an interactive session read-only, appended to the agent's
 * interactive argv. Only for a harness {@link interactiveChatRefusal} allows.
 *
 *   - Claude Code: the reflective permission mode plus a hard denylist of its
 *     write tools — the same lockdown `lazy chat` uses.
 *   - Cursor: the same write-tool denylist (`--exclude-tools`) its headless
 *     asks use, never `--mode ask`/`--mode plan`: Cursor's own read-only modes
 *     also reject MCP calls, which would take the read-only lazy tools away
 *     (src/agent/cursor.ts). The chat system prompt cannot be passed — Cursor
 *     has no system-prompt flag — so the denylist is the whole lock.
 *   - Pi: the same denylist of write built-ins its headless asks use, plus the
 *     chat system prompt (`--exclude-tools`, `--append-system-prompt`,
 *     `pi --help`). Its lazy tools come from a read-only MCP server already.
 */
export function interactiveChatArgs(harness: string): string[] {
  if (harness === 'claude-code') {
    // Headless asks omit --permission-mode plan (it stalls on ExitPlanMode); an
    // interactive chat wants it.
    return [
      '--permission-mode', 'plan',
      '--disallowedTools', 'Bash Write Edit',
      '--append-system-prompt', chatLiveSystemPrompt,
    ];
  }
  if (harness === 'cursor') return ['--exclude-tools', CURSOR_EXCLUDED_TOOLS];
  if (harness === 'pi') return ['--exclude-tools', PLAN_MODE_EXCLUDED_TOOLS, '--append-system-prompt', chatLiveAnyAgentSystemPrompt];
  throw new Error(interactiveChatRefusal(harness) ?? `No read-only chat flags for '${harness}'.`);
}
