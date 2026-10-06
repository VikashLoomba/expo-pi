import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../src/', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.')) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { parseMarkdown } = await import('../src/components/chat/markdown/parse-markdown.ts');
const { sourceRange, literalText, replaceMappedText, sliceMappedText } = await import('../src/components/chat/markdown/source-map.ts');
hook.deregister();

const runs = (source) => parseMarkdown(source)[0].content.runs;
const text = (items) => items.map((run) => run.text).join('');
const mappedWord = (items, word) => {
  const run = items.find((item) => item.text.includes(word));
  assert.ok(run, `Expected visible ${JSON.stringify(word)}`);
  const start = run.text.indexOf(word);
  return sourceRange(run.sourceSpans, start, start + word.length);
};

test('nested marks and link labels compose without leaking Markdown delimiters', () => {
  const items = runs('**Bold with _emphasis_ and `code`** [**Docs**](https://example.com)');
  assert.equal(text(items), 'Bold with emphasis and code Docs');
  assert.deepEqual(items.find((run) => run.text === 'emphasis').marks, ['strong', 'emphasis']);
  assert.deepEqual(items.find((run) => run.text === 'code').marks, ['strong', 'code']);
  assert.deepEqual(items.find((run) => run.text === 'Docs').marks, ['strong']);
  assert.equal(items.find((run) => run.text === 'Docs').href, 'https://example.com/');
});

test('UTF-16 source maps retain exact characters after escaped syntax and decoded entities', () => {
  const source = '😀 **A \\*literal\\* &amp; &#x1F600; tail**';
  const items = runs(source);
  assert.equal(text(items), '😀 A *literal* & 😀 tail');
  for (const word of ['literal', 'tail']) assert.deepEqual(mappedWord(items, word), {
    start: source.indexOf(word), end: source.indexOf(word) + word.length,
  });
  assert.deepEqual(mappedWord(items, '&'), { start: source.indexOf('&amp;'), end: source.indexOf('&amp;') + 5 });
  const entityRun = items.find((run) => run.text.includes('tail'));
  const index = entityRun.text.indexOf('😀');
  assert.deepEqual(sourceRange(entityRun.sourceSpans, index, index + 2), { start: source.indexOf('&#x1F600;'), end: source.indexOf('&#x1F600;') + 9 });
});

test('GFM autolinks created after entity decoding retain exact maps and unique keys', () => {
  const source = '**w&#119;w.example.com tail** and w&#119;w.other.example end';
  const items = runs(source);
  assert.equal(text(items), 'www.example.com tail and www.other.example end');
  assert.equal(items.find((run) => run.text === 'www.example.com').href, 'http://www.example.com/');
  assert.deepEqual(items.find((run) => run.text === 'www.example.com').marks, ['strong']);
  assert.equal(new Set(items.map((run) => run.key)).size, items.length);
  for (const word of ['tail', 'end']) assert.deepEqual(mappedWord(items, word), {
    start: source.indexOf(word), end: source.indexOf(word) + word.length,
  });
  const autolink = items.find((run) => run.text === 'www.example.com');
  assert.deepEqual(sourceRange(autolink.sourceSpans, 1, 2), { start: source.indexOf('&#119;'), end: source.indexOf('&#119;') + 6 });
});

test('multiple backtick spans preserve literal backticks and normalize line endings with maps', () => {
  const source = '``  a\r\nb ` c  `` tail';
  const items = runs(source);
  assert.equal(text(items), ' a b ` c  tail');
  assert.deepEqual(items[0].marks, ['code']);
  assert.deepEqual(mappedWord(items, 'b'), { start: source.indexOf('b'), end: source.indexOf('b') + 1 });
  assert.deepEqual(sourceRange(items[0].sourceSpans, 2, 3), { start: source.indexOf('\r'), end: source.indexOf('\r') + 2 });
});

test('GFM tables normalize rows and retain source maps inside styled and code cells', () => {
  const source = '| Name | Value |\n| :--- | ---: |\n| **a\\|b** | `x\\|y` |\n| short |\n| a | b | extra |';
  const table = parseMarkdown(source)[0];
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.alignments, ['left', 'right']);
  assert.deepEqual(table.rows.map((row) => row.cells.length), [2, 2, 2]);
  assert.equal(text(table.rows[0].cells[0].runs), 'a|b');
  assert.equal(text(table.rows[0].cells[1].runs), 'x|y');
  assert.equal(text(table.rows[1].cells[1].runs), '');
  for (const [cell, word] of [[0, 'b'], [1, 'y']]) assert.deepEqual(mappedWord(table.rows[0].cells[cell].runs, word), {
    start: source.indexOf(word, source.indexOf('**')), end: source.indexOf(word, source.indexOf('**')) + word.length,
  });
});

test('invalid table headers remain visible and valid empty tables retain headers', () => {
  assert.equal(parseMarkdown('| A | B |\n| --- |\n| value |')[0].kind, 'paragraph');
  const table = parseMarkdown('A | B\n--- | ---')[0];
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.rows, []);
});

test('recursive lists, quotes, tasks and hard breaks retain structure and source offsets', () => {
  const source = '> Quote **bold**\r\n>\r\n> - [x] first\r\n>   - nested\r\n\r\nEnd  \nnext';
  const result = parseMarkdown(source);
  assert.equal(result[0].kind, 'quote');
  const list = result[0].blocks[1];
  assert.equal(list.kind, 'list');
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[0].blocks[1].kind, 'list');
  const item = list.items[0].blocks[1].items[0].blocks[0].content;
  assert.deepEqual(mappedWord(item.runs, 'nested'), { start: source.indexOf('nested'), end: source.indexOf('nested') + 6 });
  assert.equal(text(result[1].content.runs), 'End\nnext');
});

test('late reference definitions resolve earlier links; the first definition wins', () => {
  const prefix = 'See [**Docs**][ref].\n\n';
  assert.equal(text(runs(prefix)), 'See [Docs][ref].');
  const result = parseMarkdown(prefix + '[ref]: https://first.example\n[ref]: https://second.example');
  assert.equal(result.length, 1);
  assert.equal(result[0].content.runs.find((run) => run.text === 'Docs').href, 'https://first.example/');
});

test('unsafe links stay readable and never become active; escaped destinations parse correctly', () => {
  for (const source of ['[label](javascript:alert(1))', '[label](https://user:pass@example.com)', '[label](file:///tmp/a)']) {
    assert.equal(text(runs(source)), source);
    assert.ok(runs(source).every((run) => run.href === undefined));
  }
  const source = '[Label](https://example.com/a\\)b)';
  assert.equal(text(runs(source)), 'Label');
  assert.equal(runs(source)[0].href, 'https://example.com/a)b');
});

test('HTML, images and footnotes are visible literal fallbacks, with no fetching or interpretation', () => {
  for (const source of ['<script>alert(1)</script>', '![alt](https://example.com/image.png)']) {
    assert.equal(text(runs(source)), source);
  }
  const source = 'A footnote[^one].\n\n[^one]: Footnote **body**';
  const result = parseMarkdown(source);
  assert.equal(text(result[0].content.runs), 'A footnote[^one].');
  assert.equal(text(result[1].content.runs), '[^one]: Footnote **body**');
});

test('source map slicing and contractions retain their whole originating ranges', () => {
  const mapped = replaceMappedText(literalText('a\r\nb', 20), /\r\n/g, () => ' ');
  assert.equal(mapped.text, 'a b');
  assert.deepEqual(sourceRange(mapped.sourceSpans, 1, 2), { start: 21, end: 23 });
  assert.deepEqual(sourceRange(sliceMappedText(mapped, 1, 3).sourceSpans, 0, 2), { start: 21, end: 24 });
  assert.equal(sourceRange(mapped.sourceSpans, 2, 5), undefined);
});
