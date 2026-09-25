/**
 * CLI helper functions.
 *
 * Everything here is specific to being a one-shot command-line program: flag
 * parsing, interactive disambiguation, and the wrappers that turn a
 * precondition failure into stderr + exit(1). Anything a server could also want
 * lives outside `src/cli/` — task identity in `src/task/identity.ts`, value
 * formatting in `src/utils/format.ts`, the throwing precondition core in
 * `src/preconditions.ts`.
 */

import type { Storage } from '../storage';
import { checkPairingLock } from '../utils/pairing-lock';
import { isTTY, promptChoice } from './editor';
import { loadConfig } from '../config/loader';
import { agentProfileOrThrow, agentProfilesFor } from '../config/agent-profiles';
import { LazyPreconditionError, resolveLazyRoot, resolveStorage } from '../preconditions';
import { getWorktreePathForRef, shortId } from '../task/identity';
import { formatDate } from '../utils/format';
import { findGitRoot } from '../project-paths';
import { readTeamsLogin, MultipleTeamsLoginsError } from '../teams/login';

/**
 * Get the lazy root directory or exit with an error.
 *
 * CLI-only: exiting is correct for a one-shot command and wrong everywhere else.
 * In a server, use `resolveLazyRoot()`.
 */
export function requireLazyRoot(): string {
  try {
    return resolveLazyRoot();
  } catch (err) {
    if (err instanceof LazyPreconditionError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Create and initialize storage, or exit with an error.
 *
 * CLI-only wrapper around `resolveStorage()` — see `requireLazyRoot()`.
 *
 * The bound-clone announcement (design doc §4.7) is NOT here: it used to be,
 * but this is not where every remote-routed command actually goes — several
 * read commands (`list`, `blocked`, `active`, …) call
 * `src/daemon/rpc-fallback.ts`'s typed wrappers straight over `tryRpc`
 * instead and never touched it. It is printed once, centrally, in the
 * dispatcher (`src/index.ts`'s `resolveCloneBinding` call site), which every
 * command passes through regardless of which path it takes to the daemon.
 */
export async function requireStorage(): Promise<Storage> {
  try {
    return await resolveStorage();
  } catch (err) {
    if (err instanceof LazyPreconditionError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Refuse a command that operates the LOCAL machine — a daemon, the local
 * dashboard, `lazy init` — when this clone is bound to a Teams install
 * (design doc §4.4, §4.7). A bound clone has no local daemon and no local
 * store to operate; naming the refusal explicitly, with `lazy logout` as the
 * way back, is what the design calls for instead of the command failing
 * obscurely against infrastructure that was never there.
 *
 * Anchored at the GIT root, like `lazy login` itself — these are exactly the
 * commands a clone may need to run BEFORE `lazy init`, so `resolveLazyRoot()`
 * (which requires an initialized project) would be the wrong anchor here.
 */
export async function refuseIfBoundClone(commandName: string, cwd: string = process.cwd()): Promise<void> {
  const root = findGitRoot(cwd);
  if (!root) return;

  let login;
  try {
    login = await readTeamsLogin(root);
  } catch (err) {
    // A clone holding two Teams logins is unambiguously "some kind of bound"
    // — refuse by name, exactly as a clean single binding does, so the
    // documented recovery (`lazy logout`) is what a human reaches for. Any
    // OTHER read failure (a corrupted credential index, which breaks every
    // credential it holds, Teams or not) answers a different question than
    // "is this clone bound", and this local-machine command must not crash
    // on it — that would take down `lazy doctor`'s own diagnosis of exactly
    // that corruption, for one.
    if (!(err instanceof MultipleTeamsLoginsError)) return;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (!login) return;

  console.error(
    `Error: this clone is bound to ${login.binding.teams_url} (${login.binding.project}).\n` +
    `\`lazy ${commandName}\` operates this machine, and a bound clone has no local daemon or ` +
    'store to operate — the daemon is Teams\' own.\n' +
    'Run `lazy logout` first if you want to work on this project locally instead.',
  );
  process.exit(1);
}

/**
 * Flag validation result
 */
export interface ParsedFlags {
  /** Positional arguments (non-flag args) */
  positional: string[];
  /** Flag values: map of flag name to value (or true for boolean flags, or string[] for accumulate flags) */
  flags: Map<string, string | boolean | string[]>;
}

/**
 * Flag definition for command argument parsing
 */
export interface FlagDefinition {
  /** Flag name (e.g., 'goal', 'model') */
  name: string;
  /** Alternative names/aliases (e.g., ['f'] for 'fuzzy') */
  aliases?: string[];
  /** Whether this flag takes a value (false = boolean flag) */
  takesValue: boolean;
  /**
   * When true, the flag's value is optional. If the next argument looks like
   * another flag (starts with '-') or is absent, the flag is set to `true`
   * (bare usage). Otherwise the next argument is consumed as its value.
   * Only meaningful when `takesValue` is true.
   */
  optionalValue?: boolean;
  /**
   * When true, repeated occurrences of this flag accumulate into a string[].
   * e.g., --approve-file a.ts --approve-file b.ts → ['a.ts', 'b.ts']
   * Only meaningful when `takesValue` is true.
   */
  accumulate?: boolean;
}

/**
 * Parse and validate command-line arguments against a set of allowed flags.
 * Returns parsed positional args and flag values.
 * Exits with an error if unknown flags are found.
 *
 * @param args - Raw command arguments (e.g., process.argv.slice(2))
 * @param allowedFlags - Array of flag definitions
 * @param commandName - Name of the command (for error messages)
 * @returns Parsed positional arguments and flag values
 *
 * @example
 * const flags = [
 *   { name: 'goal', takesValue: true },
 *   { name: 'model', takesValue: true },
 *   { name: 'follow', takesValue: false },
 *   { name: 'fuzzy', aliases: ['f'], takesValue: false },
 * ];
 * const parsed = parseFlags(args, flags, 'start');
 * const goal = parsed.flags.get('goal') as string | undefined;
 * const follow = parsed.flags.get('follow') === true;
 */
export function parseFlags(
  args: string[],
  allowedFlags: FlagDefinition[],
  commandName: string
): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();

  // Build lookup maps for fast validation
  const flagMap = new Map<string, FlagDefinition>();
  for (const def of allowedFlags) {
    flagMap.set(`--${def.name}`, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        flagMap.set(`-${alias}`, def);
      }
    }
  }

  // Parse arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Check if it's a flag
    if (arg.startsWith('-')) {
      const def = flagMap.get(arg);

      if (!def) {
        // Unknown flag
        console.error(`Unknown flag: ${arg}. Run \`lazy ${commandName} --help\` for usage.`);
        process.exit(1);
      }

      if (def.takesValue) {
        if (def.optionalValue) {
          // Optional value: consume next arg only if it doesn't look like a flag
          const next = args[i + 1];
          if (next && !next.startsWith('-')) {
            flags.set(def.name, next);
            i += 2;
          } else {
            // Bare usage — set to true (present without value)
            flags.set(def.name, true);
            i += 1;
          }
        } else if (def.accumulate) {
          // Accumulate: repeated flags build a string[]
          if (i + 1 >= args.length) {
            console.error(`${arg} requires a value`);
            process.exit(1);
          }
          const existing = flags.get(def.name);
          if (Array.isArray(existing)) {
            existing.push(args[i + 1]);
          } else {
            flags.set(def.name, [args[i + 1]]);
          }
          i += 2;
        } else {
          // Flag requires a value
          if (i + 1 >= args.length) {
            console.error(`${arg} requires a value`);
            process.exit(1);
          }
          flags.set(def.name, args[i + 1]);
          i += 2;
        }
      } else {
        // Boolean flag
        flags.set(def.name, true);
        i += 1;
      }
    } else {
      // Positional argument
      positional.push(arg);
      i += 1;
    }
  }

  return { positional, flags };
}

/**
 * Resolve a task identifier (hex ID, UUID, or code) to a Task.
 * Exits with an appropriate error message if not found or ambiguous.
 */
export async function resolveTaskOrExit(storage: Storage, input: string): Promise<import('../types').Task> {
  const result = await storage.resolveTask(input);

  if (result.task) {
    return result.task;
  }

  if (result.ambiguousMatches && result.ambiguousMatches.length > 0) {
    // Build formatted options for each task
    const options: string[] = [];
    for (const t of result.ambiguousMatches) {
      // Get the most recent session for this task to determine last interaction
      const session = await storage.getSessionByTaskId(t.id);
      const timestamp = session?.last_interaction_at ?? t.created_at;
      const formattedDate = formatDate(timestamp);

      // Pad status to align columns nicely (longest status is "interrupted" = 11 chars)
      const paddedStatus = t.status.padEnd(12);

      options.push(`${shortId(t.id)}  ${paddedStatus}  ${formattedDate}  ${t.goal}`);
    }

    // In TTY mode, offer interactive choice
    if (isTTY()) {
      const choice = await promptChoice(`Multiple tasks match code '${input}'. Choose one:`, options);
      return result.ambiguousMatches[choice];
    }

    // In non-TTY mode, print error and exit
    console.error(`Multiple tasks match code '${input}'. Use the ID to disambiguate:`);
    for (const option of options) {
      console.error(`  ${option}`);
    }
    process.exit(1);
  }

  console.error(`No task found matching '${input}'`);
  process.exit(1);
}

/**
 * Validate a model name value.
 * Accepts any non-empty string — users pass raw model IDs directly.
 */
export function validateModel(value: string): string {
  if (!value.trim()) {
    console.error('Model name cannot be empty');
    process.exit(1);
  }
  return value;
}

/**
 * Validate an `--agent <profile>` flag against the project's agent profiles,
 * or exit 1 naming the ones that exist.
 *
 * `--agent` names a PROFILE (`[agents.<name>]`), not a harness — the built-in
 * profiles are named after the harnesses, so the flag's old spellings all still
 * resolve, but a project can define `local-ollama-pi` and select it here.
 *
 * The daemon validates again when it launches, and it is the authority (its
 * lazy.toml is the one a turn will actually run under). This check exists so a
 * typo is answered instantly, by the surface the user typed it at, with the
 * project's real list — not after a round trip.
 */
export async function validateAgentProfileOrExit(root: string, value: string): Promise<void> {
  try {
    // agentProfileOrThrow, not profileForAgentName: `--agent ""` must be
    // rejected. Resolving the empty name to the default profile belongs to the
    // paths that read a task's stored agent, not to a user who typed the flag.
    agentProfileOrThrow(agentProfilesFor(await loadConfig(root)), value, '--agent');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Check if a task is locked for pairing and exit with an error if so.
 * Call this in any command that should refuse while pairing is active.
 * @param tRef - The task ref (or shortId for legacy tasks) used as the worktree directory name
 */
export function rejectIfPairing(root: string, tRef: string, displayTaskId: string): void {
  const worktreePath = getWorktreePathForRef(root, tRef);
  const pairingLock = checkPairingLock(worktreePath);
  if (pairingLock) {
    console.error(`Task ${tRef} is locked for pairing (PID ${pairingLock.pid}, started ${pairingLock.started_at}).`);
    console.error(`Exit the pairing session first, or clear the lock with: lazy pair ${displayTaskId} --unlock`);
    process.exit(1);
  }
}

/**
 * Parsed line range for output slicing
 */
export interface LineRange {
  /** Starting line (1-indexed, inclusive). undefined means "from start" */
  start?: number;
  /** Ending line (1-indexed, inclusive). undefined means "to end" */
  end?: number;
}

/**
 * Parse a line range string (e.g., "10..20", "10..", "..20").
 * Returns null if the format is invalid.
 * Line numbers are 1-indexed and inclusive.
 *
 * @param rangeStr - Line range string (e.g., "10..20")
 * @returns Parsed range or null if invalid
 *
 * @example
 * parseLineRange("10..20") => { start: 10, end: 20 }
 * parseLineRange("10..")   => { start: 10, end: undefined }
 * parseLineRange("..20")   => { start: undefined, end: 20 }
 */
export function parseLineRange(rangeStr: string): LineRange | null {
  // Must contain exactly one ".."
  const parts = rangeStr.split('..');
  if (parts.length !== 2) {
    return null;
  }

  const [startStr, endStr] = parts;

  // At least one side must be specified
  if (!startStr && !endStr) {
    return null;
  }

  const range: LineRange = {};

  if (startStr) {
    const start = parseInt(startStr, 10);
    if (isNaN(start) || start < 1) {
      return null;
    }
    range.start = start;
  }

  if (endStr) {
    const end = parseInt(endStr, 10);
    if (isNaN(end) || end < 1) {
      return null;
    }
    range.end = end;
  }

  // If both specified, start must be <= end
  if (range.start !== undefined && range.end !== undefined && range.start > range.end) {
    return null;
  }

  return range;
}

/**
 * Slice output text to a specific line range.
 * Line numbers are 1-indexed and inclusive.
 *
 * @param output - The full output text
 * @param range - The line range to extract
 * @returns The sliced output
 *
 * @example
 * sliceLines("line1\nline2\nline3", { start: 2, end: 3 }) => "line2\nline3"
 * sliceLines("line1\nline2\nline3", { start: 2 }) => "line2\nline3"
 * sliceLines("line1\nline2\nline3", { end: 2 }) => "line1\nline2"
 */
export function sliceLines(output: string, range: LineRange): string {
  const lines = output.split('\n');

  // Convert 1-indexed to 0-indexed for array slicing
  const startIdx = range.start !== undefined ? range.start - 1 : 0;
  const endIdx = range.end !== undefined ? range.end : lines.length;

  // Clamp to valid bounds
  const clampedStart = Math.max(0, Math.min(startIdx, lines.length));
  const clampedEnd = Math.max(0, Math.min(endIdx, lines.length));

  return lines.slice(clampedStart, clampedEnd).join('\n');
}
