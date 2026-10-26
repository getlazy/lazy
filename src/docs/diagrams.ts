import { Window } from 'happy-dom';
import { VALID_TRANSITIONS } from '../task-state-machine';

/** The public state diagram is derived from the same transitions the daemon accepts. */
export function taskStateDiagram(): string {
  const lines = ['stateDiagram-v2', '  [*] --> backlog'];
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    for (const to of targets) lines.push(`  ${from} --> ${to}`);
  }
  // The system can recover any unfinished task whose merge already landed.
  for (const status of Object.keys(VALID_TRANSITIONS)) {
    if (status !== 'complete' && status !== 'abandoned' && status !== 'zombie') {
      lines.push(`  ${status} --> zombie`);
    }
  }
  lines.push('  note right of zombie: Recovery only');
  return lines.join('\n');
}

export async function validateDiagram(source: string): Promise<void> {
  if (!globalThis.document) {
    const window = new Window();
    Object.assign(globalThis, { window, document: window.document });
  }
  const { default: mermaid } = await import('mermaid');
  await mermaid.parse(source, { suppressErrors: false });
}
