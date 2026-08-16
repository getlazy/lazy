import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../cli/init';
import { redactSecretValues } from './redact';

/**
 * Logger module for lazy CLI
 *
 * LOGGING PATTERN:
 *
 * Use logger.* methods (info, error, warn, debug) for all output AFTER logger is initialized.
 * These methods write to both console and log file (when configured).
 *
 * Use console.* methods ONLY in these cases:
 * 1. Before logger is initialized (e.g., early startup, config loading, init command)
 * 2. Explicit debug output when debug=true (use console.log with '[DEBUG]' prefix)
 * 3. User-facing help/usage messages (console.log for help text)
 * 4. Final formatted output (console.log for tables, summaries, etc.)
 *
 * AVOID duplicating messages:
 * - Don't call both console.* and logger.* for the same message
 * - If a function uses logger.*, don't also log in the caller
 * - Example: runClaude() logs "Running Claude Code...", so callers should NOT log it again
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  /** Suppress all console output. File writes still occur at fileLevel. */
  SILENT = 4,
}

interface LoggerConfig {
  consoleLevel: LogLevel;
  fileLevel: LogLevel;
  logFile?: string;
}

interface RotationConfig {
  /** Maximum log file size in bytes before rotation (default: 10MB) */
  maxBytes: number;
  /** Number of rotated files to keep (default: 3) */
  maxFiles: number;
}

class Logger {
  private config: LoggerConfig = {
    consoleLevel: LogLevel.INFO,
    fileLevel: LogLevel.DEBUG,
  };

  private rotation: RotationConfig | null = null;

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setVerbose(verbose: boolean): void {
    this.config.consoleLevel = verbose ? LogLevel.DEBUG : LogLevel.INFO;
  }

  setLogFile(logFile: string): void {
    this.config.logFile = logFile;
  }

  /**
   * Enable log rotation for the configured logFile.
   * Rotation is checked explicitly via checkRotation(), not on every write.
   */
  enableRotation(maxBytes: number = 10 * 1024 * 1024, maxFiles: number = 3): void {
    this.rotation = { maxBytes, maxFiles };
  }

  /**
   * Check if the log file needs rotation and rotate if so.
   * Call this periodically (e.g., at the start of each reconcile tick)
   * rather than on every write to avoid stat() overhead.
   */
  checkRotation(): void {
    if (!this.rotation || !this.config.logFile) return;

    try {
      const stats = statSync(this.config.logFile);
      if (stats.size >= this.rotation.maxBytes) {
        this.rotateFiles();
      }
    } catch {
      // File doesn't exist or can't be stat'd — nothing to rotate
    }
  }

  /**
   * Rotate log files: daemon.log → daemon.log.1 → daemon.log.2 → ...
   * The oldest file beyond maxFiles is deleted.
   * Safe for appendFileSync-based writes: each write reopens the file,
   * so renaming the current file and creating a new one is atomic.
   */
  private rotateFiles(): void {
    if (!this.rotation || !this.config.logFile) return;

    const logFile = this.config.logFile;
    const { maxFiles } = this.rotation;

    try {
      // Delete the oldest rotated file if it exists
      const oldest = `${logFile}.${maxFiles}`;
      try { unlinkSync(oldest); } catch { /* doesn't exist */ }

      // Shift rotated files: .2 → .3, .1 → .2, etc.
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = `${logFile}.${i}`;
        const to = `${logFile}.${i + 1}`;
        try { renameSync(from, to); } catch { /* doesn't exist */ }
      }

      // Rotate current log file to .1
      try { renameSync(logFile, `${logFile}.1`); } catch { /* doesn't exist */ }

      // Next appendFileSync call will create a fresh logFile
      appendFileSync(logFile, `${new Date().toISOString()} [INFO ] : Log rotated\n`);
    } catch {
      // Rotation failed — continue writing to existing file
    }
  }

  /**
   * Last line of defence against a credential reaching the console or a log
   * file. Every level goes through this, so no call site has to remember: a
   * live CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY value embedded in a
   * message becomes `<redacted>` on the way out, whatever assembled the string.
   * Redaction is by known env KEY names, not by guessing which values look
   * secret — see src/utils/redact.ts.
   */
  private scrub(message: string): string {
    return redactSecretValues(message);
  }

  private writeToFile(level: string, message: string): void {
    if (this.config.logFile) {
      try {
        const timestamp = new Date().toISOString();
        appendFileSync(this.config.logFile, `${timestamp} [${level.padEnd(5)}] : ${message}\n`);
      } catch {
        // Best effort logging
      }
    }
  }

  debug(rawMessage: string): void {
    const message = this.scrub(rawMessage);
    if (this.config.fileLevel <= LogLevel.DEBUG) {
      this.writeToFile('DEBUG', message);
    }
    if (this.config.consoleLevel <= LogLevel.DEBUG) {
      console.log(message);
    }
  }

  info(rawMessage: string): void {
    const message = this.scrub(rawMessage);
    if (this.config.fileLevel <= LogLevel.INFO) {
      this.writeToFile('INFO', message);
    }
    if (this.config.consoleLevel <= LogLevel.INFO) {
      console.log(message);
    }
  }

  warn(rawMessage: string): void {
    const message = this.scrub(rawMessage);
    if (this.config.fileLevel <= LogLevel.WARN) {
      this.writeToFile('WARN', message);
    }
    if (this.config.consoleLevel <= LogLevel.WARN) {
      console.warn(message);
    }
  }

  error(rawMessage: string): void {
    const message = this.scrub(rawMessage);
    if (this.config.fileLevel <= LogLevel.ERROR) {
      this.writeToFile('ERROR', message);
    }
    if (this.config.consoleLevel <= LogLevel.ERROR) {
      console.error(message);
    }
  }

  // Special method for streaming output (always goes to console in verbose mode)
  stream(message: string): void {
    this.writeToFile('STREAM', this.scrub(message));
    // Don't echo to console - this is for captured streams
  }
}

export const logger = new Logger();

export function createLogFile(lazyRoot: string, sessionId: string): string {
  const logsDir = join(lazyRoot, getDataDir(lazyRoot), 'logs');
  mkdirSync(logsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const logFile = join(logsDir, `session-${sessionId}-${timestamp}.log`);

  appendFileSync(logFile, `=== Session log started ===\n`);
  return logFile;
}
