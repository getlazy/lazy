import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../cli/init';

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
}

interface LoggerConfig {
  consoleLevel: LogLevel;
  fileLevel: LogLevel;
  logFile?: string;
}

class Logger {
  private config: LoggerConfig = {
    consoleLevel: LogLevel.INFO,
    fileLevel: LogLevel.DEBUG,
  };

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setVerbose(verbose: boolean): void {
    this.config.consoleLevel = verbose ? LogLevel.DEBUG : LogLevel.INFO;
  }

  setLogFile(logFile: string): void {
    this.config.logFile = logFile;
  }

  private writeToFile(level: string, message: string): void {
    if (this.config.logFile) {
      try {
        const timestamp = new Date().toISOString();
        appendFileSync(this.config.logFile, `${timestamp} [${level}] ${message}\n`);
      } catch {
        // Best effort logging
      }
    }
  }

  debug(message: string): void {
    if (this.config.fileLevel <= LogLevel.DEBUG) {
      this.writeToFile('DEBUG', message);
    }
    if (this.config.consoleLevel <= LogLevel.DEBUG) {
      console.log(message);
    }
  }

  info(message: string): void {
    if (this.config.fileLevel <= LogLevel.INFO) {
      this.writeToFile('INFO', message);
    }
    if (this.config.consoleLevel <= LogLevel.INFO) {
      console.log(message);
    }
  }

  warn(message: string): void {
    if (this.config.fileLevel <= LogLevel.WARN) {
      this.writeToFile('WARN', message);
    }
    if (this.config.consoleLevel <= LogLevel.WARN) {
      console.warn(message);
    }
  }

  error(message: string): void {
    if (this.config.fileLevel <= LogLevel.ERROR) {
      this.writeToFile('ERROR', message);
    }
    if (this.config.consoleLevel <= LogLevel.ERROR) {
      console.error(message);
    }
  }

  // Special method for streaming output (always goes to console in verbose mode)
  stream(message: string): void {
    this.writeToFile('STREAM', message);
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
