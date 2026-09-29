/**
 * The file that marks a member's own terminal container, relative to its home.
 *
 * The daemon writes it into the home it builds for that container
 * (src/daemon/member-container.ts); `lazy-agent doctor` reads it
 * (./doctor.ts). Such a container deliberately has no lazy MCP server, no
 * daemon config and no lazy tool permissions, and doctor must say so rather
 * than report three failures to the member reading it. It decides nothing but
 * what doctor prints: it is a label, not a credential or a gate.
 */
export const MEMBER_SESSION_MARKER = '.claude/lazy-member-session';

export const MEMBER_SESSION_MARKER_TEXT =
  "This is a member's own terminal environment: no lazy MCP server and no daemon config, by design.\n";
