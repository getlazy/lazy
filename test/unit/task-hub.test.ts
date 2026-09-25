/**
 * The HUB predicate — "does this task present by its own work, or by its
 * children?" (src/task/hub.ts).
 *
 * It is one rule read from two places: the wrap-up plan drops the presentation
 * step on a hub, and the regions loader routes a hub to the derived map. These
 * tests pin the rule itself; `wrap-up-plan.test.ts` pins that the plan reads it
 * and `test/e2e/regions.test.ts` pins what a reader actually gets.
 */

import { describe, test, expect } from 'bun:test';
import type { Task } from '../../src/types';
import {
  hubRelevantChildren,
  isChildLanded,
  isHubTask,
  outstandingChildren,
} from '../../src/task/hub';

const child = (status: Task['status']) => ({ status });
const leaf = { type: 'task' } as Pick<Task, 'type'>;
const cluster = { type: 'cluster' } as Pick<Task, 'type'>;

describe('isHubTask', () => {
  // The three cases the rule draws apart, one test each.

  // INVARIANT (review 36b9c014): a child STILL IN FLIGHT does not make a hub.
  // Nothing of its work is on this branch yet, so the derived map would have
  // nothing to show — and the task, which is at this point entirely its own
  // work, would stop authoring a walkthrough for the rest of its life. Asserted
  // across the whole in-flight range, not just one status, because "not landed,
  // not abandoned" is the shape of the rule and a new status joins it silently.
  test('a task whose children are all still in flight is not a hub', () => {
    for (const status of ['backlog', 'working', 'blocked', 'conflict', 'submitted', 'interrupted'] as Task['status'][]) {
      expect(isHubTask(leaf, [child(status)])).toBe(false);
    }
  });

  // INVARIANT (review f2c997a9): an ABANDONED child does not make a hub.
  // `lazy close` and `lazy reject` both land there, so a leaf task that spawned
  // one exploratory subtask and closed it would otherwise be a hub FOREVER: it
  // would never author a walkthrough again, and its reviewer would be shown a
  // git carve plus a note promising a child that can never land. Same reasoning
  // `cluster-progress.ts` applies to its k-of-n, one question earlier.
  test('a task whose only child was closed or rejected is not a hub', () => {
    expect(isHubTask(leaf, [child('abandoned')])).toBe(false);
  });

  // INVARIANT (review 36b9c014): a LANDED child is the trigger, and the only
  // one. Its work is on the branch, which is both what makes the task "mostly
  // its children's work" and the reason the derived map has something to show.
  test('a task with one landed child is a hub', () => {
    expect(isHubTask(leaf, [child('complete')])).toBe(true);
  });

  test('a childless ordinary task is not', () => {
    expect(isHubTask(leaf, [])).toBe(false);
  });

  // One landed child is enough, whatever else is around it — a release hub
  // spends most of its life with children in every state at once.
  test('one landed child among in-flight and abandoned ones makes a hub', () => {
    expect(isHubTask(leaf, [child('abandoned'), child('working'), child('complete')])).toBe(true);
  });

  test('in-flight and abandoned children together still make no hub', () => {
    expect(isHubTask(leaf, [child('abandoned'), child('working')])).toBe(false);
  });

  // INVARIANT: a `cluster` counts from its FIRST turn, before it has landed
  // anything — its whole contract is to drive children, so the turns where it
  // has none yet are a hub that has not started, not a task that will present
  // its own work. Asserted with child sets that would NOT make an ordinary task
  // a hub, because the cluster arm must not be reachable only through them.
  test('a cluster is a hub before any child has landed', () => {
    expect(isHubTask(cluster, [])).toBe(true);
    expect(isHubTask(cluster, [child('abandoned')])).toBe(true);
    expect(isHubTask(cluster, [child('working')])).toBe(true);
  });
});

describe('the child sets the derived map lists', () => {
  test('landed means complete, and nothing else', () => {
    expect(isChildLanded(child('complete'))).toBe(true);
    for (const status of ['blocked', 'working', 'abandoned', 'conflict'] as Task['status'][]) {
      expect(isChildLanded(child(status))).toBe(false);
    }
  });

  test('hub-relevant children drop the abandoned and keep the rest', () => {
    const children = [child('complete'), child('abandoned'), child('blocked')];
    expect(hubRelevantChildren(children)).toEqual([child('complete'), child('blocked')]);
  });

  // INVARIANT (review f2c997a9): the derived map's "not accepted into this
  // branch yet" listing names only children that can STILL land. Naming an
  // abandoned one promises a reviewer something that can never arrive.
  test('outstanding children exclude both the landed and the abandoned', () => {
    const children = [child('complete'), child('abandoned'), child('blocked')];
    expect(outstandingChildren(children)).toEqual([child('blocked')]);
  });

  test('a hub whose every child landed has nothing outstanding', () => {
    expect(outstandingChildren([child('complete'), child('complete')])).toEqual([]);
  });
});
