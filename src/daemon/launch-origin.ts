/**
 * WHERE an ownerless turn launch came from, for the refusal that has to say why
 * a turn fell to the project's service holder.
 *
 * Billing never reads this — who pays is the turn owner's question
 * (./turn-owner.ts). This only lets a service-holder refusal name the real
 * trigger ("task X's agent started it during a turn nobody asked for", "the
 * builder started it") instead of listing every way a turn can be automated.
 * Request-scoped like the turn owner, never a shared slot.
 */
import { AsyncLocalStorage } from 'async_hooks';

export type LaunchOrigin =
  | { kind: 'agent'; parentTask: string }
  | { kind: 'builder' };

const scope = new AsyncLocalStorage<LaunchOrigin>();

export function runWithLaunchOrigin<T>(origin: LaunchOrigin, fn: () => Promise<T>): Promise<T> {
  return scope.run(origin, fn);
}

export function currentLaunchOrigin(): LaunchOrigin | null {
  return scope.getStore() ?? null;
}

/** Why an ownerless turn runs on the service holder, in the words a refusal uses. */
export function serviceTurnReason(): string {
  const origin = currentLaunchOrigin();
  if (origin?.kind === 'agent') {
    return `Task ${origin.parentTask}'s agent started this turn during a turn nobody asked for (lazy started it by itself), so it runs on the service holder's connections`;
  }
  if (origin?.kind === 'builder') {
    return "The builder started this turn from a session that names no member, so it runs on the service holder's connections";
  }
  return "Nobody asked for this turn — lazy started it by itself (an automatic review, resume, delivery or sync) — so it runs on the service holder's connections";
}
