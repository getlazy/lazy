import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { requireLazyRoot, requireStorage, displayId, displayIdFor, parseFlags, validateModel, validateCode, MAX_TASK_CODE_LENGTH } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { loadConfig } from '../../config/loader';


import documentConstraints from '../../prompts/document-constraints.md' with { type: 'text' };

const TERMINAL_STATUSES = ['complete', 'abandoned', 'closed'];

/**
 * Resolve the documents directory path.
 *
 * Priority:
 * 1. Explicit config in lazy.toml ([documents] path = "...")
 * 2. Auto-discover existing directories: docs/, doc/
 * 3. Default to "docs/"
 *
 * If the directory doesn't exist, creates it.
 * If no config was set, appends a [documents] section to lazy.toml.
 */
async function resolveDocsPath(root: string): Promise<string> {
  const config = await loadConfig(root);
  const configuredPath = config.documents.path;

  let docsPath: string;
  let wasConfigured = false;

  if (configuredPath) {
    // Explicitly configured
    docsPath = configuredPath;
    wasConfigured = true;
  } else {
    // Auto-discover
    const candidates = ['docs', 'doc'];
    const found = candidates.find(dir => existsSync(join(root, dir)));
    docsPath = found ?? 'docs';
  }

  // Ensure the directory exists
  const fullPath = join(root, docsPath);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
    console.log(`Created documents directory: ${docsPath}/`);
  }

  // Persist to config if not already configured
  if (!wasConfigured) {
    const configPath = join(root, 'lazy.toml');
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      if (!content.includes('[documents]')) {
        appendFileSync(configPath, `\n[documents]\n# Directory for design documents (relative to repo root)\npath = "${docsPath}"\n`);
        console.log(`Added [documents] section to lazy.toml`);
      }
    }
  }

  return docsPath;
}

export async function commandDocument(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'goal', takesValue: true },
    { name: 'prompt', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'code', takesValue: true },
    { name: 'parent', takesValue: true },
  ], 'document');

  let goal: string;
  let prompt: string | null = null;
  let model: string | null = null;
  let code: string | undefined;
  let promptRecoveryPath: string | null = null;
  let parentTaskId: string | undefined;

  // Parse --model flag
  const modelValue = parsed.flags.get('model') as string | undefined;
  if (modelValue !== undefined) {
    model = validateModel(modelValue);
  }

  // Parse --code flag
  const codeValue = parsed.flags.get('code') as string | undefined;
  if (codeValue !== undefined) {
    const codeError = validateCode(codeValue);
    if (codeError) {
      console.error(`Invalid code '${codeValue}': ${codeError}`);
      process.exit(1);
    }
    code = codeValue;
  }

  // Flag mode: both goal and optionally prompt provided
  const goalValue = parsed.flags.get('goal') as string | undefined;
  const promptValue = parsed.flags.get('prompt') as string | undefined;
  const parentValue = parsed.flags.get('parent') as string | undefined;

  if (goalValue !== undefined) {
    goal = goalValue;

    if (promptValue !== undefined) {
      prompt = promptValue;
    } else {
      // Try piped stdin as prompt
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        prompt = stdinContent;
      }
    }
  } else {
    // Interactive mode
    if (!process.stdin.isTTY) {
      console.error('Interactive mode requires a TTY. Use --goal and --prompt flags instead.');
      process.exit(1);
    }

    const { promptLine } = await import('../editor');
    const goalInput = await promptLine('Documentation goal');
    if (!goalInput.trim()) {
      console.error('Goal cannot be empty');
      process.exit(1);
    }
    goal = goalInput;

    // Open editor for prompt
    console.log('\nOpening editor for prompt (close without saving to skip)...');
    const editResult = await openEditor('', `document-prompt`);
    if (editResult !== null && editResult.content.trim()) {
      prompt = editResult.content.trim();
      promptRecoveryPath = editResult.recoveryPath;
    } else if (editResult !== null && editResult.recoveryPath) {
      removeRecoveryFile(editResult.recoveryPath);
    }
  }

  // Resolve docs path before creating the task (this may modify lazy.toml)
  const root = requireLazyRoot();
  const docsPath = await resolveDocsPath(root);

  // Build the full prompt: user prompt + document constraints
  const constraints = documentConstraints.replace(/\{\{docsPath\}\}/g, docsPath);
  const fullPrompt = prompt
    ? `${prompt}\n\n---\n\n${constraints}`
    : constraints;

  const storage = await requireStorage();
  try {
    // Resolve and validate parent if provided
    if (parentValue !== undefined) {
      const { resolveTaskOrExit } = await import('../helpers');
      const parentTask = await resolveTaskOrExit(storage, parentValue);
      if (TERMINAL_STATUSES.includes(parentTask.status)) {
        console.error(`Cannot use task ${displayId(parentTask)} as parent: task is ${parentTask.status}`);
        process.exit(1);
      }
      parentTaskId = parentTask.id;
    }

    const t = await storage.createTask(goal, parentTaskId, undefined, code, 'document');
    console.log(`Created task ${displayId(t)}`);
    console.log(`  Goal:   ${t.goal}`);
    console.log(`  Status: ${t.status}`);
    console.log(`  ID:     ${t.id}`);
    console.log(`  Type:   document`);
    if (t.code) {
      console.log(`  Code:   ${t.code}`);
    }
    if (t.parent_task_id) {
      console.log(`  Parent: ${await displayIdFor(storage, t.parent_task_id)}`);
    }
    console.log(`  Docs:   ${docsPath}/`);

    // Add the full prompt (user prompt + constraints)
    const version = await storage.updateTaskPrompt(t.id, fullPrompt);
    if (promptRecoveryPath) removeRecoveryFile(promptRecoveryPath);
    console.log(`  Prompt: v${version.version} (${fullPrompt.length} chars)`);

    // Set model if provided
    if (model) {
      await storage.updateTaskModel(t.id, model);
      console.log(`  Model:  ${model}`);
    }

    console.log(`\nStart working on it with: lazy start ${displayId(t)}`);
  } finally {
    await storage.close();
  }
}

export function documentUsage(): void {
  console.log(`Usage: lazy document [--goal <goal>] [--prompt <text>] [--model <model>] [--code <code>] [--parent <task_id>]

Create a documentation task. The agent reads code and produces design documents
in markdown with mermaid diagrams. It does NOT modify code files.

Options:
  --goal <goal>      Documentation goal (what to document)
  --prompt <text>    Additional instructions for the documentation agent
  --model <model>    Set model for this task (raw model ID, e.g. claude-sonnet-4-5-20250929)
  --code <code>      Human-readable code (e.g. "doc-storage", "doc-architecture")
                     Lowercase alphanumeric + hyphens, 2-${MAX_TASK_CODE_LENGTH} chars
  --parent <task_id> Parent task ID (creates a child task)

The documents directory is configured in lazy.toml under [documents].path.
If not configured, auto-discovers docs/ or doc/, defaulting to docs/.

Prompt input priority: --prompt flag > piped stdin > $EDITOR (interactive)

Examples:
  lazy document --goal "Document the storage interface" --code doc-storage
  lazy document --goal "Update architecture overview" --code doc-architecture
  lazy document --goal "Document the supervisor protocol" --prompt "Focus on the lifecycle"
  lazy document                              # Interactive mode
  echo "Extra instructions" | lazy document --goal "Document auth flow"`);
}
