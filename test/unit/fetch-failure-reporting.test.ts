import { describe, test, beforeEach, afterEach, expect } from 'bun:test';

import { logger } from '../../src/utils/logger';
import {
  reportFetchFailure,
  clearFetchFailure,
  resetFetchFailureReporting,
} from '../../src/remote/fetch-failure';

/**
 * The daemon fetches every 60 seconds. A remote whose credentials the machine
 * does not have fails on every one of those ticks, indefinitely — so the thing
 * that must be bounded is the REPORTING, not the retrying (polling is the sync
 * loop's job and a transient failure has to be retried).
 */
describe('fetch failure reporting', () => {
  const warns: string[] = [];
  const debugs: string[] = [];
  let realWarn: typeof logger.warn;
  let realDebug: typeof logger.debug;

  beforeEach(() => {
    warns.length = 0;
    debugs.length = 0;
    realWarn = logger.warn.bind(logger);
    realDebug = logger.debug.bind(logger);
    logger.warn = (m: string) => { warns.push(m); };
    logger.debug = (m: string) => { debugs.push(m); };
    resetFetchFailureReporting();
  });

  afterEach(() => {
    logger.warn = realWarn;
    logger.debug = realDebug;
    resetFetchFailureReporting();
  });

  const NO_CREDENTIAL =
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

  test('a missing credential is reported with the remote, the project and a remedy', () => {
    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);

    expect(warns.join('\n')).toContain('/projects/acme');
    expect(warns.join('\n')).toContain('origin');
    expect(warns.join('\n')).toContain('terminal prompts disabled');
    // Without this the log says only what happened, which reads like a bug in
    // lazy rather than a credential the machine does not have.
    expect(warns.join('\n')).toContain('needs credentials');
    expect(warns.join('\n')).toContain('sync_interval = 0');
  });

  // INVARIANT: a permanent failure is reported once, not once per tick. The
  // daemon keeps retrying — that is deliberate — but repeating the identical
  // line every 60s buries everything else in daemon.log.
  test('the same failure on later ticks does not repeat the warning', () => {
    for (let tick = 0; tick < 10; tick++) {
      reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);
    }

    expect(warns.length).toBe(2); // the failure, plus its remedy line
    expect(debugs.length).toBe(9);
    expect(debugs[0]).toContain('unchanged since last sync');
  });

  test('a different failure is reported even after a repeat', () => {
    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);
    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);
    warns.length = 0;

    reportFetchFailure('/projects/acme', 'origin', 'fatal: Could not resolve host: github.com');

    expect(warns.length).toBe(1); // network failure, no credential remedy
    expect(warns[0]).toContain('Could not resolve host');
  });

  test('failures are tracked per project and per remote', () => {
    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);
    reportFetchFailure('/projects/other', 'origin', NO_CREDENTIAL);
    reportFetchFailure('/projects/acme', 'upstream', NO_CREDENTIAL);

    // Three distinct remotes, three reports (each with its remedy line).
    expect(warns.length).toBe(6);
  });

  // A fetch that starts working must not leave the next failure silent.
  test('a successful fetch clears the memory of the last failure', () => {
    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);
    clearFetchFailure('/projects/acme', 'origin');
    warns.length = 0;

    reportFetchFailure('/projects/acme', 'origin', NO_CREDENTIAL);

    expect(warns.length).toBe(2);
  });

  test('empty stderr still produces a report rather than a blank line', () => {
    reportFetchFailure('/projects/acme', 'origin', '   ');

    expect(warns[0]).toContain('(no output)');
  });
});
