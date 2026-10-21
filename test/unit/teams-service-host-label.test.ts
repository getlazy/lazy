import { describe, expect, test } from 'bun:test';
import {
  parseTeamsServiceHostContext,
  parseTeamsServiceHostLabel,
  projectTeamPart,
  serviceForLabel,
  teamsServiceHostLabel,
} from '../../src/serve/teams-host';

const context = { projectTag: 'k3x7', projectSlug: 'web', teamSlug: 'acme' };
const id = '3f9a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

function label(subjectLabel: string, port: number, ctx = context, subjectId = id): string {
  return teamsServiceHostLabel({ subjectLabel, subjectId, port, context: ctx });
}

/** Every label rule at once: the DNS limits and the reserved-hyphen rule. */
function expectValid(value: string): void {
  expect(value.length).toBeLessThanOrEqual(63);
  expect(value).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  expect(value).not.toContain('--');
  // INVARIANT: a label never has `--` at positions 3-4 (RFC 5890 R-LDH). The old
  // `ui--9000--p15` form did, and a CA or strict URL parser refuses such labels.
  expect(value.slice(2, 4)).not.toBe('--');
}

describe('teamsServiceHostLabel', () => {
  test('short names are spelled out in full, route last', () => {
    expect(label('ui-fix', 3000)).toBe('ui-fix-3000-web-acme-k3x73f9a1c2e');
  });

  test('a 2-character task code never forms a reserved xx-- label', () => {
    const value = label('ui', 9000, { projectTag: 'p2q7', projectSlug: 'fabricate', teamSlug: 'fabricate' });
    expect(value).toBe('ui-9000-fabricat-fabrica-p2q73f9a1c2e');
    expectValid(value);
  });

  test('an xn code cannot become an xn-- A-label', () => {
    const value = label('xn', 80);
    expect(value.startsWith('xn-80-')).toBe(true);
    expectValid(value);
  });

  test('very long names are truncated to exactly 63, never ending a part in a hyphen', () => {
    const value = label('very-long-task-name-with-a-lot-of-words-in-it', 9000,
      { projectTag: 'b7d2', projectSlug: 'very-long-project', teamSlug: 'very-long-team' });
    expect(value).toBe('very-long-task-name-with-a-l-9000-very-lon-very-lo-b7d23f9a1c2e');
    expect(value.length).toBe(63);
    expectValid(value);
  });

  test('the longest code, port and slugs still fit one label', () => {
    const value = label('a'.repeat(63), 65535, { projectTag: 'zzzz', projectSlug: 'p'.repeat(60), teamSlug: 't'.repeat(60) });
    expectValid(value);
    expect(value.endsWith('-65535-pppppppp-ttttttt-zzzz3f9a1c2e')).toBe(true);
  });

  test('odd characters and doubled hyphens in a subject are squeezed', () => {
    expectValid(label('Fix--Thing__2', 3000));
    expect(label('Fix--Thing__2', 3000)).toBe('fix-thing-2-3000-web-acme-k3x73f9a1c2e');
  });

  test('a truncation that lands on a hyphen drops it', () => {
    // 27 characters of room: the cut would end on the hyphen after "x".
    const value = label(`${'x'.repeat(26)}-tail-of-the-code`, 65535,
      { projectTag: 'k3x7', projectSlug: 'abcdefgh', teamSlug: 'abcdefg' });
    expectValid(value);
  });

  test('a subject with nothing usable falls back to the short id', () => {
    expect(label('---', 3000)).toBe('3f9a1c2e-3000-web-acme-k3x73f9a1c2e');
  });

  test('a commit run is named the same way, by its slug and id', () => {
    expect(label('sha-0123456789ab', 5173, context, 'aa11bb22-0000-0000-0000-000000000000'))
      .toBe('sha-0123456789ab-5173-web-acme-k3x7aa11bb22');
  });

  test('labels are a pure function: same inputs, same label', () => {
    expect(label('ui-fix', 3000)).toBe(label('ui-fix', 3000));
  });
});

describe('projectTeamPart', () => {
  test('room one side leaves unused goes to the other, never over 16', () => {
    expect(projectTeamPart('ab', 'a-very-long-team-name')).toBe('ab-a-very-long-t');
    expect(projectTeamPart('a-very-long-project', 'x')).toBe('a-very-long-pr-x');
    for (const [p, t] of [['a', 'b'], ['abcdefghijklmnop', 'qrstuvwxyz'], ['abc-def', 'ghi-jkl-mno']]) {
      expect(projectTeamPart(p!, t!).length).toBeLessThanOrEqual(16);
      expect(projectTeamPart(p!, t!)).not.toContain('--');
    }
  });
});

describe('parseTeamsServiceHostLabel', () => {
  test('reads the route back from the fixed tail', () => {
    expect(parseTeamsServiceHostLabel('ui-fix-3000-web-acme-k3x73f9a1c2e'))
      .toEqual({ projectTag: 'k3x7', shortId: '3f9a1c2e', prefix: 'ui-fix-3000-web-acme' });
  });

  test('refuses the legacy form, bad tails and over-long labels', () => {
    expect(parseTeamsServiceHostLabel('ui-fix--3000--p15')).toBeNull();
    expect(parseTeamsServiceHostLabel('ui-fix-3000-web-acme-k1x73f9a1c2e')).toBeNull(); // 1 is not base32
    expect(parseTeamsServiceHostLabel('ui-fix-3000-web-acme-k3x73f9a1c2g')).toBeNull(); // g is not hex
    expect(parseTeamsServiceHostLabel('k3x73f9a1c2e')).toBeNull();
    expect(parseTeamsServiceHostLabel(`${'a'.repeat(60)}-k3x73f9a1c2e`)).toBeNull();
  });
});

describe('serviceForLabel', () => {
  const declared = [{ name: 'web', port: 3000 }, { name: 'api', port: 8080 }];
  const subject = { subjectLabel: 'ui-fix', subjectId: id };

  test('an exact label names its service', () => {
    expect(serviceForLabel(label('ui-fix', 8080), subject, declared, context))
      .toEqual({ name: 'api', port: 8080, label: 'api' });
  });

  test('a label from before a rename still finds its one port', () => {
    const old = label('ui-fix', 3000, { ...context, projectSlug: 'old' });
    expect(serviceForLabel(old, subject, declared, context)).toEqual({ name: 'web', port: 3000, label: 'web' });
  });

  test('an ambiguous port after a rename answers null, never a guess', () => {
    const old = label('fix-8080-thing', 3000, { ...context, projectSlug: 'old' });
    expect(serviceForLabel(old, { subjectLabel: 'renamed', subjectId: id }, declared, context)).toBeNull();
  });
});

describe('parseTeamsServiceHostContext', () => {
  // INVARIANT: a slug of any length is accepted and cut, never refused. Teams
  // caps no slug length, and the context rides every servePorts call, so a
  // refusal here would take the Services card and Open away from a whole
  // project after one long rename.
  test('a 250-character project or team slug is accepted and still yields a valid label', () => {
    const long = `${'a'.repeat(120)}-${'b'.repeat(129)}`;
    expect(long.length).toBe(250);
    for (const ctx of [{ ...context, projectSlug: long }, { ...context, teamSlug: long }]) {
      expect(parseTeamsServiceHostContext(ctx)).toEqual(ctx);
      expectValid(label('ui-fix', 3000, ctx));
    }
  });

  test('absent is null; malformed throws naming the field', () => {
    expect(parseTeamsServiceHostContext(undefined)).toBeNull();
    expect(parseTeamsServiceHostContext(context)).toEqual(context);
    expect(() => parseTeamsServiceHostContext({ ...context, projectTag: 'K3X7' })).toThrow(/projectTag/);
    expect(() => parseTeamsServiceHostContext({ ...context, teamSlug: 'Acme Co' })).toThrow(/teamSlug/);
    expect(() => parseTeamsServiceHostContext('k3x7')).toThrow(/object/);
  });
});
