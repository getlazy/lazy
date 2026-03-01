/**
 * Custom assertion helpers for e2e tests
 */

import { expect } from 'bun:test';
import type { WorkResult } from './setup';

/** Assert command succeeded (exit code 0) */
export function expectSuccess(result: WorkResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `Expected exit code 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
}

/** Assert command failed (exit code != 0) */
export function expectFailure(result: WorkResult, expectedExitCode: number = 1): void {
  expect(result.exitCode).toBe(expectedExitCode);
}

/** Assert stdout contains a substring */
export function expectOutput(result: WorkResult, substring: string): void {
  if (!result.stdout.includes(substring)) {
    throw new Error(
      `Expected stdout to contain "${substring}"\nActual stdout: ${result.stdout}`
    );
  }
}

/** Assert stderr contains a substring */
export function expectError(result: WorkResult, substring: string): void {
  if (!result.stderr.includes(substring)) {
    throw new Error(
      `Expected stderr to contain "${substring}"\nActual stderr: ${result.stderr}`
    );
  }
}

/** Assert stdout does NOT contain a substring */
export function expectOutputExcludes(result: WorkResult, substring: string): void {
  if (result.stdout.includes(substring)) {
    throw new Error(
      `Expected stdout NOT to contain "${substring}"\nActual stdout: ${result.stdout}`
    );
  }
}

/** Extract a task short ID (8-char hex) from CLI output */
export function extractTaskId(output: string): string {
  // Try old format first: "Created task <shortId>"
  let match = output.match(/(?:Created task|Linked task|Task) ([a-f0-9]{8})/);
  if (match) {
    return match[1];
  }

  // Try new format: "ID:     <uuid>"
  match = output.match(/ID:\s+([a-f0-9-]{36})/);
  if (match) {
    // Extract just the first 8 characters (short ID)
    return match[1].substring(0, 8);
  }

  throw new Error(`Could not extract task ID from output: ${output}`);
}
