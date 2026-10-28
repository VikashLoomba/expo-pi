# Piece 3: The transcript

## Goal

The transcript reads as it does on the phone: Markdown, thinking, work reports, tool cards, web search, images, copy,
the agent's name and avatar, and photos in the composer.

## What upstream does

- `apps/mobile/src/components/chat/message-row.tsx` (124 lines): user bubble with images, queued badges and notices;
  agent work reports parsed from `[Name] text` (`:64-70`); thinking expandable; copy. `message-content.tsx` renders
  Markdown with react-native-enriched-markdown. `tool-card.tsx` (64) shows input, result, images and diff.
  `web-search.tsx` (119) and `web-search-presentation.ts` (38, pure) show searches and sources. `transcript.tsx`
  (171): empty-state suggestions (`:26-31`), the working footer, jump to latest (`use-transcript-scroll.ts`).
  `agent.tsx` draws name and avatar. `photo-attachments.ts:12-23` picks photos and fits them to the model's limits with
  `pi/images.ts:30`; pi-durable's `ImageProcessor` does that fitting on the Node side (`createPhotonImages`,
  `node/devices.ts:25`; pi-durable "Images").
- streamdown 2.7.1 (Vercel; `react-native-enriched-markdown` streams through react-native-streamdown, README:22):
  `<Streamdown>{text}</Streamdown>` repairs unfinished Markdown while it streams (remend), sanitizes (rehype-sanitize,
  rehype-harden), and renders GFM tables, task lists, code blocks and links; its `styles.css` is imported once. The
  phone's `MessageContent` (`message-content.tsx:33-41`) passes the palette, `streamingAnimation` and `onLinkPress`.
  Rows keyed by message ID keep their state across streamed updates.
- Electrobun: `Utils.openExternal`, `Utils.clipboardWriteText`, `Utils.openFileDialog` in the main process
  (apis/utils); a page cannot open external URLs itself.

## Builds

- `src/view/message-content.tsx`: `Streamdown` with the chat palette as CSS variables and the streaming flag from
  the row; anchor clicks are intercepted and go through `openExternal` (a `MacApp` method; the main process applies
  `source-link.ts:6`'s policy and calls `Utils.openExternal`).
- `src/view/message-row.tsx`, `tool-card.tsx`, `web-search.tsx`: the phone's components in React DOM, with
  `web-search-presentation.ts` moved to the package (`chat/`) rather than copied (deviation 2's list).
- `src/view/transcript.tsx`: rows, the footer, the empty state, jump to latest (the phone's
  `use-transcript-scroll.ts` over a scroll listener), `agent.tsx` with the avatar from `appdata://avatar/<file>` (the window gets
  `allowedProtocols: { appData: true }`; the file arrives in piece 6).
- The composer's attachments: a file input, drop and paste in the page hand bytes to `MacApp.attach({ name, type,
  bytes })`; the main process fits them with the chat tools' `ImageProcessor` and returns the attachment the phone's
  `PhotoAttachment` describes, so `accept` sends the same `UserInput` as the phone. Thumbnails come back as data URLs.
  `Utils.openFileDialog` behind an Attach button.
- Copy: `MacApp.copyText`.

## Ownership and lifetime

Nothing new is owned: attachments live in the page until sent; the main process keeps no files for them.

## Deviations

7 (`streamdown`). `web-search-presentation.ts` moves into the package.

## Size

About 450 lines: rows and content 180, tool and search cards 120, transcript and composer additions 100, content 30.

## Checks

- A long transcript with code blocks, lists, tables, images, tool calls and web searches renders like the phone's;
  streaming updates don't reset scroll or collapse an opened thinking block; jump to latest appears when scrolled up.
- A pasted and a dropped photo send and show in the row; the model reads them.
- Links open in the default browser; copy puts the Markdown on the clipboard.

## Not in this piece

Settings, name and avatar editing (6).
