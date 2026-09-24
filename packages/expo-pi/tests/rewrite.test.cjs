const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rewritePiModule, CRYPTO_BRIDGE_SPECIFIER } = require('../build/rewrite.cjs');

const CRYPTO_IMPORT = `import ${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)};`;

test('replaces import() calls with a variable specifier', () => {
  const source = 'export const load = (specifier) => import(rewrite(specifier));\n';
  const result = rewritePiModule(source, 'load.js');
  assert.equal(result.variableImports, 1);
  assert.match(result.code, /__expoPiUnsupportedImport\(rewrite\(specifier\)\)/);
  assert.match(result.code, /function __expoPiUnsupportedImport\(specifier\)/);
  assert.doesNotMatch(result.code.split('\n')[0], /\bimport\(/);
});
test('replaces template specifiers with expressions and calls with import options', () => {
  const source = 'export const a = (name) => import(`./${name}.js`);\nexport const b = (s) => import(s, { with: { type: "json" } });\n';
  assert.equal(rewritePiModule(source, 'x.js').variableImports, 2);
});
test('leaves literal specifiers alone, which Metro resolves normally', () => {
  const source = 'export const a = () => import("./a.js");\nexport const b = () => import(`./b.js`);\n';
  const result = rewritePiModule(source, 'x.js');
  assert.equal(result.code, source);
  assert.equal(result.variableImports, 0);
});
test('ignores methods named import and text that only mentions import()', () => {
  const source = 'export const a = (loader, s) => loader.import(s);\n// import(specifier) in a comment\nexport const b = "import(x)";\n';
  assert.equal(rewritePiModule(source, 'x.js').code, source);
});
test('keeps every original line at the same line number', () => {
  const source = 'const a = 1;\nconst load = (s) =>\n  import(s);\nexport { a, load };\n';
  const lines = rewritePiModule(source, 'x.js').code.split('\n');
  assert.equal(lines[0], 'const a = 1;');
  assert.equal(lines[2], '  __expoPiUnsupportedImport(s);');
  assert.equal(lines[3], 'export { a, load };');
});
test('a replaced call rejects with a clear error only when it runs', async () => {
  const source = 'module.exports = (specifier) => import(specifier);\n';
  const result = rewritePiModule(source, 'load.cjs');
  const module = { exports: {} };
  new Function('module', result.code)(module);
  await assert.rejects(module.exports('./desktop-flow.js'), /\[expo-pi\] Cannot load \.\/desktop-flow\.js/);
});
test('adds the crypto bridge to ES modules that call crypto.getRandomValues', () => {
  for (const call of ['crypto.getRandomValues(bytes)', 'globalThis.crypto.getRandomValues(bytes)', 'globalThis.crypto?.getRandomValues(bytes)']) {
    const result = rewritePiModule(`export function id(bytes) { ${call}; return bytes; }\n`, 'uuid.js');
    assert.equal(result.cryptoBridge, true, call);
    assert.ok(result.code.trimEnd().endsWith(CRYPTO_IMPORT), call);
  }
});
test('adds the crypto bridge to CommonJS modules with require', () => {
  const result = rewritePiModule('module.exports = (b) => crypto.getRandomValues(b);\n', 'uuid.cjs');
  assert.ok(result.code.trimEnd().endsWith(`require(${JSON.stringify(CRYPTO_BRIDGE_SPECIFIER)});`));
});
test('does not add the crypto bridge for a mere mention of getRandomValues', () => {
  const source = 'export const doc = "uses getRandomValues";\n';
  assert.equal(rewritePiModule(source, 'x.js').code, source);
});
test('parses TypeScript sources from a Pi source workspace', () => {
  const source = 'export const load = (specifier: string): Promise<unknown> => import(specifier);\n';
  assert.equal(rewritePiModule(source, 'load.ts').variableImports, 1);
});
test('returns unrelated and unparsable sources unchanged', () => {
  for (const source of ['export const x = 1;\n', 'export const = import(;']) {
    assert.equal(rewritePiModule(source, 'x.js').code, source);
  }
});

function jsFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) jsFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}
// Pi's packages don't export package.json, so look them up as Node's resolution would.
function packageDirectory(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed`);
  }
}
test('every module of the installed Pi packages bundles: no variable import() is left', () => {
  const core = packageDirectory('@earendil-works/pi-agent-core', __dirname);
  const ai = packageDirectory('@earendil-works/pi-ai', core);
  const changed = new Map();
  for (const root of [core, ai]) {
    for (const file of jsFiles(path.join(root, 'dist'))) {
      const result = rewritePiModule(fs.readFileSync(file, 'utf8'), file);
      assert.equal(rewritePiModule(result.code, file).variableImports, 0, file);
      if (result.variableImports || result.cryptoBridge) changed.set(path.relative(root, file), result);
    }
  }
  for (const file of ['dist/auth/context.js', 'dist/auth/oauth/load.js', 'dist/env-api-keys.js']) {
    assert.ok(changed.get(file)?.variableImports > 0, file);
  }
  assert.equal(changed.get('dist/utils/uuid.js')?.cryptoBridge, true);
});
