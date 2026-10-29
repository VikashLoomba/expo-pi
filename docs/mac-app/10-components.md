# Piece 10: Components

Done after piece 4 (2026-10-28), before piece 5: the owner found the window's hand-written DOM flat, with no hover,
focus, interaction or animation, and asked for a component framework to style on top of.

## Owner decision (2026-10-28)

shadcn/ui on Base UI, not Radix: shadcn made Base UI its default in July 2026 (changelog "Base UI as the Default";
Radix stays supported, no migration needed). Options compared: React Aria Components (headless, everything styled by
us) and hand-written CSS with states added by hand.

## What upstream does

- **shadcn 4.23** copies components into the project (`components.json`, style `base-nova`, aliases through
  tsconfig `paths`), each a file of ours over Base UI's primitives (`@base-ui/react` 1.9) with Tailwind classes,
  `class-variance-authority` variants, `cn` for class merging and `lucide-react` icons; hover, focus-visible rings,
  pressed and disabled states and ARIA come with them (docs "Manual Installation", "components.json").
- **Theming** is CSS variables in shadcn's names, mapped to Tailwind's theme in `@theme inline`; the components
  rely on `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`,
  `border`, `input`, `ring` and the `sidebar-*` set, each with a `-foreground`. streamdown's components already
  expected the same names (piece 3), so one theme serves both.
- **Animation** is `tw-animate-css` (shadcn's companion) and the components' `transition-*` classes.
- **Dark mode** is a `dark` custom variant; shadcn's docs use a `.dark` class switched by the app.

## Builds

- `components.json`, `src/view/lib/utils.ts` (`cn`), the `@/*` alias to `src/view` in `tsconfig.json` with its own
  `baseUrl` (the devkit's tsconfig sets another), and the dependencies pinned in `package.json`.
- `src/view/app.css`: shadcn's imports and full token set in the macOS palette the window already had (the accent
  as `primary`, the system red as `destructive`, the source list as `sidebar`); the `dark` variant is the
  `prefers-color-scheme` media query, since a Mac app follows the system appearance rather than a class.
- `src/view/components/ui/`: button, input, label, field, dialog, alert-dialog, tooltip, select, switch, badge,
  card, separator, spinner, tabs, dropdown-menu, textarea, kbd, scroll-area, added with the CLI and ours from then
  on, restyled toward the HIG where they differ (arrow cursor on controls, 13px text, short transitions).
- The screens use them: the sidebar's rows and footer, the conversation header, the composer's controls with
  tooltips, notices, the transcript's copy and jump buttons, the Settings window's source list, the Machines pane's
  cards, fields, badges, spinners and its removal confirmation as an alert dialog; lucide icons replace
  `icon.tsx`'s paths.

## AI Elements (owner, 2026-10-28: "you're not making full idiomatic use of the components shadcn has available")

AI Elements are shadcn's patterns for agentic interfaces, each a composition of its components copied into the
project (docs "AI Elements"): `Trace` is the one row shape for reasoning, tool calls, sources, subagents and tasks;
`Message` and `Bubble` are the turns; `Message Scroller` is the thread, anchoring the person's turn near the top,
following the reply while the reader stays at the live edge, with its own jump button; `Prompt Input` is an
`Input Group` with `Attachment` chips. Markdown renders through Streamdown with fenced code routed to `Code Block`
(docs "Message"). The chat is rebuilt on them in place of piece 3's hand-written rows:

| Ours (piece 3) | shadcn / AI Elements |
| --- | --- |
| `use-transcript-scroll`, the jump button | `MessageScrollerProvider autoScroll`, `MessageScroller`, `MessageScrollerItem scrollAnchor` on the person's turn, `MessageScrollerButton` |
| `.user-row` / `.user-bubble`, queued meta | `Message align="end"`, `Bubble variant="muted"`, the queue note in `MessageFooter` |
| `.assistant` identity, `MessageContent`, copy | `Message`, `MessageContent` with Streamdown and `CodeBlock` for fences, `MessageFooter` with a ghost icon copy button and tooltip |
| the agent's report (`work`) | Subagent: a `Trace` line "Ran <agent>" opening to the report |
| `<details class="thinking">` | Reasoning: `TraceCollapsible` "Thinking" while it streams, "Thought" after |
| `ToolCard` | Tool: `TraceLine` running (shimmer) or failed, `TraceCollapsible` with `CodeBlock size="sm"` for input, output and the diff |
| `WebSearchActivity`, `WebSearchSources` | `Trace` lines "Searched for …" and Sources "Used N sources" opening to one line per link, through `openExternal` |
| `.notice-row` | `Marker` between turns |
| `EmptyConversation`, `.suggestion` | `Empty` with `Suggestion` buttons |
| the working footer | a running `TraceLine` with the shimmer |
| `Composer` | Prompt Input: `InputGroup`, `InputGroupTextarea`, a `block-end` addon with the attach, stop and send buttons, attachments as `Attachment` chips in a `block-start` addon |
| the window's sidebar, the Settings source list | `Sidebar` (`SidebarProvider`, `SidebarMenu`, `SidebarMenuButton`) |
| the Machines pane's cards | `Item` rows in an `ItemGroup`, with `ItemActions` |

Added with the CLI: message-scroller (which depends on `@shadcn/react` 0.3), message, bubble, input-group,
attachment, trace, code-block, marker, empty, item, sidebar. `icon.tsx` goes; the screens import lucide icons
directly, as the patterns do.

## Deviations

8. **The window bundle adds shadcn's runtime**: `@base-ui/react`, `class-variance-authority`, `cn`, `lucide-react`,
   `tw-animate-css`, and the `shadcn` package for its Tailwind layer and CLI. The phone's counterpart is `@expo/ui`'s
   SwiftUI forms and its native controls.

## Size

About 60 lines of configuration and tokens, the copied components (not ours to size), and ~300 lines changed
across the screens.

## Checks

Hover and pressed states on every control, focus rings on keyboard navigation, the removal confirmation, tooltips
on the composer, both appearances, and the transcript unchanged.

## As built

From `3d1d6f0` on `feat/mac-app-shell` (2026-10-28), one commit, with shadcn 4.23 (style `base-nova`), Base UI 1.9,
`@shadcn/react` 0.3 and lucide 1.63. What differs from the plan:

- **The dark variant is the media query**, not the `.dark` class shadcn's docs switch: `@custom-variant dark
  (@media (prefers-color-scheme: dark))`, with the dark tokens under the same query.
- **The alias needs its own `baseUrl`.** Hutch's devkit `tsconfig.json` sets `baseUrl` and `paths` for Electrobun's
  types; a `paths` override replaces them wholesale, so the project's tsconfig restates them under
  `.hutch/devkit/` beside `@/*`. The shadcn CLI resolved `@/` against the devkit until then.
- **Code Block brings shiki** (`lib/highlighter.tsx`, `hooks/use-highlighted-code.ts`), languages loaded on first
  use; the window bundle grew from 2.9 to 3.6 MB.
- **The transcript's own scroll hook, rows, tool card, search cards and `icon.tsx` are gone**; `trace-rows.tsx`
  holds the Reasoning, Tool, Search, Sources, Subagent and error lines. A notice is a `Marker` separator; the
  working footer is a running `TraceLine` row of the scroller. The removal confirmation is an `AlertDialog` in the
  window, so the main process no longer shows a message box.
- **The Settings sidebar's width** is set with a `[--sidebar-width:12rem]` class on the `Sidebar`, since the
  provider's inline style owns the variable and a cast is not allowed.
- shadcn's copied hooks and components keep the registry's style: a lint override turns off `array-type`, `eqeqeq`
  and `set-state-in-effect` for them.

Verified on 2026-10-28 by the owner ("looks good"): the thread, the turns, the lines, code blocks, the composer with
chips and tooltips, both sidebars and the Machines rows, in both appearances. Not verified: a running tool's and a
search's lines while they stream, a photo chip's image, and the jump button after a long scroll.

## The chatbot template (owner, 2026-10-29)

The owner, on a slow scroll through a 4,139-row thread and my calling virtualization a deviation: "AI Elements
doesn't prescribe us to do what we are doing… Look at the official shadcn example
https://github.com/shadcn-ui/chatbot-template. They use patterns we should be using." The template (`4106041`,
"move chat UI to Trace and AI Elements") and the Message Scroller docs are the reference for this window's chat.

What the docs say: the primitive is comfortable "for hundreds to low thousands of turns"; virtualization is
"intentionally left outside" it, with a `@tanstack/react-virtual` transcript whose viewport is
`MessageScrollerViewport`; loading earlier messages keeps the reader's row through `preserveScrollOnPrepend`.
`autoScroll` and `defaultScrollPosition="last-anchor"` are the documented choices for a thread that follows the
reply and reopens a saved thread, so they were right.

Owner choices: Streamdown stays ("I don't care to change our Streamdown implementation, unless there are specific
enhancements that would make our product better"); the rows are virtualized; the style stays `base-nova` (the
template is `base-rhea`). Not adopted: shadcn/typeset, since Streamdown's elements carry their own utilities and
typeset's `@layer components` rules would lose to them.

As built, after the template:

- **`transcript.tsx`**: the thread's rows come from `rows.ts` (`rowsOf`): a run of tool calls is one row with one
  `Trace`, as the template's `groupParts` groups a turn's steps; the working line is the last row. `Thread` virtualizes
  them with `useVirtualizer` as the docs show (`estimateSize` 86, `overscan` 8, `measureElement`, rows absolutely
  placed in a block of `getTotalSize()`), inside `MessageScrollerProvider autoScroll defaultScrollPosition="end"`
  with the jump button. The person's newest turn settles near the top through `scrollToIndex(…, { align: 'start' })`,
  as `scrollAnchor` did for a MessageScrollerItem; the turn the thread opened on stays where it opened.
- **`message-row.tsx`**: `TranscriptRow` by kind; `StepsRow`, `WorkingRow`; `status-icon.tsx` is the template's
  `StatusIcon` on every step line (`trace-rows.tsx`).
- **`message-content.tsx`**: Streamdown highlights code through its own `@streamdown/code` plugin (an enhancement; the
  blocks were plain before), with utilities instead of a `.markdown` class. The shiki hook and highlighter copied
  from the template were unused and are gone.
- **`composer.tsx`**: Enter is ignored while an IME composition is open (`isComposing`), as the template's form.
- **`notices.tsx`** and the Machines pane: shadcn's `Alert` (`destructive` for errors, `AlertAction` for the one
  action), in the template's footer column (`mx-auto w-full max-w-2xl px-6 pb-6`) with the composer.
- **Layout**: the screen, header, placeholder (`placeholder.tsx`), images and composer use utilities; `app.css`
  keeps only what the platform needs (`.toolbar` drag region, the window frame) and the Settings pane's classes.

Verified on this Mac: typecheck, lint, the window builds and opens. Not verified: the thread's feel on the owner's
4,139-row conversation, opening at the end, the newest turn settling near the top, streaming into virtualized
rows. The owner reports issues themselves (no probes: "Can you please stop doing probes").
