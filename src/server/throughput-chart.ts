/**
 * Daily throughput series for the dashboard chart.
 *
 * Backlog is an end-of-day snapshot. Completed / closed / submitted are
 * daily counts: accepted, abandoned, and transitions into `submitted`.
 * Submitted is its own series so a PR waiting on the forge is not invisible
 * between "still in backlog" and "accepted".
 */

import type { Task, StatusChange } from '../storage';
import type { ChartDataPoint } from './templates';

export function buildChartData(
  allTasks: Task[],
  statusHistories: Map<string, StatusChange[]>,
  now: number = Date.now(),
): ChartDataPoint[] {
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const dailyMap = new Map<string, ChartDataPoint>();

  const msPerDay = 24 * 60 * 60 * 1000;
  const startDay = new Date(fourteenDaysAgo);
  startDay.setUTCHours(0, 0, 0, 0);

  for (let t = startDay.getTime(); t <= now; t += msPerDay) {
    const dateStr = toUTCDateString(t);
    dailyMap.set(dateStr, {
      date: dateStr,
      backlog: 0,
      completed: 0,
      closed: 0,
      submitted: 0,
    });
  }

  for (let t = startDay.getTime(); t <= now; t += msPerDay) {
    const endOfDay = t + msPerDay - 1;
    const dateStr = toUTCDateString(t);
    const point = dailyMap.get(dateStr);
    if (!point) continue;

    for (const task of allTasks) {
      if (task.created_at > endOfDay) continue;

      const changes = statusHistories.get(task.id) ?? [];
      let statusAtEndOfDay = 'backlog';
      for (const change of changes) {
        if (change.timestamp <= endOfDay) {
          statusAtEndOfDay = change.status;
        } else {
          break;
        }
      }

      if (statusAtEndOfDay === 'backlog') {
        point.backlog++;
      }

      if (task.completed_at) {
        const completedDate = toUTCDateString(task.completed_at);
        if (completedDate === dateStr) {
          if (task.status === 'complete') {
            point.completed++;
          } else if (task.status === 'abandoned') {
            point.closed++;
          }
        }
      }
    }
  }

  // Daily deltas — a transition into submitted that day, not a snapshot.
  // A task submitted twice in one day counts twice; that is rare and the
  // same "something happened today" reading completed/closed already use.
  for (const task of allTasks) {
    for (const change of statusHistories.get(task.id) ?? []) {
      if (change.status !== 'submitted') continue;
      const point = dailyMap.get(toUTCDateString(change.timestamp));
      if (point) point.submitted++;
    }
  }

  const points = Array.from(dailyMap.values());
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

export function toUTCDateString(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
