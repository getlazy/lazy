import { describe, test, expect } from 'bun:test';
import builderSystemPrompt from '../../src/prompts/builder-system-prompt.md' with { type: 'text' };
import { applyBuilderPromptPlaceholders } from '../../src/builder/system-prompt';
import { renderDashboardPromptSection } from '../../src/daemon/dashboard-availability';

const ON_URL = 'http://lazy.localhost:26025';

describe('builder dashboard prompt section', () => {
  // INVARIANT: the {{DASHBOARD}} placeholder sits after "How you work" so the
  // builder learns how it orchestrates before it learns how to link tasks,
  // and before "When to create tasks" so the section is not buried.
  test('placeholder appears after How you work and before When to create tasks', () => {
    const dashboardIdx = builderSystemPrompt.indexOf('{{DASHBOARD}}');
    const howYouWorkIdx = builderSystemPrompt.indexOf('## How you work');
    const whenToCreateIdx = builderSystemPrompt.indexOf('## When to create tasks');
    expect(dashboardIdx).toBeGreaterThan(-1);
    expect(dashboardIdx).toBeGreaterThan(howYouWorkIdx);
    expect(dashboardIdx).toBeLessThan(whenToCreateIdx);
  });

  // INVARIANT: when the dashboard is on, the assembled prompt carries the
  // daemon's base URL and the path patterns the builder should use — this is
  // how the engineer gets clickable task links without a memory record.
  test('assembled prompt contains the base URL and path patterns when the dashboard is on', () => {
    const prompt = applyBuilderPromptPlaceholders({
      runnerInstructions: 'RUNNER',
      chattinessSnippet: '',
      dashboardSection: renderDashboardPromptSection({ available: true, url: ON_URL }),
    });

    expect(prompt).toContain(ON_URL);
    expect(prompt).toContain('/tasks/<code>');
    expect(prompt).toContain('/review/<code>');
    expect(prompt).toContain('/review');
    expect(prompt).toContain('/raised/<id>');
    expect(prompt).toContain('/raised');
    expect(prompt).toContain(`](${ON_URL}/tasks/`);
    expect(prompt).not.toContain('{{DASHBOARD}}');
    expect(prompt).not.toContain('{{DASHBOARD_URL}}');
    expect(prompt).not.toContain('{{UNAVAILABLE_REASON}}');
    // The off sentence must not appear alongside a real URL.
    expect(prompt).not.toContain('is not available');
  });

  // INVARIANT: when the dashboard is off or unreachable, the section says so
  // and does not invent a URL. A fabricated lazy.localhost link would 404.
  test('assembled prompt contains the off sentence and no URL when the dashboard is off', () => {
    const prompt = applyBuilderPromptPlaceholders({
      runnerInstructions: 'RUNNER',
      chattinessSnippet: '',
      dashboardSection: renderDashboardPromptSection({ available: false, reason: 'off' }),
    });

    expect(prompt).toContain('## Dashboard');
    expect(prompt).toContain('is not available');
    expect(prompt).toContain('managed');
    expect(prompt).toContain('do not invent a dashboard URL');
    expect(prompt).not.toContain('http://');
    expect(prompt).not.toContain('lazy.localhost');
    expect(prompt).not.toContain('{{DASHBOARD}}');
    expect(prompt).not.toContain('{{UNAVAILABLE_REASON}}');
  });

  test('assembled prompt says unreachable and invents no URL when the dashboard cannot be reached', () => {
    const prompt = applyBuilderPromptPlaceholders({
      runnerInstructions: 'RUNNER',
      chattinessSnippet: '',
      dashboardSection: renderDashboardPromptSection({ available: false, reason: 'unreachable' }),
    });

    expect(prompt).toContain('is not available');
    expect(prompt).toContain('could not be reached');
    expect(prompt).not.toContain('http://');
    expect(prompt).not.toContain('lazy.localhost');
  });
});
