import assert from 'node:assert/strict';
import test from 'node:test';

import { createMarkdownParser, parseInline } from '../src/components/chat/streaming-markdown.ts';

const parse = (text, streaming = true) => createMarkdownParser()(text, streaming);
const visible = (tokens) => tokens.map(({ text }) => text).join('');

test('a partial next list item never turns preceding list items into a paragraph', () => {
  const parser = createMarkdownParser();
  const first = parser('- First\n- Second\n', true);
  const partial = parser('- First\n- Second\n-', true);
  assert.equal(partial[0], first[0]);
  assert.deepEqual(partial.map(({ kind, text }) => [kind, text]), [['list-item', 'First'], ['list-item', 'Second']]);
  const more = parser('- First\n- Second\n- Third\nA closing paragraph.', true);
  assert.deepEqual(more.map(({ kind }) => kind), ['list-item', 'list-item', 'list-item', 'paragraph']);
  assert.equal(more[0], first[0]);
  assert.equal(more[1], first[1]);
});

test('headings and lists remain formatted without blank lines between them', () => {
  assert.deepEqual(parse('# Overview\nParagraph\n1. First\n2. Second\n  continued\n## Next').map(({ kind, text }) => [kind, text]), [
    ['heading', 'Overview'], ['paragraph', 'Paragraph'], ['list-item', 'First'], ['list-item', 'Second\ncontinued'], ['heading', 'Next'],
  ]);
});

test('code starts before the opening line finishes and closing fence fragments stay hidden', () => {
  const parser = createMarkdownParser();
  const start = parser('```typescript', true);
  assert.deepEqual(start, [{ key: 0, kind: 'code', language: 'typescript', text: '' }]);
  const code = '```typescript\nconst answer = 42;\n';
  const shown = parser(code, true)[0];
  for (const ending of ['`', '``', '```']) {
    const block = parser(code + ending, true)[0];
    assert.equal(block, shown, `closing ${ending} does not change the code block`);
  }
  assert.equal(parser(code + '```', false)[0], shown, 'completion preserves the same finished view');
  assert.equal(parse('```js\nconst marker = "```";\n```')[0].text, 'const marker = "```";');
});

test('a possible closing fence becomes literal code if more text follows it', () => {
  const parser = createMarkdownParser();
  parser('```\ntext\n```', true);
  assert.equal(parser('```\ntext\n```suffix', true)[0].text, 'text\n```suffix');
  assert.equal(parse('~~~python\nprint(1)\n~~~')[0].text, 'print(1)');
});

test('an invalidated provisional opening fence rejoins its preceding paragraph', () => {
  const parser = createMarkdownParser();
  parser('Intro\n```js', true);
  assert.deepEqual(parser('Intro\n```js```', true), [
    { key: 0, kind: 'paragraph', text: 'Intro\n```js```' },
  ]);
});

test('finished blocks retain identity while only the last paragraph grows', () => {
  const parser = createMarkdownParser();
  const initial = parser('Intro **bold**.\n\n- First\n- Second\n\n```js\n42\n```\n\nLive', true);
  const next = parser('Intro **bold**.\n\n- First\n- Second\n\n```js\n42\n```\n\nLive paragraph', true);
  for (let index = 0; index < initial.length - 1; index++) assert.equal(next[index], initial[index]);
  assert.notEqual(next.at(-1), initial.at(-1));
  const finished = parser('Intro **bold**.\n\n- First\n- Second\n\n```js\n42\n```\n\nLive paragraph', false);
  finished.forEach((block, index) => assert.equal(block, next[index]));
});

test('incremental parsing equals a fresh parse at every token boundary and after rewinds', () => {
  const samples = [
    '# Title\n\nA **bold** answer and [docs](https://example.com).\n\n- First\n- Second\n  continued\n\nEnd.',
    'Intro\n```typescript\nconst x = `literal`;\n\nconsole.log(x);\n```\n\nDone',
    '1. Numbered\n2. Next\n\n### Heading\nText\r\n\r\n~~~\r\ncode\r\n~~~',
    'Plain text\n#maybe not a heading\n1 is a number\n-1 is negative\n*** literal',
    'Intro\n```js```\nAn invalid fence opening stays ordinary text.',
  ];
  for (const text of samples) {
    const parser = createMarkdownParser();
    for (let end = 1; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      assert.deepEqual(parser(prefix, true), parse(prefix), JSON.stringify(prefix));
    }
    assert.deepEqual(parser(text, false), parse(text, false));
    assert.deepEqual(parser('A replacement', true), parse('A replacement'));
    assert.deepEqual(parser('', false), []);
  }
});

test('partial bold, emphasis and inline code are formatted before their closer arrives', () => {
  for (const [open, close, kind] of [['**', '**', 'strong'], ['*', '*', 'emphasis'], ['`', '`', 'code']]) {
    const partial = parseInline(`Before ${open}word`, true);
    const finished = parseInline(`Before ${open}word${close}`, false);
    assert.equal(partial.at(-1).kind, kind);
    assert.deepEqual(partial, finished);
  }
  assert.equal(visible(parseInline('**word*', true)), 'word');
  assert.equal(visible(parseInline('Before **', true)), 'Before ');
  assert.equal(visible(parseInline('`**literal**`', true)), '**literal**');
});

test('partial links render their label, never a growing URL that disappears at completion', () => {
  for (const text of ['See [Docs', 'See [Docs]', 'See [Docs](', 'See [Docs](https://example.com']) {
    const tokens = parseInline(text, true);
    assert.equal(visible(tokens), 'See Docs');
    assert.equal(tokens.at(-1).kind, 'link');
    assert.equal(tokens.at(-1).href, undefined);
  }
  assert.equal(parseInline('See [Docs](https://example.com/path_(part))', false).at(-1).href, 'https://example.com/path_(part)');
  assert.equal(visible(parseInline('[unsafe](javascript:alert(1))', false)), '[unsafe](javascript:alert(1))');
});

test('literal escapes and unmatched completed syntax remain readable', () => {
  assert.equal(visible(parseInline('Use \\*literal\\* and snake_case.', false)), 'Use *literal* and snake_case.');
  assert.equal(visible(parseInline('Unclosed **word', false)), 'Unclosed **word');
  assert.equal(visible(parseInline('A [bracket] note.', false)), 'A [bracket] note.');
  assert.equal(parse('1', false)[0].text, '1');
});
