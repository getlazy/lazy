/**
 * Unit tests: collapsing an `ActorInput` into the columns a row carries.
 *
 * `src/actor-ref.ts` is the ONE place that turns "role, and which person" into
 * stored fields, so the rules that matter are the ones every backend then
 * depends on: an unset half is an ABSENT key, a blank is the same as unset, and
 * a row with no person at all is exactly the row lazy wrote before people had
 * names in the store.
 */

import { describe, test, expect } from 'bun:test';
import { actorEmail, actorFields, actorName, actorRole, withActorPerson } from '../../src/actor-ref';

describe('actorFields', () => {
  test('an attributed write carries the role and both halves of the person', () => {
    expect(actorFields({ role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' })).toEqual({
      actor: 'human',
      actor_email: 'ada@example.com',
      actor_name: 'Ada Lovelace',
    });
  });

  // INVARIANT (cross-backend row shape): an unset optional key is ABSENT, never
  // present-and-undefined — FileStorage row shapes are compared key-for-key
  // against other backends (test/e2e/storage-contract.test.ts).
  test('a bare role emits the role key and nothing else', () => {
    const fields = actorFields('supervisor');
    expect(fields).toEqual({ actor: 'supervisor' });
    expect('actor_email' in fields).toBe(false);
    expect('actor_name' in fields).toBe(false);
  });

  test('nothing known emits no keys at all', () => {
    expect(Object.keys(actorFields(undefined))).toEqual([]);
  });

  // Both halves are nullable INDEPENDENTLY and forever: a token may know an
  // address and no display name, which must not suppress the address.
  test('an email with no name still names the person', () => {
    const fields = actorFields({ role: 'human', email: 'ada@example.com' });
    expect(fields.actor_email).toBe('ada@example.com');
    expect('actor_name' in fields).toBe(false);
  });

  // A blank attributes a row to nobody while LOOKING set, which is worse than
  // absent: a surface would render an empty name beside a real role.
  test('a blank half is treated as unset rather than stored', () => {
    const fields = actorFields({ role: 'human', email: '', name: '' });
    expect(fields).toEqual({ actor: 'human' });
  });
});

describe('reading an ActorInput', () => {
  test('a bare role has a role and no person', () => {
    expect(actorRole('builder')).toBe('builder');
    expect(actorEmail('builder')).toBeUndefined();
    expect(actorName('builder')).toBeUndefined();
  });

  test('an unset input has nothing', () => {
    expect(actorRole(undefined)).toBeUndefined();
    expect(actorEmail(undefined)).toBeUndefined();
    expect(actorName(undefined)).toBeUndefined();
  });
});

describe('withActorPerson', () => {
  // Call sites that default a missing actor end up holding a plain role; the
  // person must survive that defaulting or an attributed write silently loses
  // who made it.
  test('re-attaches the person to a role resolved separately', () => {
    expect(withActorPerson('agent', { role: 'human', email: 'ada@example.com', name: 'Ada Lovelace' }))
      .toEqual({ role: 'agent', email: 'ada@example.com', name: 'Ada Lovelace' });
  });

  test('stays a bare role when the source names nobody', () => {
    expect(withActorPerson('human', 'builder')).toBe('human');
    expect(withActorPerson('human', undefined)).toBe('human');
    expect(withActorPerson('human', { role: 'human' })).toBe('human');
  });
});
