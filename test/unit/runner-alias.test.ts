import { describe, test, expect } from 'bun:test';
import {
  resolveRunnerType,
  VALID_RUNNER_TYPES,
  RUNNER_ALIASES,
} from '../../src/config/types';

describe('runner alias resolution', () => {
  // INVARIANT: friendly CLI/MCP aliases map to canonical RunnerType values so a
  // user can type `host`/`docker`/`container`/`podman` without knowing the
  // verbose `dangerously-host-process-without-any-isolation` string.
  test('host alias maps to the verbose host-process runner', () => {
    expect(resolveRunnerType('host')).toBe('dangerously-host-process-without-any-isolation');
  });

  test('docker and container both map to docker', () => {
    expect(resolveRunnerType('docker')).toBe('docker');
    expect(resolveRunnerType('container')).toBe('docker');
  });

  test('podman maps to podman', () => {
    expect(resolveRunnerType('podman')).toBe('podman');
  });

  test('canonical values resolve to themselves', () => {
    for (const t of VALID_RUNNER_TYPES) {
      expect(resolveRunnerType(t)).toBe(t);
    }
  });

  test('case-insensitive and whitespace-tolerant', () => {
    expect(resolveRunnerType('  HOST ')).toBe('dangerously-host-process-without-any-isolation');
    expect(resolveRunnerType('Docker')).toBe('docker');
  });

  test('unknown values return null (caller produces an actionable error)', () => {
    expect(resolveRunnerType('vm')).toBeNull();
    expect(resolveRunnerType('')).toBeNull();
    expect(resolveRunnerType('hostt')).toBeNull();
  });

  test('every alias resolves to a valid runner type', () => {
    for (const [alias, type] of Object.entries(RUNNER_ALIASES)) {
      expect(VALID_RUNNER_TYPES).toContain(type);
      expect(resolveRunnerType(alias)).toBe(type);
    }
  });
});
