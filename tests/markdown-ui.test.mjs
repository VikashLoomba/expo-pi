import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// React executes the production components. Only native host views and platform
// APIs are substituted; these checks do not claim Yoga, gestures, or native a11y.
const require = createRequire(import.meta.url);
const sourceRoot = new URL('../src/', import.meta.url).href;
const reactUrl = pathToFileURL(require.resolve('react')).href;
const fixtureKey = '__piMarkdownUIFixture';
const fixture = {
  hosts: [], scheme: 'light', fontScale: 1, copied: [], opened: [], alerts: [],
  clipboardFailure: false, linkFailure: false,
};
globalThis[fixtureKey] = fixture;

const nativeHostSource = `
  import { createElement } from ${JSON.stringify(reactUrl)};
  const state = globalThis.${fixtureKey};
  const host = (name, tag) => (props) => {
    state.hosts.push({ name, props });
    return createElement(tag, { 'data-native': name }, props.children);
  };
  export const Text = host('Text', 'span');
  export const View = host('View', 'div');
  export const ScrollView = host('ScrollView', 'div');
  export const Pressable = host('Pressable', 'button');
  export const Platform = { OS: 'ios', select: (value) => value.ios ?? value.default };
  export const StyleSheet = { create: (value) => value, hairlineWidth: 0.5 };
  export const useColorScheme = () => state.scheme;
  export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: state.fontScale });
  export const Alert = { alert: (...args) => state.alerts.push(args) };
`;
const mocks = {
  'react-native': nativeHostSource,
  'expo-symbols': 'export const SymbolView = () => null;',
  'expo-clipboard': `export async function setStringAsync(value) {
    const state = globalThis.${fixtureKey};
    if (state.clipboardFailure) throw new Error('Clipboard failure');
    state.copied.push(value); return true;
  }`,
  'expo-linking': `export async function openURL(value) {
    const state = globalThis.${fixtureKey};
    if (state.linkFailure) throw new Error('Link failure');
    state.opened.push(value);
  }`,
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return { shortCircuit: true, url: `markdown-ui:${specifier}` };
    if (context.parentURL?.startsWith(sourceRoot) && (specifier.startsWith('.') || specifier.startsWith('@/'))) {
      const url = specifier.startsWith('@/') ? new URL(specifier.slice(2), sourceRoot) : new URL(specifier, context.parentURL);
      for (const extension of ['', '.ts', '.tsx']) {
        const candidate = new URL(url.href + extension);
        if (existsSync(candidate)) return { shortCircuit: true, url: candidate.href };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('markdown-ui:')) return { shortCircuit: true, format: 'module', source: mocks[url.slice('markdown-ui:'.length)] };
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(url)) return {
      shortCircuit: true, format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: new URL(url).pathname,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { MessageContent } = await import('../src/components/chat/message-content.tsx');
const { openExternalLink } = await import('../src/components/chat/source-link.ts');
hooks.deregister();
test.after(() => { delete globalThis[fixtureKey]; });

function render(text, { scheme = 'light', fontScale = 1, citations = [], streaming = false } = {}) {
  Object.assign(fixture, { hosts: [], scheme, fontScale });
  const html = renderToStaticMarkup(createElement(MessageContent, { text, citations, streaming }));
  const visible = html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
  return { html, visible, hosts: fixture.hosts };
}

const flattenedStyle = (value) => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const flushActions = () => new Promise((resolve) => setImmediate(resolve));

test('Markdown renders as native formatted content, recursive lists, and one aligned table', () => {
  const text = '# Overview\n\n**Bold _inside_** and ~~obsolete~~.\n\n> Quoted\n>\n> - nested\n\n3. Third\n4. Fourth\n\n- [x] Completed\n- [ ] Pending\n\n---\n\n```js\nconst value = 42;\n```\n\n| Name | Count |\n| :--- | ---: |\n| **Alpha** | 42 |\n| a\\|b | 7 |';
  const { visible, hosts } = render(text);
  for (const value of ['Overview', 'Bold inside', 'obsolete', 'Quoted', 'nested', '3.', '4.', 'Completed', 'Pending', 'const value = 42;', 'Name', 'Count', 'Alpha', 'a|b']) {
    assert.ok(visible.includes(value), `Expected rendered ${value}`);
  }
  for (const syntax of ['**', '~~', '```', '| :---', '[x]', '[ ]']) assert.ok(!visible.includes(syntax), `Leaked Markdown: ${syntax}`);
  assert.ok(hosts.some(({ props }) => props.role === 'list'));
  assert.equal(hosts.filter(({ props }) => props.accessibilityRole === 'header' && !props.accessibilityHint).length, 1);
  const grids = hosts.filter(({ props }) => props.accessibilityRole === 'grid');
  assert.equal(grids.length, 1);
  assert.equal(grids[0].props.horizontal, true);
  assert.equal(grids[0].props.accessible, undefined, 'The table must not group away interactive cell links');
  assert.equal(typeof grids[0].props.onLayout, 'function');
  const cells = hosts.filter(({ props }) => props.accessibilityHint?.includes('column'));
  assert.equal(cells.length, 6);
  assert.ok(cells.every(({ props }) => props.selectable));
  assert.equal(cells.filter(({ props }) => props.accessibilityRole === 'header').length, 2);
  assert.deepEqual(cells.map(({ props }) => flattenedStyle(props.style).textAlign), ['left', 'right', 'left', 'right', 'left', 'right']);
  const nested = hosts.find(({ props }) => props.children === 'inside');
  assert.equal(flattenedStyle(nested.props.style).fontWeight, '600');
  assert.equal(flattenedStyle(nested.props.style).fontStyle, 'italic');
});

test('tables retain theme contrast and shared column widths at enlarged text size', () => {
  const source = '| Name | Value |\n| --- | --- |\n| Alpha | 42 |';
  const appearance = (options) => {
    const { hosts } = render(source, options);
    const cells = hosts.filter(({ name, props }) => name === 'View' && flattenedStyle(props.style).borderRightColor);
    const header = hosts.find(({ props }) => props.accessibilityHint === 'Header, column 1');
    const grid = hosts.find(({ props }) => props.accessibilityRole === 'grid');
    return { widths: cells.map(({ props }) => flattenedStyle(props.style).width), color: flattenedStyle(header.props.style).color,
      border: flattenedStyle(cells[0].props.style).borderRightColor, width: grid.props.contentContainerStyle.width };
  };
  const light = appearance({ scheme: 'light' });
  const dark = appearance({ scheme: 'dark' });
  const enlarged = appearance({ fontScale: 2 });
  assert.notEqual(light.color, dark.color);
  assert.notEqual(light.border, dark.border);
  assert.equal(new Set(enlarged.widths).size, 1, 'Headers and body cells must share widths');
  assert.ok(enlarged.width > light.width, 'Large text gets more horizontal room rather than clipped rows');
});

test('table citations and ordinary links preserve composed formatting and use the safe opener', async () => {
  const source = '| Source | Detail |\n| --- | --- |\n| [**Docs**](https://example.com/docs) | Cited evidence |';
  const startIndex = source.indexOf('Cited evidence');
  const citation = { id: 'table-source', number: 1, url: 'https://example.com/source', title: 'Evidence source', startIndex, endIndex: startIndex + 'Cited evidence'.length };
  fixture.opened = [];
  fixture.alerts = [];
  const { hosts, visible } = render(source, { citations: [citation] });
  assert.ok(visible.includes('DocsCited evidence'));
  const links = hosts.filter(({ props }) => props.accessibilityRole === 'link');
  assert.equal(links.length, 2);
  const docs = links.find(({ props }) => props.children === 'Docs');
  assert.equal(flattenedStyle(docs.props.style).fontWeight, '600');
  assert.ok(links.some(({ props }) => props.accessibilityLabel === 'Citation 1, Evidence source'));
  for (const { props } of links) props.onPress();
  await flushActions();
  assert.deepEqual(fixture.opened, ['https://example.com/docs', 'https://example.com/source']);
  await openExternalLink('javascript:alert(1)');
  await openExternalLink('https://user:pass@example.com/');
  assert.equal(fixture.opened.length, 2, 'Unsafe destinations never reach the platform opener');
  fixture.linkFailure = true;
  await openExternalLink('https://example.com/');
  fixture.linkFailure = false;
  assert.equal(fixture.alerts[0][0], 'Could not open link');
});

test('code copy sends the original code to Expo Clipboard and reports failures', async (t) => {
  // Server rendering does not mount effects, so do not leave the feedback timer alive.
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const code = 'const value = "**literal** | table?";\nconsole.log(value);';
  fixture.copied = [];
  fixture.alerts = [];
  const { hosts } = render(`\`\`\`typescript\n${code}\n\`\`\``);
  const copy = hosts.find(({ props }) => props.accessibilityLabel === 'Copy code');
  assert.ok(copy);
  copy.props.onPress();
  await flushActions();
  assert.deepEqual(fixture.copied, [code]);
  fixture.clipboardFailure = true;
  copy.props.onPress();
  await flushActions();
  fixture.clipboardFailure = false;
  assert.equal(fixture.alerts[0][0], 'Could not copy');
});
