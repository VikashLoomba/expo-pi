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
const { createMarkdownParser } = await import('../src/components/chat/markdown/streaming-parser.ts');
const { citedInlineRuns, collectSearchSources, inlineCitations, safeSourceUrl, searchCallLabel } = await import('../src/components/chat/web-search-presentation.ts');
const { projectNativeWebSearch } = await import('../src/pi/native-web-search/projection.ts');
hook.deregister();

function citation(text, value, id = value, url = 'https://example.com/source') {
  const startIndex = text.indexOf(value);
  assert.notEqual(startIndex, -1);
  return { id, url, title: 'Source document', startIndex, endIndex: startIndex + value.length };
}

function inlineFragments(blocks) {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading': return [block.content];
      case 'list': return block.items.flatMap((item) => inlineFragments(item.blocks));
      case 'quote': return inlineFragments(block.blocks);
      case 'table': return [block.header, ...block.rows].flatMap((row) => row.cells);
      case 'code':
      case 'rule': return [];
      default: throw new Error(`Unhandled test block: ${block.kind}`);
    }
  });
}

function render(text, citations, streaming = false) {
  const sources = collectSearchSources({ calls: [], citations, sources: [] });
  const valid = inlineCitations(text, citations, sources);
  return inlineFragments(createMarkdownParser()(text, streaming)).flatMap((fragment) => citedInlineRuns(fragment, valid));
}

test('citation spans stay aligned through heading/list prefixes, CRLF, continuations and inline syntax', () => {
  const text = '# 🌐 **Overview**\r\n\r\n- First \\*literal\\*\r\n  continued [Docs](https://example.com/long-hidden-path)\r\n\r\n`quoted` tail';
  const citations = ['Overview', 'literal', 'continued', 'Docs', 'quoted', 'tail'].map((word) => citation(text, word));
  const parts = render(text, citations);
  assert.deepEqual(parts.filter((part) => part.citation).map(({ text, citation }) => [text, citation.id]), [
    ['Overview', 'Overview'], ['literal', 'literal'], ['continued', 'continued'], ['Docs', 'Docs'], ['quoted', 'quoted'], ['tail', 'tail'],
  ]);
  assert.equal(parts.find((part) => part.citation?.id === 'Overview').marks.includes('strong'), true);
  assert.equal(parts.find((part) => part.citation?.id === 'Docs').href, 'https://example.com/long-hidden-path');
  assert.equal(parts.some((part) => part.text.includes('long-hidden-path')), false);
});

test('a citation crossing formatting and line boundaries retains visible content in order', () => {
  const text = '- Before **bold** and\n  continued after';
  const span = citation(text, '**bold** and\n  continued');
  const parts = render(text, [span]);
  assert.equal(parts.map((part) => part.text).join(''), 'Before bold and\ncontinued after');
  assert.equal(parts.filter((part) => part.citation).map((part) => part.text).join(''), 'bold andcontinued');
  assert.equal(parts.find((part) => part.text === 'bold').citation.id, span.id);
});

test('native citation markers become numbered links without mutating source text or subsequent offsets', () => {
  const first = '\uE200cite\uE202turn0search0\uE201';
  const second = '\uE200cite\uE202turn0search1\uE201';
  const text = `One. ${first} Two. ${second}`;
  const citations = [citation(text, first, 'one'), citation(text, second, 'two', 'https://second.example/source')];
  const parts = render(text, citations);
  assert.equal(parts.map((part) => part.text).join(''), 'One. [1] Two. [2]');
  assert.equal(text, `One. ${first} Two. ${second}`);
  assert.deepEqual(parts.filter((part) => part.citation).map((part) => part.citation.startIndex), citations.map((item) => item.startIndex));
});

test('late annotations wait for complete spans while closed source-mapped blocks retain identity', () => {
  const text = '# Heading\n\nA cited answer.';
  const annotation = citation(text, 'answer');
  const sources = collectSearchSources({ calls: [], citations: [annotation], sources: [] });
  assert.deepEqual(inlineCitations(text.slice(0, -4), [annotation], sources), []);
  assert.equal(inlineCitations(text, [annotation], sources).length, 1);
  const parser = createMarkdownParser();
  const first = parser('# Heading\n\nA cited', true);
  const next = parser(text, true);
  assert.equal(first[0], next[0]);
  assert.equal(next[0], parser(text, false)[0]);
});

test('UTF-16 spans work after astral characters and never split a surrogate pair', () => {
  const text = '😀 café 🌍 source';
  const valid = citation(text, 'source');
  const split = { ...valid, id: 'invalid', startIndex: 1, endIndex: 2 };
  const globe = citation(text, '🌍');
  const sources = collectSearchSources({ calls: [], citations: [valid, split, globe], sources: [] });
  assert.deepEqual(inlineCitations(text, [valid, split, globe], sources).map((item) => item.id), ['🌍', 'source']);
  assert.deepEqual(render(text, [valid, split, globe]).filter((part) => part.citation).map((part) => part.text), ['🌍', 'source']);
});

test('deduped sources and repeated inline citations share one number; overlaps preserve every character', () => {
  const text = 'One two three';
  const citations = [citation(text, 'One', 'one'), citation(text, 'three', 'three'), citation(text, 'One two', 'overlap', 'https://other.example/')];
  const sources = collectSearchSources({ calls: [], citations, sources: [
    { url: 'https://example.com/source', title: 'Duplicate' }, { url: 'https://third.example/', title: 'Read further' },
  ] });
  assert.equal(sources.length, 3);
  const valid = inlineCitations(text, [...citations, citations[0]], sources);
  assert.equal(valid.length, 3);
  assert.equal(valid.find((item) => item.id === 'one').number, valid.find((item) => item.id === 'three').number);
  const parts = render(text, citations);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.equal(parts.find((part) => part.text === 'One').citation.id, 'one');
});

test('unsafe URLs and invalid bounds never produce clickable source or citation data', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:pass@example.com', 'https://example.com/\npath', 'not a URL']) {
    assert.equal(safeSourceUrl(value), undefined, value);
    assert.deepEqual(collectSearchSources({ calls: [], citations: [], sources: [{ url: value }] }), []);
  }
  const text = 'text';
  const base = citation(text, text);
  const sources = collectSearchSources({ calls: [], citations: [base], sources: [] });
  assert.deepEqual(inlineCitations(text, [
    { ...base, startIndex: -1 }, { ...base, endIndex: 10 }, { ...base, endIndex: 0 }, { ...base, startIndex: 0.5 }, { ...base, url: 'javascript:alert(1)' },
  ], sources), []);
  assert.equal(safeSourceUrl('https://example.com/page?q=caf%C3%A9'), 'https://example.com/page?q=caf%C3%A9');
});

test('search, open-page and find states remain distinct across completion, failure and interruption', () => {
  assert.equal(searchCallLabel({ action: 'search', status: 'running' }), 'Searching the web');
  assert.equal(searchCallLabel({ action: 'open_page', status: 'running' }), 'Opening a page');
  assert.equal(searchCallLabel({ action: 'find_in_page', status: 'running' }), 'Finding text on a page');
  assert.equal(searchCallLabel({ action: 'open_page', status: 'completed' }), 'Opened a page');
  assert.equal(searchCallLabel({ action: 'search', status: 'failed' }), 'Web search failed');
  assert.equal(searchCallLabel({ action: 'search', status: 'interrupted' }), 'Search interrupted');
});

test('projection retains ordinary HTTP citations and sources with the same URL safety rules as UI', () => {
  const urls = ['http://example.com/document', 'https://secure.example/document', 'https://user:pass@example.com/private',
    'https://example.com/\npath', 'javascript:alert(1)'];
  const record = { requestId: 'request', taskId: 1, provider: 'openai', model: 'model', status: 'completed', events: [], output: [
    { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', sources: urls.map((url) => ({ url })) } },
    { type: 'message', id: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: urls.map((url) => ({
      type: 'url_citation', url, title: 'Document', start_index: 0, end_index: 6,
    })) }] },
  ] };
  const result = projectNativeWebSearch(record, 'Answer');
  assert.deepEqual(result.citations.map((item) => item.url), urls.slice(0, 2));
  assert.deepEqual(result.sources.map((item) => item.url), urls.slice(0, 2));
  assert.deepEqual(collectSearchSources(result).map((item) => item.url), urls.slice(0, 2));
});

test('every source sharing one citation span is reachable inline without duplicating the cited text', () => {
  for (const span of ['Shared finding', '\uE200cite\uE202turn0search0\uE202turn0search1\uE201']) {
    const text = `Before ${span} after`;
    const citations = [citation(text, span, 'first'), citation(text, span, 'second', 'https://second.example/')];
    const parts = render(text, citations);
    assert.deepEqual(parts.filter((part) => part.citation).map((part) => part.citation.url), ['https://example.com/source', 'https://second.example/']);
    assert.equal(parts.map((part) => part.text).join(''), `Before ${span.startsWith('\uE200') ? '[1]' : span} [2] after`);
  }
});

test('a nested citation completely overlapped by another still gets a numbered inline link', () => {
  const text = 'A broadly sourced statement.';
  const outer = citation(text, text, 'outer');
  const nested = citation(text, 'sourced', 'nested', 'https://second.example/');
  const parts = render(text, [outer, nested]);
  assert.equal(parts.filter((part) => part.citation?.id === 'nested').length, 1);
  assert.equal(parts.map((part) => part.text).join(''), 'A broadly sourced [2] statement.');
  assert.equal(parts.filter((part) => part.citation?.id !== 'nested').map((part) => part.text).join(''), text);
});

test('streaming native citation marker fragments stay hidden until a complete annotation is available', () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  for (let length = 1; length <= marker.length; length++) {
    assert.equal(render(`Before ${marker.slice(0, length)}`, [], true).map((part) => part.text).join(''), 'Before ');
  }
  const text = `Before ${marker} after`;
  assert.equal(render(text, []).map((part) => part.text).join(''), 'Before  after');
  assert.equal(render(text, [citation(text, marker)]).map((part) => part.text).join(''), 'Before [1] after');
  assert.equal(text, `Before ${marker} after`, 'rendering never rewrites the archived source');
});

test('table cells retain UTF-16 citations through CRLF, escaped pipes, entities and nested formatting', () => {
  const text = '| 🌍 **_Title_** | [**Documentation**](https://example.com/docs) |\r\n'
    + '| :--- | ---: |\r\n'
    + '| escaped \\| pipe | `A\\|B` &amp; 😀 **bold _nested_** |';
  const blocks = createMarkdownParser()(text, false);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].alignments, ['left', 'right']);
  const citations = [
    citation(text, 'Title'), citation(text, 'Documentation'), citation(text, '\\|', 'escaped-pipe'),
    citation(text, 'A\\|B', 'code-pipe'), citation(text, '&amp;', 'entity'), citation(text, '😀', 'emoji'),
    citation(text, 'nested'),
  ];
  const parts = render(text, citations);
  assert.deepEqual(parts.filter((part) => part.citation).map((part) => [part.text, part.citation.id]), [
    ['Title', 'Title'], ['Documentation', 'Documentation'], ['|', 'escaped-pipe'], ['A|B', 'code-pipe'],
    ['&', 'entity'], ['😀', 'emoji'], ['nested', 'nested'],
  ]);
  assert.deepEqual(new Set(parts.find((part) => part.text === 'Title').marks), new Set(['strong', 'emphasis']));
  assert.deepEqual(new Set(parts.find((part) => part.text === 'nested').marks), new Set(['strong', 'emphasis']));
  assert.equal(parts.find((part) => part.text === 'A|B').marks.includes('code'), true);
  const documentation = parts.find((part) => part.text === 'Documentation');
  assert.equal(documentation.marks.includes('strong'), true);
  assert.equal(documentation.href, 'https://example.com/docs');
  assert.equal(parts.some((part) => part.text.includes('https://')), false);
});

test('one citation spanning nested formatting and links preserves all visible content and marks', () => {
  const text = '**Bold _emphasis_ and [formatted `code`](https://example.com/target)**';
  const parts = render(text, [citation(text, text)]);
  assert.equal(parts.map((part) => part.text).join(''), 'Bold emphasis and formatted code');
  assert.equal(parts.every((part) => part.citation && part.marks.includes('strong')), true);
  assert.equal(parts.find((part) => part.text === 'emphasis').marks.includes('emphasis'), true);
  const code = parts.find((part) => part.text === 'code');
  assert.equal(code.marks.includes('code'), true);
  assert.equal(code.href, 'https://example.com/target');
});

test('late table annotations decorate cached fragments without changing the archived source or parsed tree', () => {
  const text = '| Name | Result |\r\n| --- | --- |\r\n| **😀 outcome** | `x\\|y` &amp; result |';
  const parser = createMarkdownParser();
  const blocks = parser(text, false);
  const fragments = inlineFragments(blocks);
  const originalTree = structuredClone(blocks);
  const withoutAnnotations = fragments.flatMap((fragment) => citedInlineRuns(fragment, []));
  assert.equal(withoutAnnotations.some((part) => part.citation), false);
  const annotations = [citation(text, '😀 outcome'), citation(text, 'x\\|y'), citation(text, '&amp;')];
  const sources = collectSearchSources({ calls: [], citations: annotations, sources: [] });
  const valid = inlineCitations(text, annotations, sources);
  const annotated = fragments.flatMap((fragment) => citedInlineRuns(fragment, valid));
  assert.deepEqual(annotated.filter((part) => part.citation).map((part) => part.text), ['😀 outcome', 'x|y', '&']);
  assert.equal(annotated.map((part) => part.text).join(''), withoutAnnotations.map((part) => part.text).join(''));
  assert.equal(parser(text, false)[0], blocks[0]);
  assert.deepEqual(blocks, originalTree);
  assert.equal(text, '| Name | Result |\r\n| --- | --- |\r\n| **😀 outcome** | `x\\|y` &amp; result |');
});

test('table citations keep every overlapping source reachable without repeating cell prose', () => {
  const text = '| Finding |\n| --- |\n| **Shared _finding_** &amp; more |';
  const citations = [
    citation(text, '**Shared _finding_** &amp; more', 'outer'),
    citation(text, 'finding', 'nested', 'https://second.example/'),
    citation(text, 'finding', 'third', 'https://third.example/'),
    citation(text, '&amp;', 'entity', 'https://fourth.example/'),
  ];
  const parts = render(text, citations);
  assert.equal(parts.map((part) => part.text).join(''), 'FindingShared finding [2] [3] & [4] more');
  assert.deepEqual(new Set(parts.filter((part) => part.citation).map((part) => part.citation.id)),
    new Set(['outer', 'nested', 'third', 'entity']));
  assert.equal(parts.filter((part) => part.text === 'finding').length, 1);
  assert.equal(parts.find((part) => part.text === 'finding').marks.includes('emphasis'), true);
});

test('native citation markers inside table cells remain hidden while streaming and become source links', () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  const prefix = '| Source |\n| --- |\n| Before ';
  for (let length = 1; length <= marker.length; length++) {
    const partial = prefix + marker.slice(0, length);
    assert.equal(render(partial, [], true).map((part) => part.text).join(''), 'SourceBefore ');
  }
  const text = `${prefix}${marker} after |`;
  const parts = render(text, [citation(text, marker)]);
  assert.equal(parts.map((part) => part.text).join(''), 'SourceBefore [1] after');
  assert.equal(parts.find((part) => part.text === '[1]').citation.startIndex, prefix.length);
  assert.equal(text, `${prefix}${marker} after |`);
});

test('decoded entity characters require coverage of their complete original source range', () => {
  const text = 'A &amp; B &#x1F30D; C';
  const full = [citation(text, '&amp;', 'ampersand'), citation(text, '&#x1F30D;', 'globe')];
  assert.deepEqual(render(text, full).filter((part) => part.citation).map((part) => [part.text, part.citation.id]),
    [['&', 'ampersand'], ['🌍', 'globe']]);
  const partial = [citation(text, 'amp', 'partial-entity'), citation(text, '1F30D', 'partial-astral-entity')];
  const parts = render(text, partial);
  assert.equal(parts.map((part) => part.text).join(''), 'A & B 🌍 C');
  assert.equal(parts.some((part) => part.citation), false);
});

function nativeRecord(parts) {
  return { requestId: 'request', taskId: 1, provider: 'openai', model: 'model', status: 'completed', events: [], output: parts.map((part, index) => ({
    type: 'message', id: `message-${index}`, content: [part],
  })) };
}

test('projection resolves code-point and UTF-16 native citation markers after astral text', () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  const prefix = '😀 News: ';
  const text = prefix + marker;
  for (const start of [prefix.length, [...prefix].length]) {
    const record = nativeRecord([{ type: 'output_text', text, annotations: [{ type: 'url_citation',
      url: 'https://example.com/source', title: 'News', start_index: start, end_index: start + marker.length }] }]);
    const projection = projectNativeWebSearch(record, text);
    assert.equal(projection.citations.length, 1);
    assert.equal(projection.citations[0].startIndex, prefix.length);
    assert.equal(projection.citations[0].endIndex, text.length);
    assert.equal(render(text, projection.citations).map((part) => part.text).join(''), '😀 News: [1]');
  }
});

test('ambiguous prose ranges after astral characters retain sources without guessed inline placement', () => {
  const text = '😀 source after';
  for (const start of [2, 3]) {
    const record = nativeRecord([{ type: 'output_text', text, annotations: [{ type: 'url_citation',
      url: 'https://example.com/source', title: 'Source', start_index: start, end_index: start + 6 }] }]);
    const projection = projectNativeWebSearch(record, text);
    assert.deepEqual(projection.citations, []);
    assert.deepEqual(projection.sources, [{ url: 'https://example.com/source', title: 'Source' }]);
  }
});

test('multiple native messages aggregate citation offsets without applying earlier messages Unicode to part-local spans', () => {
  const first = '😀 Introduction\n';
  const second = 'A sourced result';
  const third = ' Another result';
  const record = nativeRecord([
    { type: 'output_text', text: first, annotations: [] },
    { type: 'output_text', text: second, annotations: [{ type: 'url_citation', url: 'https://example.com/one', title: 'One', start_index: 2, end_index: 9 }] },
    { type: 'output_text', text: third, annotations: [{ type: 'url_citation', url: 'https://example.com/two', title: 'Two', start_index: 1, end_index: 8 }] },
  ]);
  const projection = projectNativeWebSearch(record, first + second + third);
  assert.deepEqual(projection.citations.map((item) => [item.startIndex, item.endIndex]), [
    [first.length + 2, first.length + 9], [first.length + second.length + 1, first.length + second.length + 8],
  ]);
  assert.deepEqual(render(first + second + third, projection.citations).filter((part) => part.citation).map((part) => part.text), ['sourced', 'Another']);
});
