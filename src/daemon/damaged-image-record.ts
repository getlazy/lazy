/**
 * Where the daemon records a damaged-image repair (src/docker/damaged-image.ts):
 * the task's JOURNAL (never a comment — a comment is delivered into the agent's
 * next prompt, and this is a record, not guidance), and a system message filed
 * under the same source as the machine's Docker events, so the project's
 * machine record shows it next to the dockerd deaths that usually explain it.
 */

import type { SystemMessage, SystemMessageInput } from '../types';
import type { DamagedImageRepairEvent } from '../docker/damaged-image';
import { GUEST_DOCKERD_MESSAGE_SOURCE } from './guest-dockerd';


/** The evidence captured before the repair, as plain text for a system message. */
function evidenceText(event: DamagedImageRepairEvent): string {
  return event.evidence ? `\n\n${EVIDENCE_HEADING}\n${event.evidence}` : '';
}

/** The same, fenced, for the task journal (markdown). */
function evidenceMarkdown(event: DamagedImageRepairEvent): string {
  return event.evidence ? `\n\n${EVIDENCE_HEADING}\n\n\`\`\`\n${event.evidence}\n\`\`\`` : '';
}

/** Marks the evidence in a message body; doctor finds it by this heading. */
export const EVIDENCE_HEADING = 'What the damaged image looked like before it was removed:';
export function damagedImageSystemMessage(event: DamagedImageRepairEvent): SystemMessageInput {
  const who = event.taskId ? `the ${event.subject} ${event.taskId}` : `a ${event.subject}`;
  if (event.outcome === 'repaired') {
    return {
      source: GUEST_DOCKERD_MESSAGE_SOURCE,
      kind: 'notice',
      title: "A damaged runner image was rebuilt in this project's machine",
      body:
        `Launching ${who} failed because Docker could not read back a layer of the image ${event.imageName}. ` +
        `lazy removed that image (nothing else) and rebuilt it without the build cache. ` +
        (event.error ? `Docker could read it again, but ${event.error}.\n\n` : `The launch then succeeded.\n\n`) +
        `Docker said: ${event.dockerMessage}` + evidenceText(event),
    };
  }
  return {
    source: GUEST_DOCKERD_MESSAGE_SOURCE,
    kind: 'alert',
    title: "A damaged runner image could not be repaired in this project's machine",
    body:
      `Launching ${who} failed because Docker could not read back a layer of the image ${event.imageName}. ` +
      `lazy tried to remove and rebuild that image by itself, and it did not help: ${event.error ?? 'no detail'}\n\n` +
      `The damage is likely elsewhere in Docker's storage; a project admin can reset it from the project's page ` +
      `(Reset Docker storage), which removes every image, container and volume on the machine.\n\n` +
      `Docker said: ${event.dockerMessage}` + evidenceText(event),
  };
}

export function damagedImageJournalEntry(event: DamagedImageRepairEvent): string {
  return event.outcome === 'repaired'
    ? `**Damaged runner image repaired.** The launch failed because Docker could not extract a layer of \`${event.imageName}\`; ` +
      `lazy removed that image, rebuilt it without the cache and retried the launch once` +
      (event.error ? `; Docker could read the image again, but ${event.error}.\n\n` : `, which succeeded.\n\n`) +
      `Docker said:\n\n\`\`\`\n${event.dockerMessage}\n\`\`\`` + evidenceMarkdown(event)
    : `**Damaged runner image NOT repaired.** The launch failed because Docker could not extract a layer of \`${event.imageName}\`; ` +
      `lazy's targeted repair (remove that image, rebuild it, retry once) did not help: ${event.error ?? 'no detail'}\n\n` +
      `Docker said:\n\n\`\`\`\n${event.dockerMessage}\n\`\`\`` + evidenceMarkdown(event);
}

export async function recordDamagedImageRepair(
  storage: {
    createSystemMessage(input: SystemMessageInput, options?: { collapseRepeats?: boolean }): Promise<SystemMessage>;
    getTask(taskId: string): Promise<{ id: string } | null>;
    appendJournalEntry(taskId: string, content: string, actor?: 'system'): Promise<unknown>;
  },
  event: DamagedImageRepairEvent,
): Promise<void> {
  // A repeat would only bump the open message's count and keep its OLD body,
  // dropping this occurrence's evidence — so a message that carries evidence
  // is filed on its own.
  await storage.createSystemMessage(damagedImageSystemMessage(event), { collapseRepeats: !event.evidence });
  // A repeat adds nothing the task's journal does not already say.
  if (event.taskId && !event.repeat) {
    const task = await storage.getTask(event.taskId);
    if (task) await storage.appendJournalEntry(task.id, damagedImageJournalEntry(event), 'system');
  }
}

/** The doctor result the daemon's sweep reports for recorded damaged images. */
export interface DamagedImageDoctorResult {
  ok: boolean;
  label: string;
  problem?: string;
  detail?: string;
  warning?: string;
  remedy?: string;
}

/** How much of one message the doctor report carries. */
const DOCTOR_DETAIL_MAX = 4000;

/**
 * What god mode's Doctor shows about damaged runner images: the newest open
 * message that carries captured evidence, in full (bounded). One that could
 * not be repaired is a failure (its remedy is Reset Docker storage); one that
 * was repaired is a warning — the machine works, but the evidence of what
 * damaged it is worth reading before the next occurrence.
 */
export function damagedImageDoctorResult(messages: Pick<SystemMessage, 'source' | 'title' | 'body' | 'created_at'>[]): DamagedImageDoctorResult {
  const label = 'No damaged runner images recorded';
  const found = messages
    .filter((m) => m.source === GUEST_DOCKERD_MESSAGE_SOURCE && /damaged runner image/i.test(m.title))
    .sort((a, b) => b.created_at - a.created_at);
  if (found.length === 0) return { ok: true, label };
  const latest = found[0];
  const when = new Date(latest.created_at).toISOString();
  const body = latest.body.length > DOCTOR_DETAIL_MAX ? `${latest.body.slice(0, DOCTOR_DETAIL_MAX)}\n… (cut; the full text is in the system message)` : latest.body;
  const detail = `${found.length} open message(s); the newest, ${when}: ${latest.title}\n\n${body}`;
  if (/could not be repaired/i.test(latest.title)) {
    return {
      ok: false, label, problem: 'A damaged runner image could not be repaired', detail,
      remedy: 'Reset Docker storage from the project\'s page, then rebuild the image.',
    };
  }
  return { ok: true, label: 'Damaged runner images were repaired', warning: detail };
}
