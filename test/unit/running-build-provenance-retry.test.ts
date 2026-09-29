import { afterEach, describe, expect, test } from 'bun:test';
import {
  daemonStatusBuild,
  readEmbeddedBuildProvenance,
  readRunningBuildProvenance,
  resetRunningBuildProvenanceCache,
} from '../../src/utils/build-provenance';

const STAMPED = { buildBranch: 'lazy/x', buildSha: '16e8b4bec', buildDirty: false, buildSourcePath: '/src' };
const CHECKOUT = { buildBranch: 'main', buildSha: 'abc1234', buildDirty: true, buildSourcePath: '/co' };

describe('running build provenance', () => {
  afterEach(() => resetRunningBuildProvenanceCache());

  // INVARIANT: a failed load of the embedded build-info module never yields a
  // null identity when the checkout can answer. The old `null?.buildSha !==
  // 'dev'` short-circuit returned null and memoized it for the process
  // lifetime, so /daemon/status answered `build: null` beside real build fields.
  test('a failed embedded load falls through to the checkout', async () => {
    const provenance = await readRunningBuildProvenance({
      loadEmbedded: async () => null,
      captureFromCheckout: () => CHECKOUT,
    });
    expect(provenance).toEqual(CHECKOUT);
  });

  // INVARIANT: only an answer is memoized — a rejected or null attempt is asked
  // again on the next call, and the first real answer is then cached.
  test('a rejected attempt is not memoized; the next answer is', async () => {
    let calls = 0;
    const sources = {
      loadEmbedded: async () => {
        calls += 1;
        if (calls === 1) throw new Error('mid-write');
        return STAMPED;
      },
      captureFromCheckout: () => null,
    };
    await expect(readRunningBuildProvenance(sources)).rejects.toThrow('mid-write');
    expect(await readRunningBuildProvenance(sources)).toEqual(STAMPED);
    expect(await readRunningBuildProvenance(sources)).toEqual(STAMPED);
    expect(calls).toBe(2);
  });

  test('a null attempt is not memoized either', async () => {
    let calls = 0;
    const sources = {
      loadEmbedded: async () => (++calls === 1 ? null : STAMPED),
      captureFromCheckout: () => null,
    };
    expect(await readRunningBuildProvenance(sources)).toBeNull();
    expect(await readRunningBuildProvenance(sources)).toEqual(STAMPED);
  });

  test('an embedded module that exists but will not load is null, not a throw', async () => {
    const provenance = await readEmbeddedBuildProvenance(async () => {
      throw new SyntaxError('Unexpected end of input');
    });
    expect(provenance).toBeNull();
  });
});

describe('daemonStatusBuild', () => {
  // INVARIANT: /daemon/status's `build` is never null while its build fields
  // name the build — the 2026-09-28 install answered `build: null` beside
  // buildSha 16e8b4bec.
  test('falls back to the build fields when the identity lookup fails or is null', async () => {
    const fields = { buildSha: '16e8b4bec', buildBranch: 'lazy/teams-fixes-20260926', buildDirty: false };
    const expected = 'lazy/teams-fixes-20260926@16e8b4bec, clean';
    expect(await daemonStatusBuild(async () => { throw new Error('boom'); }, fields, null)).toBe(expected);
    expect(await daemonStatusBuild(async () => null, fields, null)).toBe(expected);
    expect(await daemonStatusBuild(async () => 'main@x, dirty', fields, null)).toBe('main@x, dirty');
  });

  test('a dev source run falls back to the checkout SHA', async () => {
    const dev = { buildSha: 'dev', buildBranch: 'dev', buildDirty: false };
    expect(await daemonStatusBuild(async () => null, dev, 'deadbee')).toBe('deadbee');
  });
});
