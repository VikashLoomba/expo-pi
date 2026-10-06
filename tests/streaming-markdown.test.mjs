import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../src/', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.startsWith(sourceRoot) || !specifier.startsWith('.')) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
const { createMarkdownParser } = await import('../src/components/chat/markdown/streaming-parser.ts');
hook.deregister();
const parse = (text, streaming = true) => createMarkdownParser()(text, streaming);
const visible = (fragment) => fragment.runs.map(({ text }) => text).join('');
const inline = (text, streaming = true) => parse(text, streaming)[0]?.content;
const show = (blocks) => blocks.map((block) => block.kind === 'paragraph' || block.kind === 'heading' ? visible(block.content)
  : block.kind === 'list' ? block.items.map((item) => show(item.blocks)).join('\n') : block.kind === 'code' ? block.text : '').join('\n');

test('a partial next list marker never replaces preceding list items', () => {
  const parser = createMarkdownParser();
  const first = parser('- First\n- Second\n', true);
  const partial = parser('- First\n- Second\n-', true);
  assert.equal(partial[0], first[0]);
  assert.equal(show(partial), 'First\nSecond');
  const more = parser('- First\n- Second\n- Third\n\nA closing paragraph.', true);
  assert.deepEqual(more.map(({ kind }) => kind), ['list', 'paragraph']);
  assert.equal(more[0].items[0], first[0].items[0]);
  assert.equal(more[0].items[1], first[0].items[1]);
});

test('heading/list boundaries follow CommonMark, including lazy list continuation', () => {
  const blocks = parse('# Overview\nParagraph\n1. First\n2. Second\n  continued\n## Next');
  assert.deepEqual(blocks.map(({ kind }) => kind), ['heading', 'paragraph', 'list', 'heading']);
  assert.equal(show(blocks[2].items[1].blocks), 'Second\ncontinued');
  assert.equal(show(parse('- First\nA lazy continuation.', false)), 'First\nA lazy continuation.');
});

test('code starts before opening line finishes and closing fence fragments stay hidden', () => {
  const parser = createMarkdownParser();
  assert.deepEqual(parser('```typescript', true), [{ key: 0, kind: 'code', language: 'typescript', text: '' }]);
  const code = '```typescript\nconst answer = 42;\n';
  const shown = parser(code, true)[0];
  for (const ending of ['`', '``', '```']) assert.equal(parser(code + ending, true)[0], shown);
  assert.equal(parser(code + '```', false)[0], shown);
  assert.equal(parse('```js\nconst marker = "```";\n```')[0].text, 'const marker = "```";');
});

test('a provisional closing fence can become literal code', () => {
  const parser = createMarkdownParser();
  parser('```\ntext\n```', true);
  assert.equal(parser('```\ntext\n```suffix', true)[0].text, 'text\n```suffix');
  assert.equal(parse('~~~python\nprint(1)\n~~~')[0].text, 'print(1)');
});

test('an invalidated opening fence rejoins preceding prose without stale blocks', () => {
  const parser = createMarkdownParser();
  parser('Intro\n```js', true);
  assert.deepEqual(parser('Intro\n```js```', true), parse('Intro\n```js```'));
  assert.equal(parser('Intro\n```js```', true).length, 1);
});

test('finished blocks retain identity while live content grows and finalizes', () => {
  const parser = createMarkdownParser();
  const prefix = 'Intro **bold**.\n\n- First\n- Second\n\n```js\n42\n```\n\n';
  const initial = parser(prefix + 'Live', true);
  const next = parser(prefix + 'Live paragraph', true);
  for (let i = 0; i < initial.length - 1; i++) assert.equal(next[i], initial[i]);
  assert.notEqual(next.at(-1), initial.at(-1));
  parser(prefix + 'Live paragraph', false).forEach((block, i) => assert.equal(block, next[i]));
});

test('fresh and cached parsing agree at every boundary, completion, rewind and replacement', () => {
  const samples = [
    '# Title\n\nA **bold _nested_** answer and [docs](https://example.com).\n\n- First\n- Second\n  continued\n\nEnd.',
    'Intro\n```typescript\nconst x = `literal`;\n\nconsole.log(x);\n```\n\nDone',
    '1. Numbered\n2. Next\n\n### Heading\nText\r\n\r\n~~~\r\ncode\r\n~~~',
    'Plain text\n#maybe not a heading\n1 is a number\n-1 is negative\n*** literal',
    'Intro\n```js```\nAn invalid fence opening stays prose.',
    '| 🌍 Name | Value |\r\n| :--- | ---: |\r\n| **Alpha** | `a\\|b` |\r\n| Beta | [Docs](https://example.com) |\n\nDone',
    'See [Docs][ref].\n\n[ref]: https://example.com\n\nEnd',
    '> A **quote**\n>\n> - Nested\n> - List\n\nEnd',
  ];
  for (const text of samples) {
    const parser = createMarkdownParser();
    for (let end = 1; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      assert.deepEqual(parser(prefix, true), parse(prefix), JSON.stringify(prefix));
    }
    assert.deepEqual(parser(text, false), parse(text, false));
    const immutable = JSON.stringify(parser(text, false));
    assert.deepEqual(parser(text.slice(0, 5), true), parse(text.slice(0, 5)));
    assert.deepEqual(parser('A replacement', true), parse('A replacement'));
    assert.deepEqual(parser(text, false), parse(text, false));
    assert.equal(JSON.stringify(parser(text, false)), immutable);
    assert.deepEqual(parser('', false), []);
  }
});

test('unclosed inline delimiters format provisionally and source text remains original', () => {
  for (const [open, mark] of [['**', 'strong'], ['*', 'emphasis'], ['`', 'code'], ['``', 'code']]) {
    const text = `Before ${open}word`;
    const partial = inline(text);
    const finished = inline(text + open, false);
    assert.equal(visible(partial), visible(finished));
    assert.deepEqual(partial.runs.at(-1).marks, [mark]);
    assert.equal(partial.sourceText, text);
  }
  assert.equal(visible(inline('**word*')), 'word');
  assert.equal(visible(inline('Before **')).trimEnd(), 'Before');
  assert.equal(visible(inline('`**literal**`')), '**literal**');
  assert.equal(visible(inline('**Bold _nested')), 'Bold nested');
  assert.deepEqual(inline('**Bold _nested').runs.at(-1).marks, ['strong', 'emphasis']);
});

test('partial link labels never expose a growing URL or an actionable synthetic destination', () => {
  for (const text of ['See [Docs', 'See [Docs]', 'See [Docs](', 'See [Docs](https://example.com']) {
    const content = inline(text);
    assert.equal(visible(content), 'See Docs');
    assert.equal(content.runs.at(-1).href, null);
    assert.equal(content.sourceText, text);
  }
  const text = 'See [**Docs';
  assert.equal(visible(inline(text)), 'See Docs');
  assert.deepEqual(inline(text).runs.at(-1).marks, ['strong']);
  assert.equal(inline(text).runs.at(-1).href, null);
});

test('completed unmatched syntax and unsafe destinations stay literal', () => {
  assert.equal(visible(inline('Use \\*literal\\* and snake_case.', false)), 'Use *literal* and snake_case.');
  assert.equal(visible(inline('Unclosed **word', false)), 'Unclosed **word');
  assert.equal(visible(inline('A [bracket] note.', false)), 'A [bracket] note.');
  assert.equal(visible(inline('[unsafe](javascript:alert(1))', false)), '[unsafe](javascript:alert(1))');
  assert.equal(visible(inline('1', false)), '1');
});

test('late reference definitions update earlier links instead of freezing stale grammar', () => {
  const parser = createMarkdownParser();
  const initial = parser('See [Docs][ref].\n\n', true);
  const complete = parser('See [Docs][ref].\n\n[ref]: https://example.com\n', true);
  assert.notEqual(complete[0], initial[0]);
  assert.equal(visible(complete[0].content), 'See Docs.');
  assert.equal(complete[0].content.runs.find((run) => run.text === 'Docs').href, 'https://example.com/');
});

test('table rows retain identity and only unfinished cells get optimistic formatting', () => {
  const parser = createMarkdownParser();
  const prefix = '| Name | Value |\n| --- | --- |\n| **Alpha** | 42 |\n';
  const first = parser(prefix + '| Beta | **grow', true)[0];
  const next = parser(prefix + '| Beta | **growing', true)[0];
  assert.equal(next.kind, 'table');
  assert.equal(next.header, first.header);
  assert.equal(next.rows[0], first.rows[0]);
  assert.equal(next.rows[1].cells[0], first.rows[1].cells[0]);
  assert.equal(visible(next.rows[1].cells[1]), 'growing');
  const closed = parser(prefix + '| Beta | **growing |', true)[0];
  assert.equal(visible(closed.rows[1].cells[1]), '**growing');
});

test('cached suffixes retain indentation and definition context after several closed blocks', () => {
  const prefix = '# One\n\nP2.\n\n## Three\n\nP4.\n\n';
  const samples = [
    '  - item\n\n      code\n\n  - next\n\nEnd',
    '   1. item\n      continuation\n\n      paragraph\n\nEnd',
    '    indented\n\n    code\n\nEnd',
    '  > quote\n  >\n  > continuation\n\nEnd',
    '   ```js\n   code\n   ```\n\nEnd',
    '<div>\n\ntext\n</div>\n\nEnd',
    '<!--\n\ncomment\n-->\n\nEnd',
    '| A | B |\n| - | - |\n| a | b |\n\nEnd',
    'See [x][ref].\n\nFiller\n\nNext\n\n[ref]:\n https://example.com\n',
    'See [x][ref].\n\nFiller\n\nNext\n\n> - > [ref]: https://example.com',
    'See [x][ref].\r\rFiller\r\rNext\r\r[ref]: https://example.com',
  ];
  for (const tail of samples) {
    const text = prefix + tail;
    const parser = createMarkdownParser();
    for (let end = 1; end <= text.length; end++) {
      const value = text.slice(0, end);
      assert.deepEqual(parser(value, true), parse(value), JSON.stringify(value));
    }
    assert.deepEqual(parser(text, false), parse(text, false));
  }
});

test('nested incomplete labels and image syntax never expose virtual URLs or source-less visible text', () => {
  for (const source of ['[A [B', '[A ![B', '**[A [B', '[A [B](https://example.com']) {
    const content = inline(source);
    assert.ok(!visible(content).includes('streaming.invalid'), JSON.stringify(source));
    for (const run of content.runs) {
      assert.ok(run.href === undefined || run.href === null || !run.href.includes('streaming.invalid'));
      assert.ok(!run.text || run.sourceSpans.length, `Visible text must originate in the source: ${JSON.stringify(run)}`);
      assert.ok(run.sourceSpans.every((span) => span.sourceStart < source.length && (span.sourceEnd ?? span.sourceStart + span.end - span.start) <= source.length));
    }
    assert.equal(content.sourceText, source);
  }
});

test('newline and unescaped table pipes close cells while escaped literal pipes do not', () => {
  const prefix = '| A | B |\n| - | - |\n| x | ';
  for (const ending of ['\n', '\r\n', ' |']) {
    const table = parse(prefix + '**value' + ending)[0];
    assert.equal(visible(table.rows[0].cells[1]), '**value');
    assert.deepEqual(table.rows[0].cells[1].runs.at(-1).marks, []);
  }
  const growing = parse(prefix + '**value\\|')[0];
  assert.equal(visible(growing.rows[0].cells[1]), 'value|');
  assert.deepEqual(growing.rows[0].cells[1].runs.at(-1).marks, ['strong']);
  const quote = parse('> | A | B |\n> | - | - |\n> | x | **value\n')[0];
  assert.equal(visible(quote.blocks[0].rows[0].cells[1]), '**value');
});

test('provisional closing fences stay hidden within block quotes as well as lists', () => {
  const quote = parse('> ```js\n> code\n> ``')[0];
  assert.equal(quote.blocks[0].text, 'code');
  const list = parse('- ```js\n  code\n  ``')[0];
  assert.equal(list.items[0].blocks[0].text, 'code');
});

test('ragged streaming rows select the actual unfinished cell and leave completed cells unchanged', () => {
  const prefix = '| A | B |\n| - | - |\n';
  const underfilled = parse(prefix + '| **a')[0].rows[0];
  assert.equal(visible(underfilled.cells[0]), 'a');
  assert.deepEqual(underfilled.cells[0].runs.at(-1).marks, ['strong']);
  const extra = prefix + '| a | **b | c';
  assert.deepEqual(parse(extra)[0].rows[0].cells[1], parse(extra, false)[0].rows[0].cells[1]);
});
