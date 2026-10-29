# Piece 10: the thread folded by turn, with the model's memory

[Index](README.md) · [Contract](../infinichat/docs/04-turns-and-coordinator.md) · [Memory](../infinichat/docs/02-memory-tree-views.md)

## Owner decisions (2026-10-29)

After confirming how OptChat works ("when a user sends a message, the context of the model isn't conversation turns,
but instead the summaries that it can zoom in to, right?"): "from a UI perspective, for the user it would be helpful
to have something that can better represent that, rather than the full transcript. Like basically when I use
InfiniChat, when I open the chat I want to see the last turn loop (including my message) in full, and the previous
turns would be collapsed, and the user could open them if they want to to fill in the transcript in the UI if they
wanted to see previous turns. Then when I send a new message, the last turn transcript collapses in the UI and the
user would only see the latest turns. These changes are only meant to change the visual UI."

Asked through the question tool:

- A collapsed turn shows **the person's message and the model's memory line**, now, in one piece.
- On a send, **everything but the new turn collapses**, hand-opened turns too.
- A steer **stays inside the open turn**. The owner asked why that needed a schema addition: the rows are a fixed
  shape shared over the link, the admission record on the server already says `fresh` or not, and a placed steer
  looks like any user message afterwards, so one optional field carries it.
- The memory line is **the view's current line**, shown on every turn it covers with "covers N turns", not the
  reply's own leaf.
- **Both apps in one piece.**

## What the model sees, and what the thread shows

A fresh turn's prompt is the saved view, one line per node of the memory tree, then the person's new message; the
model zooms into a line when it needs what the line stands for. The thread now folds the same way: a turn is the
input that opened it (OptChat's fresh turn: the person's message, or an agent's report delivered on its own) and
everything until the next, steers included. The newest turn is open in full; each earlier one is a summary line,
the opener's text, and under it the lines the model holds for the turn's messages right now. Nothing changes in the
prompt; this is the thread's presentation.

## As built

- **Rows** (`chat/types.ts`): `fresh` on a placed input, true for a turn of its own and false for a steer, from its
  admission; `memory`, the input's index in the model's memory. `MemoryViewSchema`: the saved view's lines, each
  with the `first` message and `count` it stands for, and `count`, the messages logged, where the last range ends.
- **The view** (`infinichat-view.ts`): attaches `MemoryDoc` beside the app and config documents; reads the nodes of
  the main view's refs once each (immutable) and the logged messages for their `source`, so a delivery's row gets
  its index from `input:<requestId>`; publishes `getMemory()`. The projection's user rows for deliveries carry the
  two fields; a work delivery's row stays the agent's.
- **The host** (`infinichat-service.ts`): `InfiniChatHost.memory`, a store over the view; `RemoteInfiniChat`
  mirrors the server's `memory` cell in a store of its own, as the scheduled tasks; `ShownInfiniChat` carries it
  across moves; the server serves it (`serve.ts`, contract version 5) and follows the core's; the Mac serves it to
  its windows (`serve-infinichat.ts`); the phone reads it with `useInfiniChatMemory`.
- **Turns** (`chat/turns.ts`, shared): `turnsOf(messages, memory)` groups rows into turns and gives each the view's
  lines overlapping its range, from its opener's index to the next turn's, with `shared`, the turns a line covers.
- **The Mac** (`turn-row.tsx`, `transcript.tsx`): a turn is a virtualized row, a `Trace` with a `TraceCollapsible`
  as the Chain of Thought pattern folds steps: the trigger line is the opener (person or agent icon, the text in one
  line, the step count), the memory lines follow with a brain icon and "covers N turns", the content is the turn's
  rows (`rowsOf`, tool runs in one Trace, the working line in the newest). The thread opens on the newest turn's
  start and settles a new one there; the open set is the newest alone whenever a new turn begins, plus the ones
  the reader opened since (state adjusted during render, no effect).
- **The phone** (`turn-item.tsx`, `transcript.tsx`): the same, as a FlashList of turns: a header with a chevron, the
  opener's line and the memory lines, the rows under it when open; `extraData` is the open set. The regular chat
  screen shares the component, so its threads fold by the person's messages too, without memory lines. The
  InfiniChat screen passes `useInfiniChatMemory()`.

## Size

About 420 lines over the package, the server and the two apps; the Mac and phone turn components are 60 and 55.

## Checks

Verified on this Mac: the four typechecks and lints; the server bundle rebuilt (`a4823b9a…`), which both apps
install on their machines on the next connect. To verify by the owner on the Mac and the iPhone: the newest turn
open on opening, earlier turns folded with their memory lines, a click or tap opening one, a send folding the rest,
a steer staying in the open turn, and the lines of an old turn merged across neighbours with "covers N turns".
