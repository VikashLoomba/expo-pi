import { parse, type ParserPlugin } from '@babel/parser';

/** Module that installs `crypto.getRandomValues`, imported into Pi modules that call it. */
export const CRYPTO_BRIDGE_SPECIFIER = '@automatalabs/expo-pi/crypto';

const IMPORT_KEYWORD = 'import';
const UNSUPPORTED_IMPORT_HELPER = '__expoPiUnsupportedImport';

export interface RewriteResult {
  readonly code: string;
  /** Number of `import(specifier)` calls with a non-literal specifier that were replaced. */
  readonly variableImports: number;
  /** Whether the crypto bridge import was added. */
  readonly cryptoBridge: boolean;
}

interface AstNode {
  readonly type: string;
  readonly start?: number | null;
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

function parserPlugins(filename: string): ParserPlugin[] {
  if (/\.[cm]?tsx$/.test(filename)) return ['typescript', 'jsx'];
  if (/\.[cm]?ts$/.test(filename)) return ['typescript'];
  return [];
}

/**
 * Prepare a Pi module for a React Native bundle without changing its behavior on Hermes.
 *
 * - Metro rejects `import(specifier)` when the specifier isn't a literal, even in code that
 *   only runs on Node or Bun. Each such call is replaced with a function returning a rejected
 *   promise, so the module bundles and the desktop-only branch fails only if it ever runs.
 * - A module that calls `crypto.getRandomValues` gets an import of the crypto bridge.
 *
 * Positions are edited in place and helpers are appended, so line numbers are unchanged.
 */
export function rewritePiModule(source: string, filename: string): RewriteResult {
  const unchanged: RewriteResult = { code: source, variableImports: 0, cryptoBridge: false };
  if (!source.includes(IMPORT_KEYWORD) && !source.includes('getRandomValues')) return unchanged;

  let program: AstNode;
  try {
    program = parse(source, { sourceType: 'unambiguous', plugins: parserPlugins(filename) }).program;
  } catch {
    // Leave syntax errors for Metro's own transformer to report.
    return unchanged;
  }

  const importStarts: number[] = [];
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
    const children: [string, unknown][] = Object.entries(value);
    for (const [, child] of children) {
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
  if (importStarts.length === 0 && !usesGetRandomValues) return unchanged;

  let code = source;
  for (const start of importStarts.sort((a, b) => b - a)) {
    code = code.slice(0, start) + UNSUPPORTED_IMPORT_HELPER + code.slice(start + IMPORT_KEYWORD.length);
  }
  if (importStarts.length > 0) {
    code += `\nfunction ${UNSUPPORTED_IMPORT_HELPER}(specifier) {\n` +
      `  return Promise.reject(new Error("[expo-pi] Cannot load " + String(specifier) + ": " +\n` +
      `    "import() with a variable specifier is not available in React Native."));\n}\n`;
  }
  if (usesGetRandomValues) {
    const isModule = 'sourceType' in program && program.sourceType === 'module';
    code += isModule
      ? `\nimport ${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)};\n`
      : `\nrequire(${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)});\n`;
  }
  return { code, variableImports: importStarts.length, cryptoBridge: usesGetRandomValues };
}
