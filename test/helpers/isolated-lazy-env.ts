import { beforeEach, afterEach } from 'bun:test';

/**
 * A suite must opt into its own managed mode, config paths and test seams.
 * Inherit none of the outer task's LAZY_* settings; restore them only after
 * nested teardown has reaped the suite's daemons and removed its temp paths.
 * Slow-suite opt-in is evaluated during collection, before these hooks run.
 */
export function isolateLazyEnv(): void {
  let previous: Map<string, string>;
  const clear = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LAZY_')) delete process.env[key];
    }
  };
  beforeEach(() => {
    previous = new Map(Object.entries(process.env).filter(([key]) => key.startsWith('LAZY_')) as [string, string][]);
    clear();
  });
  afterEach(() => {
    clear();
    for (const [key, value] of previous) process.env[key] = value;
  });
}
