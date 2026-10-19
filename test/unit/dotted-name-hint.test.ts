import { test, expect } from 'bun:test';
import { dottedNameHint } from '../../src/config/loader';

// INVARIANT: a parse failure on a dotted agents./endpoints. header tells the user to quote the name.
test('dotted header gets the quote-it hint', () => {
  expect(dottedNameHint('[agents.claude-lunaroute-glm-5.3]')).toContain('[agents."claude-lunaroute-glm-5.3"]');
  expect(dottedNameHint('[endpoints.a.b] # c')).toContain('[endpoints."a.b"]');
});

test('undotted and already quoted headers get no hint', () => {
  expect(dottedNameHint('[agents.a]')).toBe('');
  expect(dottedNameHint('[agents."a.b"]')).toBe('');
});
