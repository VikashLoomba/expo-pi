# Chat Markdown architecture and parser choice

Chat Markdown uses a CommonMark parser with GFM extensions, a small typed adapter, and native React Native components. The intent is a maintainable, idiomatic architecture that humans and agents can extend without a custom grammar framework, duplicated citation logic, or unrelated changes to chat state.

The original message remains the source of truth for copy, durable storage, and replay. Parsing and rendering are projections; they never rewrite the stored message.

## Package decision

The selected runtime packages are exact-pinned `mdast-util-from-markdown` 2.1.0, `micromark-extension-gfm` 3.0.0, and `mdast-util-gfm` 3.1.0. They add JavaScript dependencies without native modules or config plugins. The package graph is larger than a minimal lexer, but it replaces ownership of Markdown grammar with an established parser ecosystem.

Package versions below were checked against the npm registry on October 5, 2026. Compatibility observations about alternatives describe their documented interfaces; they are not SDK 58 device validation.

| Option | Compatibility and integration | Decision |
| --- | --- | --- |
| [mdast and micromark](https://github.com/syntax-tree/mdast-util-from-markdown), with [GFM extensions](https://github.com/syntax-tree/mdast-util-gfm) | Nested syntax trees, source positions, and public compiler hooks for decoded text. The parser can run without a DOM; rendering is separate. | Selected. Its source metadata fits provider citations and a small native renderer. |
| [markdown-it](https://github.com/markdown-it/markdown-it), 15.0.2 | CommonMark mode and extensions including tables. Token maps primarily describe block lines; exact decoded inline offsets need extra instrumentation. | Viable, but introduces more custom citation-position work. |
| [Marked](https://marked.js.org/using_pro), 18.1.0 | GFM, nested tokens, tokenizer and renderer hooks, and raw token source. The normal token contract does not supply the exact decoded character maps needed here. | Small dependency footprint, but less direct source mapping. |
| [commonmark.js](https://github.com/commonmark/commonmark.js), 0.31.2 | Reference CommonMark implementation with an AST and block source positions. GFM tables require additional grammar work. | Less suitable for the GFM requirement. |
| [React Markdown](https://github.com/remarkjs/react-markdown), 10.1.0 | Uses the unified ecosystem; GFM is added through a plugin. The renderer targets HTML/HAST. | Reuse the underlying parser ecosystem without introducing a DOM rendering layer. |
| [React Native Markdown Display fork](https://github.com/RonRadtke/react-native-markdown-display/blob/master/VIEWER.md), 9.0.3 | Native component rules, tables, selectable text customization, and a streaming wrapper. Its public AST lacks exact character source positions. | A useful native renderer, but citation mapping and streaming identity still require adaptation. |
| [React Native Marked](https://github.com/gmsgowtham/react-native-marked), 8.3.2 | GFM and custom native renderers/hooks, with SVG and reanimated-table dependencies. Renderer arguments do not directly expose provider citation ranges. | Additional rendering/dependency integration without removing the citation adapter. |
| [Enriched Markdown](https://github.com/software-mansion/enriched-markdown/blob/main/packages/react-native-enriched-markdown/README.md), 1.1.0 | Native md4c rendering, selection, GFM, and streaming options. Requires a native rebuild. Published compatibility coverage ends at RN 0.87; this app uses 0.88 RC. Public APIs do not document arbitrary source-range annotations. | Worth a separate prototype if native cross-block selection becomes a requirement; not a proportionate replacement for this change. |

The original unscoped React Native Markdown Display remains at 7.0.2, published in 2023; the scoped fork above has a 2026 release. Release age alone is not evidence that a package is abandoned. Enriched's optional [Streamdown integration](https://github.com/software-mansion/enriched-markdown/blob/main/docs/MARKDOWN_STREAMING.md) also entails Worklets/Babel/Metro configuration, unlike the selected pure JavaScript parser.

## Module responsibilities

- `markdown/types.ts` defines the discriminated block union and shared inline fragment contract. Adding a block kind forces deliberate handling in rendering and tree operations.
- `markdown/parse-markdown.ts` adapts the package grammar into that model. It flattens nested inline nodes into text runs carrying composable marks and optional link destinations, and normalizes table rows to the header width.
- `markdown/source-map.ts` handles UTF-16 source ranges, slicing, joining, and contractions such as decoded entities and normalized line endings.
- `markdown/streaming-source.ts` handles provisional presentation of unfinished syntax. Its virtual closers and pending destinations never become stored text, visible synthetic content, or actionable URLs.
- `markdown/streaming-parser.ts` owns cache boundaries and immutable structural sharing. Grammar recognition does not depend on React.
- `message-content.tsx` owns parser lifetime and exhaustive block dispatch. Simple paragraph, heading, quote, list, and rule rendering stays together.
- `markdown/inline-content.tsx`, `code-block.tsx`, and `table-block.tsx` own their cohesive UI responsibilities. Styles stay with the components.
- `web-search-presentation.ts` decorates already-parsed runs with citations. Both citations and ordinary links use the same validated external-link opener.

There is no renderer plugin registry, second transcript store, or configurable parser framework. The existing virtualized transcript and durable message lifecycle remain in place.

## Source mapping and citations

Each inline fragment includes its original source slice and absolute starting offset. Each visible run has spans mapping display UTF-16 ranges directly to the original message, rather than through a reconstructed Markdown string. Those contracts are identical for prose and table cells.

AST node positions alone are insufficient when `&amp;` becomes `&`, escaped punctuation loses a backslash, or code spans normalize whitespace. The adapter observes public compiler events to retain decoded token ranges. GFM can generate autolinks after decoding entities; those generated nodes are projected through the original text map. This keeps citation placement independent of rendered string length.

A decoded character requires an annotation covering its full original source range. Soft line separators remain selectable without being link hit targets. Native provider markers stay hidden until a valid annotation can supply their numbered link. Overlapping sources remain reachable without duplicating the cited prose.

## Streaming and cache behavior

Fresh parsing is the correctness baseline. For append-only streams without possible reference definitions, the cache keeps two trailing top-level blocks mutable and parses from the original start of that suffix's line. Retaining the predecessor allows an incomplete block opener to become ordinary prose again. Keeping indentation preserves fenced-code and list semantics.

Reference definitions can affect earlier text, including definitions nested in lists or quotes. A conservative definition detector selects a full-document parse when they may be present. Rewinds, replacements, and completion are checked against fresh parsing. Returned nodes are immutable, and structural sharing reuses unchanged blocks, rows, and cells independently of the parsing strategy.

This avoids reparsing completed mixed-block history during typical streaming. A single large unfinished paragraph, list, or table still costs proportionally to that block, and documents with possible definitions use the full path. Node timings cannot establish Hermes frame performance; optimizing these cases further requires representative device measurements.

## Rendering coverage

Native UI supports paragraphs, six heading levels, nested inline emphasis/strong/code/strikethrough, safe HTTP(S) links, recursive lists and task markers, quotes, rules, fenced/indented code, and GFM tables. Heading semantics are explicit. Table headers and rows share column widths in one horizontal scroller, with wrapping/selectable cell text and shared inline/citation rendering.

HTML, images, and footnotes currently remain visible source syntax. Parsing them does not imply HTML execution, remote image fetching, or footnote navigation. Email and non-HTTP(S) link destinations also remain literal under the app's external-link policy. The grammar package supports more syntax than the native presentation contract; do not advertise this as a complete GitHub rendering clone.

Tables follow the package's [GFM table grammar](https://github.github.com/gfm/#tables-extension-), including alignment, escaped pipes, matching header/delimiter widths, and normalization of short/long body rows. Only the unfinished real cell receives provisional inline formatting. Completed cells, padded cells, and ignored excess columns do not inherit the whole message's streaming state.

## Verification

The focused tests cover grammar semantics, source maps, citations, streaming boundaries, completed-node identity, nested containers, reference definitions, table normalization, and provisional syntax. Component tests execute the production React components with native host/API mocks and exercise link/copy handlers. They establish component output and event wiring; they do not establish Yoga layout, native selection, scrolling gestures, or screen-reader behavior.

Run the focused checks with:

```sh
node --experimental-strip-types --test tests/markdown-grammar.test.mjs tests/streaming-markdown.test.mjs tests/web-search-presentation.test.mjs tests/markdown-ui.test.mjs
npx @expo/agent-cli lint
npx @expo/agent-cli typecheck
```

After dependency changes, also run `pnpm test:compat` and native Metro/Hermes exports for iOS and Android. The exported source maps must resolve `decode-named-character-reference/index.js`, not its DOM-only `index.dom.js`, on native platforms. Package updates need the source-map and streaming regressions because compiler events and GFM postprocessing form the adapter boundary.

Verified on October 5, 2026: `pnpm test:compat` passed 37 compatibility-package tests and 407 app tests, including 53 focused Markdown, citation, streaming, and component tests. Expo agent CLI lint and typecheck passed. `npx expo export --platform ios --platform android --source-maps --output-dir .expo/markdown-export` produced Hermes bundles for both platforms; both source maps include all eight Markdown modules and the non-DOM entity decoder. A separate randomized probe found cached/fresh agreement across 45 documents and 1,301 variable chunk boundaries.

Device validation remains separate: inspect narrow/wide tables, increased system text size, light/dark themes, cell selection, horizontal table scrolling inside the transcript, and separately reachable links under VoiceOver/TalkBack. These changes add no native dependencies, and a bundle export is not evidence of those device interactions.
