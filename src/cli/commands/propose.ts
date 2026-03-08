import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { requireLazyRoot, requireStorage, shortId, displayIdFor, parseFlags, resolveTaskOrExit } from '../helpers';
import { theme } from '../theme';
import type { Storage } from '../../storage/interface';

export interface Proposal {
  id: string;
  goal: string;
  code: string;
  prompt: string;
  created_at: number;
  source_turn: number | null;
  status: 'pending' | 'accepted' | 'dismissed';
}

/**
 * Get the proposals directory for a task using the storage driver.
 * This ensures proposals follow the configured storage backend.
 */
function proposalsDirFromStorage(storage: Storage, taskId: string): string {
  return join(storage.getTaskDir(taskId), 'proposals');
}

/**
 * Read all proposals for a task.
 */
export function readProposals(storage: Storage, taskId: string): Proposal[] {
  const dir = proposalsDirFromStorage(storage, taskId);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const proposals: Proposal[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      proposals.push(JSON.parse(content));
    } catch {
      // Skip malformed files
    }
  }

  // Migrate legacy string timestamps to numbers
  for (const p of proposals) {
    if (typeof (p as any).created_at === 'string') {
      const str = (p as any).created_at as string;
      const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(' ', 'T') + 'Z' : str;
      p.created_at = new Date(normalized).getTime() || Date.now();
    }
  }

  // Sort by creation time
  proposals.sort((a, b) => a.created_at - b.created_at);
  return proposals;
}

/**
 * Read only pending proposals for a task.
 */
export function readPendingProposals(storage: Storage, taskId: string): Proposal[] {
  return readProposals(storage, taskId).filter(p => p.status === 'pending');
}

/**
 * Update a proposal's status (accept or dismiss).
 */
export function updateProposalStatus(storage: Storage, taskId: string, proposalId: string, status: 'accepted' | 'dismissed'): void {
  const dir = proposalsDirFromStorage(storage, taskId);
  const filePath = join(dir, `${proposalId}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const proposal: Proposal = JSON.parse(content);
  proposal.status = status;
  writeFileSync(filePath, JSON.stringify(proposal, null, 2) + '\n');
}

export async function commandPropose(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'task', takesValue: true },
  ], 'propose');

  const goalValue = parsed.flags.get('goal') as string | undefined;
  if (!goalValue) {
    console.error('--goal is required');
    proposeUsage();
    process.exit(1);
  }

  const codeValue = parsed.flags.get('code') as string | undefined;
  const promptValue = parsed.flags.get('prompt') as string | undefined;

  // Determine task ID - either from --task flag or by finding it from context
  let taskId: string | undefined;
  const taskFlag = parsed.flags.get('task') as string | undefined;

  const storage = await requireStorage();
  try {
    if (taskFlag) {
      // Explicit --task flag: resolve to full UUID
      const task = await resolveTaskOrExit(storage, taskFlag);
      taskId = task.id;
    } else {
      // Try to infer task ID from environment or protocol directory
      // Inside a container, the protocol dir path contains the task UUID:
      // ~/.lazy/protocol/{task-uuid}/
      const protocolDir = process.argv.find((_, i, arr) => arr[i - 1] === '--protocol-dir');
      if (protocolDir) {
        const match = protocolDir.match(/(?:tasks|protocol)\/([a-f0-9-]{36})/);
        if (match) {
          taskId = match[1];
        }
      }

      if (!taskId) {
        console.error('Cannot determine task ID. Use --task <task_id> to specify the task.');
        process.exit(1);
      }
    }

    // Create proposals directory using storage driver path
    const dir = proposalsDirFromStorage(storage, taskId);
    mkdirSync(dir, { recursive: true });

    // Build proposal
    const proposal: Proposal = {
      id: randomUUID(),
      goal: goalValue,
      code: codeValue ?? '',
      prompt: promptValue ?? '',
      created_at: Date.now(),
      source_turn: null,
      status: 'pending',
    };

    // Write proposal file
    const filePath = join(dir, `${proposal.id}.json`);
    writeFileSync(filePath, JSON.stringify(proposal, null, 2) + '\n');

    console.log(`Proposed follow-up task for ${await displayIdFor(storage, taskId)}`);
    console.log(`  Goal: ${proposal.goal}`);
    if (proposal.code) {
      console.log(`  Code: ${proposal.code}`);
    }
    console.log(`  Proposal ID: ${shortId(proposal.id)}`);
  } finally {
    await storage.close();
  }
}

export function proposeUsage(): void {
  console.log(`Usage: lazy propose --goal "..." [--code <code>] [--prompt "..."] [--task <task_id>]

Propose a follow-up task. Agents use this to suggest work that's out of scope
for the current task but should be done later.

Required:
  --goal "..."       Short description of the proposed task

Options:
  --code <code>      Suggested task code (kebab-case identifier)
  --prompt "..."     Detailed description/instructions for the proposed task
  --task <task_id>   Task to attach this proposal to (auto-detected in containers)

Proposals are NOT tasks — they're suggestions that the human can accept or dismiss
during task review. Accepted proposals become real tasks.

Examples:
  lazy propose --goal "Add input validation to API endpoints" --code add-validation
  lazy propose --goal "Refactor auth module" --prompt "The auth module has grown too large..."
  lazy propose --goal "Fix edge case in parser" --task abc12345`);
}
