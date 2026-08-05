/**
 * `lazy daemon logs` command.
 *
 * Tails the daemon log file. Primary debugging tool.
 *
 *   lazy daemon logs                 — tail -f the daemon log (last 50 lines, then follow)
 *   lazy daemon logs -n 100          — show last 100 lines then follow
 *   lazy daemon logs --no-follow     — show recent lines and exit
 *   lazy daemon logs <task>          — filter to lines mentioning this task (by short ID or code)
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { parseFlags, requireLazyRoot } from '../helpers';
import { getLogPath } from '../../daemon/paths';
import { writeStdout } from '../../utils/stdio';
import { isDaemonRunning } from '../../daemon';

export async function commandLogs(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'lines', aliases: ['n'], takesValue: true },
    { name: 'no-follow', takesValue: false },
    { name: 'follow', aliases: ['f'], takesValue: false },
    { name: 'project', takesValue: true },
  ], 'logs');

  const projectRoot = typeof parsed.flags.get('project') === 'string'
    ? parsed.flags.get('project') as string
    : requireLazyRoot();

  const logPath = getLogPath(projectRoot);

  if (!existsSync(logPath)) {
    const running = isDaemonRunning(projectRoot);
    if (!running) {
      console.error('Error: Daemon is not running and no log file found.');
      console.error('Start the daemon with: lazy daemon start');
    } else {
      console.error(`Error: Log file not found: ${logPath}`);
      console.error('The daemon may have just started. Try again in a moment.');
    }
    process.exit(1);
  }

  const numLines = parsed.flags.has('lines')
    ? parseInt(parsed.flags.get('lines') as string, 10)
    : 50;
  const noFollow = parsed.flags.get('no-follow') === true;
  const follow = !noFollow;

  // Task filter: first positional arg is the task identifier.
  // Used as a plain substring match against log lines — works with
  // short IDs (abc12345), task codes (fix-auth), or any string.
  const filterPattern = parsed.positional[0] ?? null;

  // Header so it's obvious what's being tailed.
  console.error(`Tailing lazy daemon log: ${logPath}`);
  if (filterPattern) {
    console.error(`Filter: ${filterPattern}`);
  }
  console.error('---');

  // Read last N lines from the log file
  const lines = tailLines(logPath, numLines);
  const filtered = filterPattern
    ? lines.filter(line => line.includes(filterPattern!))
    : lines;

  // One drained write, not N bare ones: `lazy logs -n 50000 | grep …` exits via
  // process.exit() the moment this returns, and anything still queued in the
  // pipe is discarded (see src/utils/stdio.ts). Batching also avoids N syscalls.
  if (filtered.length > 0) {
    await writeStdout(filtered.join('\n') + '\n');
  }

  if (!follow) return;

  // Follow mode: watch for new data appended to the log file
  await followLog(logPath, filterPattern);
}

/**
 * Read the last N lines from a file efficiently.
 * Reads from the end of the file in chunks to avoid loading the entire file.
 */
function tailLines(filePath: string, n: number): string[] {
  const stat = statSync(filePath);
  if (stat.size === 0) return [];

  const CHUNK_SIZE = 8192;
  const fd = openSync(filePath, 'r');
  const lines: string[] = [];
  let position = stat.size;
  let remainder = '';

  try {
    while (position > 0 && lines.length < n) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, position);

      const chunk = buf.toString('utf-8') + remainder;
      const parts = chunk.split('\n');

      // The first element may be a partial line (split at chunk boundary)
      remainder = parts[0];

      // Add complete lines (from end to start)
      for (let i = parts.length - 1; i >= 1; i--) {
        if (parts[i] !== '') {
          lines.unshift(parts[i]);
        }
        if (lines.length >= n) break;
      }
    }

    // Don't forget the remainder if we've read the entire file
    if (position === 0 && remainder !== '' && lines.length < n) {
      lines.unshift(remainder);
    }
  } finally {
    closeSync(fd);
  }

  return lines.slice(-n);
}

/**
 * Follow a log file, printing new lines as they're appended.
 * Uses polling (500ms) since fs.watch is unreliable for appended files.
 */
async function followLog(filePath: string, filterPattern: string | null): Promise<void> {
  let lastSize = statSync(filePath).size;

  // Handle Ctrl+C gracefully
  const onSignal = () => process.exit(0);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 500));

    let currentSize: number;
    try {
      currentSize = statSync(filePath).size;
    } catch {
      // File may have been rotated — reopen from the beginning
      if (existsSync(filePath)) {
        lastSize = 0;
        continue;
      }
      // File gone — daemon probably stopped
      console.error('\nLog file removed. Daemon may have stopped.');
      process.exit(0);
    }

    if (currentSize === lastSize) continue;

    if (currentSize < lastSize) {
      // File was truncated or rotated — start from beginning
      lastSize = 0;
    }

    // Read new data
    const bytesToRead = currentSize - lastSize;
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, lastSize);
      const newData = buf.toString('utf-8');

      const newLines = newData.split('\n');
      for (const line of newLines) {
        if (line === '') continue;
        if (filterPattern && !line.includes(filterPattern)) continue;
        process.stdout.write(line + '\n');
      }
    } finally {
      closeSync(fd);
    }

    lastSize = currentSize;
  }
}

export function logsUsage(): void {
  console.log(`Usage: lazy daemon logs [options] [<task>]

Tail the daemon log file. Primary debugging tool.

Arguments:
  <task>              Filter log output to lines mentioning this task
                      (by short ID, full ID, or task code)

Options:
  -n, --lines N       Number of lines to show (default: 50)
  -f, --follow        Follow log output (default, can be explicit)
  --no-follow         Show recent lines and exit
  --project PATH      Explicit project root (default: auto-detect)

Examples:
  lazy daemon logs                    # Tail daemon log (last 50 lines + follow)
  lazy daemon logs -n 100             # Show last 100 lines + follow
  lazy daemon logs --no-follow        # Show last 50 lines and exit
  lazy daemon logs abc12345           # Filter to task abc12345
  lazy daemon logs fix-auth           # Filter to task code fix-auth
  lazy daemon logs -n 200 abc12345    # Last 200 lines for task abc12345`);
}
