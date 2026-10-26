// A narrow engine boundary: sources exist only in guestRoot, independently of
// the host filesystem from which the Docker client was called.
import { mkdir, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';

function fail(message: string, code = 125): never {
  console.error(`docker: ${message}`);
  process.exit(code);
}

// Docker's --mount value is a CSV record, including doubled quotes in fields.
function csv(record: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const char = record[i];
    if (char === '"') {
      if (quoted && record[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += char;
  }
  if (quoted) fail('invalid CSV mount value');
  fields.push(field);
  return fields;
}

const [guestRoot, ...args] = process.argv.slice(2);
if (!guestRoot) fail('fixture requires a guest filesystem');
let source = '';
let target = '';
let readonly = false;
let strict = false;
let entrypoint = '';
let network = '';
let remove = false;
let i = 0;
for (; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--rm') remove = true;
  else if (arg === '--network') network = args[++i]!;
  else if (arg === '--entrypoint') entrypoint = args[++i]!;
  else if (arg === '--mount') {
    strict = true;
    const fields = csv(args[++i]!);
    if (!fields.includes('type=bind')) fail('fixture requires a bind mount');
    source = fields.find((field) => field.startsWith('source='))?.slice(7) ?? '';
    target = fields.find((field) => field.startsWith('target='))?.slice(7) ?? '';
    readonly = fields.includes('readonly');
  } else if (arg === '-v') {
    const fields = args[++i]!.split(':');
    [source, target] = fields as [string, string];
    readonly = fields[2] === 'ro';
  } else break;
}
if (!remove || network !== 'none' || !readonly ||
    target !== '/usr/local/bin/lazy-agent' || entrypoint !== target ||
    args[i] !== 'lazy-runner:test' || args[i + 1] !== 'selfcheck' || i + 2 !== args.length) {
  fail('unexpected selfcheck container arguments');
}
if (!isAbsolute(source) || source.split('/').includes('..')) fail('invalid bind source');
const guestSource = join(guestRoot, source);
const info = await stat(guestSource).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'ENOENT') throw err;
  return null;
});
if (!info && strict) {
  fail(`Error response from daemon: invalid mount config for type "bind": bind source path does not exist in the guest: ${source}`);
}
if (!info) await mkdir(guestSource, { recursive: true }); // Docker -v creates it.
if (!info || info.isDirectory()) fail(`exec: "${target}": is a directory`, 126);

// Execute the guest's stand-in agent, never the host file or a canned sentinel.
const child = Bun.spawn(['sh', guestSource, args[i + 1]!], {
  stdout: 'inherit', stderr: 'inherit',
});
process.exit(await child.exited);
