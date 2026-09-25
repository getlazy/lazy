/**
 * Parse the Rails-side authorization tables for the Teams CLI proxy route, so
 * a lazy-side test (or test stub) can check itself against the SAME list the
 * real route enforces — without a Ruby runtime.
 *
 * Why this exists: the bound-clone e2e stub used to answer `getStoragePath`
 * from a hand-written Bun `if` that never consulted any policy table. The
 * Rails suite had no `getStoragePath` case. The two halves could not
 * disagree, so a storage method the Rails route refuses (a 404 every
 * store-backed CLI command dies on at boot) shipped green. Reading the actual
 * Ruby tables at test time makes the stub refuse what the real route refuses
 * and admit what it admits; a unit test (`cli-storage-policy-parity.test.ts`)
 * cross-checks the CLI's own storage calls against the same tables.
 *
 * Both tables are refuse-by-default, so a broken parse must FAIL LOUDLY, not
 * silently admit everything. The anchors below are methods/commands the
 * tables have contained since they were written; if one goes missing the
 * parse has gone stale and the parser must be updated consciously.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export interface RailsPolicyTables {
  /** Every storage method StorageMethodPolicy admits (READ_METHODS + WRITE_METHODS keys). */
  storageMethods: Set<string>;
  /** Every top-level command CliRpcCommand maps (`storage` itself is handled before lookup). */
  cliCommands: Set<string>;
  /**
   * For each mapped command, the request-body keys the Rails route reads the
   * task id and the human's words out of — `Mapping.new(verb, kind,
   * task_id_param, message_param)`, `null` where the mapping names none.
   *
   * These are wire contracts, not labels: the route writes the `TaskAction`
   * row BEFORE relaying, and a `message_param` naming a key the body does not
   * carry saves a row with no message — the human's words gone on a refusal,
   * which is the one thing that row exists to prevent.
   */
  commandParams: Map<string, { taskActionKind: string | null; taskIdParam: string | null; messageParam: string | null }>;
  /**
   * `CliRpcCommand::BODY_KEYS` — the request-body keys each command may
   * carry through the proxy; any other key is refused.
   */
  bodyKeys: Map<string, Set<string>>;
  /**
   * The same wire contract for the `storage` route: method → the `args` key
   * `StorageMethodPolicy` reads the human's words out of (`Result.new(verb,
   * kind, message_arg)`), `null` where the method settles no row.
   */
  storageMessageArgs: Map<string, string | null>;
  /**
   * The task metadata keys `storage:updateTaskMetadata` admits
   * (`StorageMethodPolicy::METADATA_KEYS`) — the route checks the KEY, not
   * just the method, because the daemon reads several keys to decide things.
   */
  metadataKeys: Set<string>;
}

function readRailsModel(modelFile: string): string {
  const path = join(import.meta.dir, '..', '..', 'lazy-teams', 'app', 'models', modelFile);
  const raw = readFileSync(path, 'utf8');
  // Comment lines mention method names in prose; strip them so prose can
  // never add a name to a table it is only describing.
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function parseStorageMethods(source: string): Set<string> {
  const methods = new Set<string>();
  const readBlock = source.match(/READ_METHODS = %w\[([\s\S]*?)\]/);
  if (!readBlock) {
    throw new Error("rails policy parse: no 'READ_METHODS = %w[...]' block in storage_method_policy.rb");
  }
  for (const name of readBlock[1].split(/\s+/)) {
    if (name) methods.add(name);
  }
  for (const match of source.matchAll(/"([A-Za-z]+)"\s*=>\s*Result\.new/g)) {
    methods.add(match[1]);
  }
  return methods;
}

function parseCliCommands(source: string): Set<string> {
  const commands = new Set<string>();
  for (const match of source.matchAll(/"([A-Za-z]+)"\s*=>\s*Mapping\.new/g)) {
    commands.add(match[1]);
  }
  return commands;
}

/** `"method" => Result.new(:verb, :kind, "content")` — the third arg. */
function parseStorageMessageArgs(source: string): Map<string, string | null> {
  const args = new Map<string, string | null>();
  const pattern = /"([A-Za-z]+)"\s*=>\s*Result\.new\(\s*[^,]+,\s*[^,]+,\s*(?:nil|"([A-Za-z]+)")\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    args.set(match[1], match[2] ?? null);
  }
  return args;
}

/** `"cmd" => Mapping.new(:verb, :kind, "taskId", "message")` — the last three args. */
function parseCommandParams(source: string): RailsPolicyTables['commandParams'] {
  const params: RailsPolicyTables['commandParams'] = new Map();
  const arg = /(?:nil|"([A-Za-z]+)")/.source;
  const kind = /(?:nil|:([a-z_]+))/.source;
  const pattern = new RegExp(`"([A-Za-z]+)"\\s*=>\\s*Mapping\\.new\\(\\s*[^,]+,\\s*${kind},\\s*${arg},\\s*${arg}\\s*\\)`, 'g');
  for (const match of source.matchAll(pattern)) {
    params.set(match[1], { taskActionKind: match[2] ?? null, taskIdParam: match[3] ?? null, messageParam: match[4] ?? null });
  }
  return params;
}

/** `BODY_KEYS = { "cmd" => %w[a b], … }`. */
function parseBodyKeys(source: string): Map<string, Set<string>> {
  const block = source.match(/BODY_KEYS = \{([\s\S]*?)\n  \}/);
  if (!block) throw new Error("rails policy parse: no 'BODY_KEYS = { … }' block in cli_rpc_command.rb");
  const keys = new Map<string, Set<string>>();
  for (const match of block[1].matchAll(/"([A-Za-z.]+)"\s*=>\s*%w\[([^\]]*)\]/g)) {
    keys.set(match[1], new Set(match[2].split(/\s+/).filter(Boolean)));
  }
  return keys;
}

function parseMetadataKeys(source: string): Set<string> {
  const block = source.match(/METADATA_KEYS = %w\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error("rails policy parse: no 'METADATA_KEYS = %w[...]' block in storage_method_policy.rb");
  }
  return new Set(block[1].split(/\s+/).filter(Boolean));
}

let cached: RailsPolicyTables | undefined;

/**
 * Parse both Rails tables. Anchored: a parse that cannot find known-good
 * names throws instead of returning an empty (admit-nothing) or silently
 * wrong (admit-everything) set.
 */
export function loadRailsPolicyTables(): RailsPolicyTables {
  if (cached) return cached;

  const storageSource = readRailsModel('storage_method_policy.rb');
  const storage = parseStorageMethods(storageSource);
  const storageMessageArgs = parseStorageMessageArgs(storageSource);
  const metadataKeys = parseMetadataKeys(storageSource);
  const commandSource = readRailsModel('cli_rpc_command.rb');
  const commands = parseCliCommands(commandSource);
  const commandParams = parseCommandParams(commandSource);
  const bodyKeys = parseBodyKeys(commandSource);

  const missingStorage = [ 'getTask', 'createTask', 'getProjectSettings' ].filter((m) => !storage.has(m));
  if (missingStorage.length > 0) {
    throw new Error(`rails policy parse: storage table is missing known methods: ${missingStorage.join(', ')} — the parser is stale`);
  }
  const missingCommands = [ 'list', 'show', 'identity', 'acceptTask' ].filter((c) => !commands.has(c));
  if (missingCommands.length > 0) {
    throw new Error(`rails policy parse: command table is missing known commands: ${missingCommands.join(', ')} — the parser is stale`);
  }

  // Same anti-vacuity shape as above, for the params half: these four have
  // carried a message param since the table was written, and a parse that
  // found none would make the wire-contract check below pass by having
  // nothing to check.
  const missingParams = [ 'unblockTask', 'askTask', 'rejectTask', 'closeTask' ]
    .filter((c) => !commandParams.get(c)?.messageParam);
  if (missingParams.length > 0) {
    throw new Error(`rails policy parse: no message param parsed for ${missingParams.join(', ')} — the parser is stale`);
  }
  const missingStorageArgs = [ 'createTask', 'createComment' ].filter((m) => !storageMessageArgs.get(m));
  if (missingStorageArgs.length > 0) {
    throw new Error(`rails policy parse: no message arg parsed for storage ${missingStorageArgs.join(', ')} — the parser is stale`);
  }

  if (!metadataKeys.has('effort')) {
    throw new Error("rails policy parse: METADATA_KEYS is missing 'effort' — the parser is stale");
  }

  if (!bodyKeys.get('acceptTask')?.has('taskId') || !bodyKeys.has('storage')) {
    throw new Error('rails policy parse: BODY_KEYS is missing acceptTask/storage — the parser is stale');
  }
  if (commandParams.get('unblockTask')?.taskActionKind !== 'unblock') {
    throw new Error('rails policy parse: no task_action_kind parsed for unblockTask — the parser is stale');
  }

  cached = { storageMethods: storage, cliCommands: commands, commandParams, storageMessageArgs, metadataKeys, bodyKeys };
  return cached;
}