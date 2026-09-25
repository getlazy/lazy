/**
 * The source scan behind `test/unit/server-html-escaping.test.ts`.
 *
 * It answers one question for every `${…}` in an HTML template under
 * `src/server/`: can this value reach the browser as MARKUP without passing
 * through `escapeHtml` (or another sink that escapes for its own context)?
 *
 * It is a real parse with a real type checker — the PINNED typescript, built
 * from this repo's own tsconfig — not a regex. Two reasons the cheaper thing
 * does not work here: a regex cannot tell a nested template from the one
 * containing it, and nested templates are how every list in that tree is built;
 * and without types every `${count}` and `${status}` is indistinguishable from
 * `${goal}`, which buries the handful of real findings in hundreds of numbers.
 *
 * Deliberately conservative in ONE direction: an expression it cannot prove
 * safe is reported. A false positive costs a rename or an allowlist line; a
 * false negative is a stored XSS on the origin that holds the dashboard session
 * cookie, which is the origin authorizing every daemon write route.
 */

import ts from 'typescript';
import { readFile } from 'fs/promises';
import { join, relative, sep } from 'path';

export interface BareInterpolation {
  file: string;
  line: number;
  expression: string;
  /** The markup immediately preceding the hole, for reading a report. */
  context: string;
}

/** Calls whose RESULT is already escaped for the context it is spliced into. */
const ESCAPING_CALLS = new Set([
  'escapeHtml',
  'esc', // the browser mirror, shipped as ESCAPE_HTML_JS into the islands
  'escapeAttr',
  'escapeText', // an alias of escapeHtml, kept for its call sites' wording
  'scriptJson', // escapes for an inline <script> body
  // encodeURIComponent is trusted only OUTSIDE a single-quoted attribute — see
  // `isSafeCall`. It deliberately leaves `'` (and `!~*()`) unencoded, so
  // `href='${encodeURIComponent(x)}'` is an attribute breakout that this list
  // would otherwise bless. No such attribute exists in the tree today; the
  // check is what keeps that a fact rather than a coincidence.
  'encodeURIComponent',
  // The markdown renderers escape their whole input FIRST and transform the
  // escaped string after (src/server/markdown.ts), which is why their own
  // bodies carry the pinned exceptions — reading them through their returns
  // would report every caller for holes already accounted for there.
  'renderMarkdown',
  'renderInline',
  'renderReviewMarkdown',
]);

/**
 * Identifier suffixes that declare a value to be ALREADY-RENDERED markup,
 * composed by a renderer that escaped its own parts.
 *
 * The convention is load-bearing rather than decorative: a fragment that does
 * not SAY it holds markup is read here as raw data and reported, so an
 * ambiguous name fails the test until someone names it.
 */
const MARKUP_SUFFIXES = [
  'Html',
  'HTML',
  'Markup',
  'Icon',
  'Svg',
  'Script',
  'Styles',
  // NOT `Attrs`: an attribute fragment is now HTML to emitsHtml above, so it
  // is CHECKED rather than trusted. Trusting the name would re-exempt exactly
  // the class that change exists to cover.
];

/** Whole identifiers naming a markup fragment without a matching suffix. */
const MARKUP_IDENTIFIERS = new Set([
  'html',
  'markup',
  'styles',
  'script',
  'scripts',
  'svg',
  'icon',
  'ESCAPE_HTML_JS',
]);

function isMarkupName(name: string): boolean {
  if (MARKUP_IDENTIFIERS.has(name)) return true;
  return MARKUP_SUFFIXES.some((s) => name.endsWith(s));
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
      current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

/** UPPER_SNAKE names a constant written in this source, not runtime data. */
function isModuleConstantName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

export class HtmlInterpolationScanner {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly serverDir: string;
  /** Memo for "are all of this function's returns safe?", with cycle guard. */
  private readonly functionVerdicts = new Map<ts.Node, boolean>();

  constructor(private readonly root: string) {
    const configPath = join(root, 'tsconfig.json');
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (raw.error) {
      throw new Error(`failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`);
    }
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
    this.serverDir = join(root, 'src', 'server') + sep;
    const entries = parsed.fileNames.filter((f) => f.startsWith(this.serverDir));
    if (entries.length === 0) {
      throw new Error(`no sources found under ${this.serverDir} — is the tsconfig include list right?`);
    }
    this.program = ts.createProgram(entries, {
      ...parsed.options,
      noEmit: true,
      skipLibCheck: true,
    });
    this.checker = this.program.getTypeChecker();
  }

  /** The files the scan covers, repo-relative. */
  scannedFiles(): string[] {
    return this.program
      .getSourceFiles()
      .filter((sf) => sf.fileName.startsWith(this.serverDir) && !sf.isDeclarationFile)
      .map((sf) => relative(this.root, sf.fileName))
      .sort();
  }

  scan(): BareInterpolation[] {
    const findings: BareInterpolation[] = [];
    for (const sf of this.program.getSourceFiles()) {
      if (!sf.fileName.startsWith(this.serverDir) || sf.isDeclarationFile) continue;
      this.scanSourceFile(sf, findings);
    }
    return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private scanSourceFile(sf: ts.SourceFile, findings: BareInterpolation[]): void {
    const rel = relative(this.root, sf.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node) && emitsHtml(node)) {
        for (const span of node.templateSpans) {
          if (this.isSafe(span.expression)) continue;
          const start = span.expression.getStart(sf);
          const pos = sf.getLineAndCharacterOfPosition(start);
          findings.push({
            file: rel,
            line: pos.line + 1,
            expression: span.expression.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
            context: sf.text.slice(Math.max(0, start - 46), start).replace(/\s+/g, ' ').slice(-44),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** Is this expression safe to splice into markup? */
  isSafe(raw: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const node = unwrap(raw);
    if (seen.has(node)) return true; // a cycle is no new evidence either way
    seen.add(node);

    // A value that cannot BE markup: a number, a boolean, a date, or a union of
    // string literals written in this source (statuses, tones, class names).
    if (this.hasNonMarkupType(node)) return true;

    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }

    if (ts.isIdentifier(node)) {
      if (isMarkupName(node.text)) return true;
      const contributions = this.contributingExpressions(node);
      if (contributions) return contributions.every((e) => this.isSafe(e, seen));
      return isModuleConstantName(node.text);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isPropertyAccessExpression(node) && isMarkupName(node.name.text)) return true;
      // `TONE_CLASS[entry.tone]` — a lookup into a table written in this source
      // is as safe as the table's values, whatever the key turns out to be.
      const base = unwrap(node.expression);
      if (ts.isIdentifier(base)) {
        const table = this.constObjectLiteral(base);
        if (table) {
          return table.properties.every(
            (p) => ts.isPropertyAssignment(p) && this.isSafe(p.initializer, seen),
          );
        }
      }
      return false;
    }

    if (ts.isConditionalExpression(node)) {
      return this.isSafe(node.whenTrue, seen) && this.isSafe(node.whenFalse, seen);
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // `cond && <markup>` — only the right side is ever emitted.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.isSafe(node.right, seen);
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        return this.isSafe(node.left, seen) && this.isSafe(node.right, seen);
      }
      return op !== ts.SyntaxKind.CommaToken; // comparisons and arithmetic
    }

    if (ts.isPrefixUnaryExpression(node)) return true;

    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.every((span) => this.isSafe(span.expression, seen));
    }

    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((el) => ts.isSpreadElement(el) || this.isSafe(el, seen));
    }

    if (ts.isCallExpression(node)) return this.isSafeCall(node, seen);

    return false;
  }

  private isSafeCall(node: ts.CallExpression, seen: Set<ts.Node>): boolean {
    const callee = unwrap(node.expression);

    if (ts.isIdentifier(callee) && ESCAPING_CALLS.has(callee.text)) {
      // The one escaper whose trust is POSITIONAL: encodeURIComponent leaves
      // `'` unencoded, so it escapes nothing in a single-quoted attribute.
      // Every other name on the list covers the apostrophe.
      if (callee.text === 'encodeURIComponent' && inSingleQuotedAttribute(node)) return false;
      return true;
    }

    // `String(n)` of something that cannot be markup is still not markup.
    if (ts.isIdentifier(callee) && callee.text === 'String') {
      const arg = node.arguments[0];
      return !!arg && this.isSafe(arg, seen);
    }

    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (ESCAPING_CALLS.has(method)) return true;
      // `parts.join('')` is as safe as `parts`.
      if (method === 'join') return this.isSafe(callee.expression, seen);
      if (method === 'map' || method === 'flatMap') {
        const cb = node.arguments[0];
        if (!cb) return false;
        if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
          return this.returnsSafely(cb, seen);
        }
        // `items.map(rowHtml)` — a bare callback reference; follow it.
        if (ts.isIdentifier(cb)) return this.isSafeCallbackReference(cb, seen);
        return this.isSafe(cb, seen);
      }
      if (method === 'filter' || method === 'slice' || method === 'reverse' || method === 'sort') {
        return this.isSafe(callee.expression, seen);
      }
      // Formatting a number produces digits, whatever the locale or the radix.
      if (
        (method === 'toFixed' ||
          method === 'toPrecision' ||
          method === 'toLocaleString' ||
          method === 'toString' ||
          method === 'toISOString') &&
        this.hasNonMarkupType(callee.expression)
      ) {
        return true;
      }
    }

    // Follow the callee into its declaration wherever it lives.
    const signature = this.checker.getResolvedSignature(node);
    const decl = signature?.declaration;
    if (
      decl &&
      (ts.isFunctionDeclaration(decl) ||
        ts.isArrowFunction(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isMethodDeclaration(decl)) &&
      (decl as ts.FunctionLikeDeclaration).body
    ) {
      // A RENDERER that lives in the scanned tree is checked on its own body,
      // by this same scan — and only a renderer. Trusting every in-tree callee
      // was the scan's own blind spot: a helper returning RAW DATA
      // (`truncateQuote`, `formatWhen`) has no template in its body, so nothing
      // in it is ever checked, and `<q>${truncateQuote(text)}</q>` passed
      // silently — the exact class this scan exists to catch. The name is the
      // declaration that it builds markup, so it is what earns the shortcut;
      // everything else is read through its returns like any other callee.
      // Duplicate reports on a genuine renderer are the price.
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (
        isMarkupName(calleeName) &&
        decl.getSourceFile().fileName.startsWith(this.serverDir)
      ) {
        return true;
      }
      return this.returnsSafely(decl, seen);
    }

    // Unresolvable (an interface member, an import without sources): fall back
    // to the naming convention.
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    return ESCAPING_CALLS.has(name) || isMarkupName(name);
  }

  /** A function passed by NAME to `.map()`: same rule as calling it. */
  private isSafeCallbackReference(id: ts.Identifier, seen: Set<ts.Node>): boolean {
    if (isMarkupName(id.text)) return true;
    for (const decl of this.checker.getSymbolAtLocation(id)?.declarations ?? []) {
      const fn = ts.isVariableDeclaration(decl) && decl.initializer
        ? unwrap(decl.initializer)
        : decl;
      if (
        (ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        fn.body
      ) {
        // Same narrowing as the call path above: the markup-name check at the
        // top of this function is what a renderer passes on, and nothing else
        // gets the in-tree shortcut — `items.map(formatWhen)` is read through
        // its returns.
        return this.returnsSafely(fn, seen);
      }
    }
    return false;
  }

  /** The object literal a `const TABLE = { … }` was initialized with, if any. */
  private constObjectLiteral(id: ts.Identifier): ts.ObjectLiteralExpression | null {
    const decls = this.checker.getSymbolAtLocation(id)?.declarations ?? [];
    if (decls.length !== 1) return null;
    const decl = decls[0]!;
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return null;
    const init = unwrap(decl.initializer);
    return ts.isObjectLiteralExpression(init) ? init : null;
  }

  /** Are every `return` of this function, and its expression body, safe? */
  private returnsSafely(fn: ts.SignatureDeclaration, seen: Set<ts.Node>): boolean {
    const memo = this.functionVerdicts.get(fn);
    if (memo !== undefined) return memo;
    this.functionVerdicts.set(fn, true); // optimistic, for recursive renderers

    const body = (fn as ts.FunctionLikeDeclaration).body;
    let safe = true;
    if (!body) {
      safe = false;
    } else if (!ts.isBlock(body)) {
      safe = this.isSafe(body, seen);
    } else {
      const visit = (n: ts.Node): void => {
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
          return; // a nested function's returns are its own
        }
        if (ts.isReturnStatement(n) && n.expression && !this.isSafe(n.expression, seen)) {
          safe = false;
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(body, visit);
    }

    this.functionVerdicts.set(fn, safe);
    return safe;
  }

  /**
   * Types that cannot carry markup: numbers, booleans, dates, and unions whose
   * every constituent is a string LITERAL written in this source.
   */
  private hasNonMarkupType(node: ts.Expression): boolean {
    let type: ts.Type;
    try {
      type = this.checker.getTypeAtLocation(node);
    } catch {
      return false; // no type information is not evidence of safety
    }
    const constituents = type.isUnion() ? type.types : [type];
    if (constituents.length === 0) return false;
    return constituents.every((t) => {
      if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike)) {
        return true;
      }
      if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return true;
      if (t.isStringLiteral()) return !/[<>&"']/.test(t.value);
      return false;
    });
  }

  /**
   * Every expression that can be the value of a local `name`: its initializer,
   * plus later `name = …`, `name += …`, `name.push(…)`.
   *
   * Without this the scan is unusable — that tree composes a page out of dozens
   * of local fragments, and calling each one a bare hole would drown the real
   * findings in noise. `null` means "cannot see where this came from", which is
   * treated as unsafe.
   */
  private contributingExpressions(id: ts.Identifier): ts.Expression[] | null {
    const symbol = this.checker.getSymbolAtLocation(id);
    const decls = symbol?.declarations ?? [];
    if (decls.length === 0) return null;

    const out: ts.Expression[] = [];
    for (const decl of decls) {
      if (ts.isParameter(decl) || ts.isBindingElement(decl)) return null;
      if (!ts.isVariableDeclaration(decl)) return null;
      // `for (const x of xs)` binds an element, not an initializer.
      if (ts.isForOfStatement(decl.parent.parent) || ts.isForInStatement(decl.parent.parent)) {
        return null;
      }
      if (decl.initializer) out.push(decl.initializer);
    }

    // Later writes to the same symbol, within the declaring function or file.
    const scope = enclosingScopeOf(decls[0]!);
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left)) {
        const op = n.operatorToken.kind;
        if (
          (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken) &&
          this.checker.getSymbolAtLocation(n.left) === symbol
        ) {
          out.push(n.right);
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        (n.expression.name.text === 'push' || n.expression.name.text === 'unshift') &&
        this.checker.getSymbolAtLocation(n.expression.expression) === symbol
      ) {
        for (const arg of n.arguments) if (!ts.isSpreadElement(arg)) out.push(arg);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(scope, visit);

    return out.length > 0 ? out : null;
  }
}

function enclosingScopeOf(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

/**
 * Is this expression spliced INSIDE a single-quoted attribute?
 *
 * Read off the literal text immediately before the hole: an `='` with no
 * closing `'` after it means the value lands between single quotes. Only
 * `encodeURIComponent` cares — it is the one trusted escaper that leaves `'`
 * alone, so it is the one whose trust has to know where the value lands.
 *
 * A hole nested inside another expression has no literal text of its own; it
 * returns false there, which keeps today's behaviour for a shape the named
 * hole (`href='${encodeURIComponent(x)}'`) never takes.
 */
export function inSingleQuotedAttribute(node: ts.Node): boolean {
  // Walk out to the expression the template span actually holds.
  let current: ts.Node = node;
  while (current.parent && !ts.isTemplateSpan(current.parent)) current = current.parent;
  const span = current.parent;
  if (!span || !ts.isTemplateSpan(span) || span.expression !== current) return false;

  const template = span.parent;
  if (!ts.isTemplateExpression(template)) return false;
  const index = template.templateSpans.indexOf(span);
  const before =
    index === 0 ? template.head.text : template.templateSpans[index - 1]!.literal.text;

  // `="` or `='` — whichever quote opened last decides, and an unmatched `'`
  // is the only one that matters.
  const lastSingle = before.lastIndexOf("='");
  if (lastSingle === -1) return false;
  const rest = before.slice(lastSingle + 2);
  return !rest.includes("'");
}

/**
 * Does this template emit HTML? Two tells, and the second one is not optional.
 *
 * A TAG is the obvious one. But half the markup in this tree is built as
 * ATTRIBUTE FRAGMENTS — `` ` id="${x}" data-side="${y}"` `` — spliced into a
 * tag somewhere else. Requiring a `<` exempted that whole syntactic class:
 * those spans were never checked here, and where the fragment reached real
 * markup it arrived through a name the trusted list waved past, so it was
 * never checked there either. Both doors, same class.
 *
 * A CSS block, a shell command or a log line still has neither tell.
 */
function emitsHtml(node: ts.TemplateExpression): boolean {
  const text = node.getText();
  if (/<\/?[a-zA-Z][\w-]*[\s>/]/.test(text)) return true;
  // ` name="` / ` data-x='` — an attribute assignment in the literal text.
  return /[\s`][a-zA-Z][\w-]*\s*=\s*["']/.test(text);
}

/** Convenience for one-off use outside the test. */
export async function scanServerTree(root: string): Promise<BareInterpolation[]> {
  await readFile(join(root, 'tsconfig.json'), 'utf-8');
  return new HtmlInterpolationScanner(root).scan();
}
