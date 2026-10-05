/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
test('normalizes only Chord JSON numeric index descriptors, preserving line numbers and other keys', () => {
  const source = 'export const load = (s) => import(s);\n' +
    'const descriptor = Object.getOwnPropertyDescriptor(value, index);\n' +
    'const other = Object.getOwnPropertyDescriptor(value, key);\n' +
    'const symbol = Object.getOwnPropertyDescriptor(value, Symbol.iterator);\n';
  for (const file of ['node_modules/@earendil-works/chord/dist/json.js', 'packages/chord/src/json.ts']) {
    const result = rewritePiModule(source, file);
    assert.equal(result.descriptorKeys, 1);
    assert.equal(result.variableImports, 1);
    const lines = result.code.split('\n');
    assert.equal(lines[1], 'const descriptor = Object.getOwnPropertyDescriptor(value, String(index));');
    assert.equal(lines[2], source.split('\n')[2]);
    assert.equal(lines[3], source.split('\n')[3]);
    assert.equal(rewritePiModule(result.code, file).descriptorKeys, 0);
  }
  for (const file of ['json.js', 'node_modules/other/dist/json.js', 'node_modules/@earendil-works/chord/dist/other.js']) {
    const result = rewritePiModule(source, file);
    assert.equal(result.descriptorKeys, 0);
    assert.equal(result.code.split('\n')[1], source.split('\n')[1]);
  }
});

test('copies real Chord tracked arrays when Hermes forwards numeric descriptor keys to the proxy', async () => {
  const chord = packageDirectory('@earendil-works/chord', __dirname);
  const filename = path.join(chord, 'dist/json.js');
  const source = fs.readFileSync(filename, 'utf8');
  const { track } = await import(pathToFileURL(path.join(chord, 'dist/delta/tracker.js')).href);
  const initial = { content: [{ type: 'text', text: 'Persisted partial' }], nested: [[1, true, null]] };
  const change = track(initial).beginChange();
  const draft = change.state;
  const arrays = new WeakSet([draft.content, draft.nested, draft.nested[0]]);
  const hermesObject = new Proxy(Object, {
    get(target, key) {
      if (key !== 'getOwnPropertyDescriptor') return Reflect.get(target, key);
      return (value, property) => {
        // Hermes passes a number into the proxy trap; Chord's arrayIndex accepts
        // string property keys only, so its descriptor trap returns undefined.
        if (arrays.has(value) && typeof property === 'number') return undefined;
        return Object.getOwnPropertyDescriptor(value, property);
      };
    },
  });
  const loadCopy = (code) => new Function('Object', code.replace(/^export /gm, '') + '\nreturn copyJson;')(hermesObject);
  try {
    assert.throws(() => loadCopy(source)(draft), /enumerable indexed data properties/);
    const result = rewritePiModule(source, filename);
    assert.equal(result.descriptorKeys, 1);
    const copyJson = loadCopy(result.code);
    const copied = copyJson(draft);
    assert.deepEqual(copied, initial);
    draft.content[0].text = 'Later update';
    assert.equal(copied.content[0].text, 'Persisted partial');
    assert.throws(() => copyJson({ [Symbol('hidden')]: 'value' }), /symbol key/);
    assert.throws(() => copyJson(new Array(1)), /dense plain arrays/);
    assert.throws(() => copyJson([undefined]), /non-JSON undefined/);
    assert.throws(() => copyJson(Object.defineProperty([], '0', { get: () => 1, enumerable: true })), /indexed data properties/);
  } finally {
    change.abort();
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
test('rewrites every installed Pi module without leaving variable import() calls', () => {
  const core = packageDirectory('@earendil-works/pi-agent-core', __dirname);
  const ai = packageDirectory('@earendil-works/pi-ai', core);
  const durable = packageDirectory('@earendil-works/pi-durable', __dirname);
  const chord = packageDirectory('@earendil-works/chord', durable);
  const changed = new Map();
  for (const root of [core, ai, durable, chord]) {
    for (const file of jsFiles(path.join(root, 'dist'))) {
      const result = rewritePiModule(fs.readFileSync(file, 'utf8'), file);
      assert.equal(rewritePiModule(result.code, file).variableImports, 0, file);
      assert.equal(rewritePiModule(result.code, file).descriptorKeys, 0, file);
      if (result.variableImports || result.cryptoBridge || result.descriptorKeys) changed.set(path.relative(root, file), result);
    }
  }
  for (const file of ['dist/auth/context.js', 'dist/auth/oauth/load.js', 'dist/env-api-keys.js']) {
    assert.ok(changed.get(file)?.variableImports > 0, file);
  }
  assert.equal(changed.get('dist/utils/uuid.js')?.cryptoBridge, true);
  assert.equal(changed.get('dist/json.js')?.descriptorKeys, 1);
});
