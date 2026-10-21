/**
 * Which listed Builder a member may resume, and as what (the Builders page's
 * Resume, `resumeBuilder` in src/daemon/builder-sessions.ts). Pure: the daemon
 * hands it the Builder, the caller and whether other members can exist.
 *
 * A Builder is resumed by continuing its NEWEST segment — the Claude session a
 * resume continues (BuilderSummary.segments, oldest first).
 *
 * Only a member's OWN Builder resumes. A teammate's would have to be COPIED
 * into the resuming member's builder home, and the session file holds more than
 * the transcript every member can read on the Builders page: the stored
 * transcript keeps only the text of each message (src/import/claude-code-logs.ts
 * drops tool_use and tool_result blocks), while the file carries every command
 * the builder ran and everything those commands printed. Until that is decided,
 * a teammate's Builder is refused here, in one place, saying why.
 */

import type { BuilderSummary } from '../storage/types';

export type BuilderResumeDecision =
  | { kind: 'own'; sessionId: string }
  | { kind: 'refuse'; status: number; message: string };

function sameMember(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function decideBuilderResume(
  builder: BuilderSummary,
  callerEmail: string | null,
  multiMember: boolean,
): BuilderResumeDecision {
  const sessionId = builder.segments[builder.segments.length - 1];
  if (!sessionId) {
    return { kind: 'refuse', status: 409, message: `Builder ${builder.id} has no captured session to resume.` };
  }
  // With nobody else on this daemon, every Builder in its store is the caller's.
  if (!multiMember || sameMember(builder.memberEmail, callerEmail)) return { kind: 'own', sessionId };

  const owner = builder.memberEmail?.trim();
  return {
    kind: 'refuse',
    status: 403,
    message: owner
      ? `This builder is ${owner}'s. Only your own builders can be resumed for now: continuing a teammate's ` +
        `would copy its whole session, including the commands it ran and their output, which its transcript ` +
        `here does not show.`
      : `Nobody is recorded as this builder's owner, so it cannot be resumed as yours.`,
  };
}
