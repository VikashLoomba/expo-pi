import { parse, type ParserPlugin } from '@babel/parser';

/** Module that installs `crypto.getRandomValues`, imported into Pi modules that call it. */
export const CRYPTO_BRIDGE_SPECIFIER = '@automatalabs/expo-pi/crypto';

const IMPORT_KEYWORD = 'import';
const UNSUPPORTED_IMPORT_HELPER = '__expoPiUnsupportedImport';
const CHORD_JSON_MODULE = /(?:^|\/)(?:@earendil-works\/)?chord\/(?:dist\/json\.js|src\/json\.ts)$/;

export interface RewriteResult {
  readonly code: string;
  /** Number of `import(specifier)` calls with a non-literal specifier that were replaced. */
  readonly variableImports: number;
  /** Whether the crypto bridge import was added. */
  readonly cryptoBridge: boolean;
  /** Chord array descriptor indices explicitly converted to property-key strings. */
  readonly descriptorKeys: number;
}

interface AstNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

// Metro resolves string-literal specifiers at build time, so those are left alone.
function isStaticSpecifier(value: unknown): boolean {
  if (!isAstNode(value)) return false;
  if (value.type === 'StringLiteral') return true;
  return value.type === 'TemplateLiteral' && 'expressions' in value &&
    Array.isArray(value.expressions) && value.expressions.length === 0;
}

function variableImportStart(node: AstNode): number | undefined {
  // `import(x)` parses as a CallExpression with an Import callee, or as an
  // ImportExpression when the parser's createImportExpressions option is on.
  if (node.type === 'CallExpression' && 'callee' in node && isAstNode(node.callee) &&
      node.callee.type === 'Import' && 'arguments' in node && Array.isArray(node.arguments) &&
      !isStaticSpecifier(node.arguments[0])) {
    return node.callee.start ?? undefined;
  }
  if (node.type === 'ImportExpression' && 'source' in node && !isStaticSpecifier(node.source)) {
    return node.start ?? undefined;
  }
  return undefined;
}

function isGetRandomValuesAccess(node: AstNode): boolean {
  return (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
    'property' in node && isAstNode(node.property) && node.property.type === 'Identifier' &&
    'name' in node.property && node.property.name === 'getRandomValues';
}

function isIdentifier(node: unknown, name: string): node is AstNode {
  return isAstNode(node) && node.type === 'Identifier' && 'name' in node && node.name === name;
}

// Hermes can forward numeric descriptor keys to Proxy traps without ToPropertyKey.
// Chord's copyJson loop uses a numeric `index`, but its tracked-array trap accepts
// string indices. Match only this known call; symbolic object keys stay untouched.
function chordDescriptorEdit(node: AstNode): Edit | undefined {
  if (node.type !== 'CallExpression' || !('callee' in node) || !isAstNode(node.callee) ||
      node.callee.type !== 'MemberExpression' || !('object' in node.callee) ||
      !isIdentifier(node.callee.object, 'Object') || !('property' in node.callee) ||
      !isIdentifier(node.callee.property, 'getOwnPropertyDescriptor') ||
      ('computed' in node.callee && node.callee.computed) ||
      !('arguments' in node) || !Array.isArray(node.arguments) || node.arguments.length !== 2 ||
      !isIdentifier(node.arguments[0], 'value') || !isIdentifier(node.arguments[1], 'index')) return undefined;
  const { start, end } = node.arguments[1];
  return start == null || end == null ? undefined : { start, end, replacement: 'String(index)' };
}

function parserPlugins(filename: string): ParserPlugin[] {
  if (/\.[cm]?tsx$/.test(filename)) return ['typescript', 'jsx'];
  if (/\.[cm]?ts$/.test(filename)) return ['typescript'];
  return [];
}

/**
 * Prepare a Pi module for a Metro client bundle without changing its portable code paths.
 *
 * - Metro rejects `import(specifier)` when the specifier isn't a literal, even in code that
 *   only runs on Node or Bun. Each such call is replaced with a function returning a rejected
 *   promise, so the module bundles and the desktop-only branch fails only if it ever runs.
 * - A module that calls `crypto.getRandomValues` gets an import of the crypto bridge.
 * - Chord's JSON copier passes string array indices to descriptor lookups, avoiding a
 *   Hermes Proxy property-key bug when recovering a durable partial response.
 *
 * Positions are edited in place and helpers are appended, so line numbers are unchanged.
 */
export function rewritePiModule(source: string, filename: string): RewriteResult {
  const unchanged: RewriteResult = { code: source, variableImports: 0, cryptoBridge: false, descriptorKeys: 0 };
  const normalizeChordIndices = CHORD_JSON_MODULE.test(filename.replace(/\\/g, '/')) &&
    source.includes('getOwnPropertyDescriptor');
  if (!source.includes(IMPORT_KEYWORD) && !source.includes('getRandomValues') && !normalizeChordIndices) return unchanged;

  let program: AstNode;
  try {
    program = parse(source, { sourceType: 'unambiguous', plugins: parserPlugins(filename) }).program;
  } catch {
    // Leave syntax errors for Metro's own transformer to report.
    return unchanged;
  }

  const importStarts: number[] = [];
  const descriptorEdits: Edit[] = [];
  let usesGetRandomValues = false;
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isAstNode(value)) continue;
    const start = variableImportStart(value);
    if (start !== undefined && source.startsWith(IMPORT_KEYWORD, start)) importStarts.push(start);
    if (isGetRandomValuesAccess(value)) usesGetRandomValues = true;
    if (normalizeChordIndices) {
      const edit = chordDescriptorEdit(value);
      if (edit !== undefined) descriptorEdits.push(edit);
    }
    const children: [string, unknown][] = Object.entries(value);
    for (const [, child] of children) {
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
  if (importStarts.length === 0 && !usesGetRandomValues && descriptorEdits.length === 0) return unchanged;

  let code = source;
  const edits = [...descriptorEdits, ...importStarts.map((start) => ({
    start, end: start + IMPORT_KEYWORD.length, replacement: UNSUPPORTED_IMPORT_HELPER,
  }))];
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  }
  if (importStarts.length > 0) {
    code += `\nfunction ${UNSUPPORTED_IMPORT_HELPER}(specifier) {\n` +
      `  return Promise.reject(new Error("[expo-pi] Cannot load " + String(specifier) + ": " +\n` +
      `    "import() with a variable specifier is not available in this Metro client bundle."));\n}\n`;
  }
  if (usesGetRandomValues) {
    const isModule = 'sourceType' in program && program.sourceType === 'module';
    code += isModule
      ? `\nimport ${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)};\n`
      : `\nrequire(${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)});\n`;
  }
  return { code, variableImports: importStarts.length, cryptoBridge: usesGetRandomValues,
    descriptorKeys: descriptorEdits.length };
}
