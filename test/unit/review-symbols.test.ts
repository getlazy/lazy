/**
 * Symbol table for review jump links — names declared in the parsed diff.
 * Duplicate names (two files, or two lines of one file) are omitted rather
 * than guessed.
 */

import { describe, test, expect } from 'bun:test';
import { extractDeclarations, buildSymbolTable } from '../../src/server/review-symbols';
import { anchorDomId, type DiffFile, type DiffLine } from '../../src/server/review-diff';

function add(content: string, newLine: number): DiffLine {
  return { kind: 'add', oldLine: null, newLine, content };
}

function file(path: string, lines: DiffLine[]): DiffFile {
  return {
    path,
    oldPath: null,
    hunks: [{ header: '@@ -1,0 +1,1 @@', lines }],
    additions: lines.length,
    deletions: 0,
    binary: false,
  };
}

describe('extractDeclarations', () => {
  test('javascript / typescript: functions, classes, types, methods', () => {
    expect(extractDeclarations('export function soAndSo() {', 'js')).toEqual(['soAndSo']);
    expect(extractDeclarations('export default async function load() {', 'js')).toEqual(['load']);
    expect(extractDeclarations('export class Widget {', 'js')).toEqual(['Widget']);
    expect(extractDeclarations('export type Foo = string;', 'js')).toEqual(['Foo']);
    expect(extractDeclarations('export interface Bar {', 'js')).toEqual(['Bar']);
    expect(extractDeclarations('export const NAME = 1;', 'js')).toEqual(['NAME']);
    expect(extractDeclarations('  render() {', 'js')).toEqual(['render']);
    expect(extractDeclarations('  async save(): Promise<void> {', 'js')).toEqual(['save']);
    // Control-flow is not a declaration.
    expect(extractDeclarations('if (ready) {', 'js')).toEqual([]);
    expect(extractDeclarations('for (const x of xs) {', 'js')).toEqual([]);
  });

  test('ruby / python / go / rust', () => {
    expect(extractDeclarations('def foo', 'ruby')).toEqual(['foo']);
    expect(extractDeclarations('def self.bar', 'ruby')).toEqual(['bar']);
    expect(extractDeclarations('class Widget', 'ruby')).toEqual(['Widget']);
    expect(extractDeclarations('module Helpers', 'ruby')).toEqual(['Helpers']);

    expect(extractDeclarations('def foo(x):', 'python')).toEqual(['foo']);
    expect(extractDeclarations('async def bar(self):', 'python')).toEqual(['bar']);
    expect(extractDeclarations('class Widget:', 'python')).toEqual(['Widget']);

    expect(extractDeclarations('func Foo() {', 'go')).toEqual(['Foo']);
    expect(extractDeclarations('func (r *T) Bar() {', 'go')).toEqual(['Bar']);
    expect(extractDeclarations('type Foo struct {', 'go')).toEqual(['Foo']);

    expect(extractDeclarations('pub fn foo() {', 'rust')).toEqual(['foo']);
    expect(extractDeclarations('pub struct Foo {', 'rust')).toEqual(['Foo']);
    expect(extractDeclarations('pub const BAR: u8 = 1;', 'rust')).toEqual(['BAR']);
  });
});

describe('buildSymbolTable', () => {
  test('maps a unique declaration to the Changes-tab line anchor', () => {
    const lookup = buildSymbolTable(
      [file('src/foo.ts', [add('export function soAndSo() {', 12)])],
      'task-1',
    );
    const href = lookup.get('soAndSo');
    expect(href).toBe(
      `/tasks/task-1/changes#${anchorDomId({ file: 'src/foo.ts', side: 'new', line: 12 })}`,
    );
  });

  test('omits a name declared in more than one changed file', () => {
    const lookup = buildSymbolTable(
      [
        file('src/a.ts', [add('export function collide() {', 1)]),
        file('src/b.ts', [add('export function collide() {', 1)]),
      ],
      'task-1',
    );
    expect(lookup.has('collide')).toBe(false);
  });

  test('omits a name declared twice in the same file', () => {
    const lookup = buildSymbolTable(
      [file('src/a.ts', [
        add('export function twice() {', 1),
        add('function twice() {', 8),
      ])],
      'task-1',
    );
    expect(lookup.has('twice')).toBe(false);
  });

  test('skips deleted lines — only the post-image is searchable', () => {
    const lookup = buildSymbolTable(
      [file('src/a.ts', [{ kind: 'del', oldLine: 1, newLine: null, content: 'export function gone() {' }])],
      'task-1',
    );
    expect(lookup.size).toBe(0);
  });
});
