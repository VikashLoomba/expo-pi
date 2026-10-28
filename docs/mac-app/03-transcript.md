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
  `use-transcript-scroll.ts` over a scroll listener), `agent.tsx` with the avatar from `appdata://avatar/<file>`
  (the window gets `allowedProtocols: { appData: true }`; the file arrives in piece 6).
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

## As built

From `dfee5d9` on `feat/mac-app-shell` (2026-10-28), one commit, with streamdown 2.7.1 and Tailwind 4.3.3. What
differs from the plan:

- **Tailwind, as streamdown requires.** Its components carry Tailwind utilities and `streamdown/styles.css` holds
  only the animation keyframes, so the window's stylesheet is a Tailwind input (`@import "tailwindcss"`, a
  `@source` for streamdown's `dist`, and the palette in shadcn's names mapped through `@theme inline`), compiled by
  Tailwind's CLI from Hutch's `preBuild` hook (`scripts/pre-build.ts`, 38 ms) into `build-css/app.css`, which
  `build.copy` places beside the page. Hutch's bundler has no CSS step; this is the one build step beyond it.
- **Links** go through a `MacApp.openExternal` method (the main process applies the phone's `safeSourceUrl` policy
  and calls `Utils.openExternal`); streamdown gets an `a` component override and `linkSafety` off, since the main
  process is the gate. Copy uses the page's own clipboard.
- **Attachments** are `MacInfiniChat.pickPhotos` (the open dialog, `Utils.openFileDialog`) and `attach` (a dropped
  or pasted file as base64); both fit the photo with pi-durable's processor (`src/main/attachments.ts`) to the shown
  model's limits from the machine's catalog and the controls, and return pi-ai's image part with an ID, which the
  composer shows as a data URL and `accept` sends as the phone does (`userInput`).
- **Icons** are a dozen inline SVG paths (`src/view/icon.tsx`) in place of SF Symbols; the agent's mark is an ∞
  glyph until piece 6 adds the avatar.
- `web-search-presentation.ts` moved into `packages/infinichat/src/chat/` (deviation 2); the phone imports it there.
- The transcript follows new messages while scrolled near the end and shows a jump button otherwise
  (`src/view/transcript.tsx`), in place of the phone's FlashList settings.

Verified on this Mac: the app builds with the hook, launches, loads the 2.9 MB window bundle with streamdown
without a console error, and holds its link to the server. Not verified, since the conversation is on vikash-system (the
server's `heldBy`) and the window shows that notice instead of a transcript: Markdown, tool cards, searches, images,
copy, links and attachments need the conversation on this Mac, after the phone's Release install from this branch
and a move here from the phone.
