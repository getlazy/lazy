/**
 * The file that marks a member's own terminal container, relative to its home.
 *
 * The daemon writes it into the home it builds for that container
 * (src/daemon/member-container.ts); `lazy-agent doctor` reads it
 * (./doctor.ts). Pair/Chat supply connection-specific MCP configuration on
 * their command line, rather than a shared home entry or daemon config env
 * variable. Doctor must explain that rather than report three failures.
 * It decides nothing but
 * what doctor prints: it is a label, not a credential or a gate.
 */
export const MEMBER_SESSION_MARKER = '.claude/lazy-member-session';

export const MEMBER_SESSION_MARKER_TEXT =
  "This is a member's own terminal environment: Pair and Chat supply connection-specific lazy MCP tools.\n";
