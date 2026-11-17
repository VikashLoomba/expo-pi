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

Asked through the question tool, then revised on sight:

- First: a collapsed turn shows the person's message and the model's memory line, both apps in one piece, a steer
  stays inside the open turn, and a send collapses everything but the new turn, hand-opened turns too. The owner
  asked why a steer needed a schema addition: the rows are a fixed shape shared over the link, the admission record
  on the server already says `fresh` or not, and a placed steer looks like any user message afterwards, so one
  optional field carries it.
- On sight, the memory lines were a wall of `tool:` and `echo:` leaves ("what is all this? … why is it all in
  thinking blocks?"), and once trimmed to the reply's line still "looks bad". **Final: "just collapse the transcript
  turns and show agent responses and user messages."** The memory lines and their plumbing are gone.

## What the thread shows

A turn is the input that opened it (OptChat's fresh turn: the person's message, or an agent's report delivered on its
own) and everything until the next, steers included. The person's messages and the agent's replies show as they
are, in every turn. The steps between a message and a reply (thinking, searches, tool calls, reports, notices) are a
run under a summary line, "Worked in 7 steps", that opens as the Chain of Thought pattern opens an agent's steps.
Every run is closed, the newest turn's too, until a click or tap on its summary: on the Mac it opens its turn's runs,
on the phone that run alone (below). The summary line says when a run is working; a new turn closes the rest again.
Nothing changes in the prompt. (First built with the newest turn's runs open; the owner asked the same day that
nothing open on its own, so on the Mac the thinking row no longer opens while it streams, a failed tool no longer
opens on its error, and an agent's report is closed too.)

## The phone's runs (owner, 2026-11-17)

Asked to find what was wrong with opening a run on the phone, then: "All of 1, 2 and 3 need to be fixed. The key
thing is that I want a good user experience."

1. **A run shows steps, not messages.** It rendered each row with the whole `MessageRow`, so a reply that has
   thinking or searches (which `blocksOf` puts in the run and after it) showed its text, sources and copy action
   twice, and every thinking step carried the avatar, the agent's name and an empty copy row. `StepRow`
   (`step-row.tsx`) is the Mac's `StepRows` for the phone, and `MessageRow` no longer shows steps at all.
2. **A tap opens that run.** A turn has a run for every stretch of work between two replies, all in one FlashList
   row; opening them together pushed the tapped line down by the height of the runs above it. The open set holds
   runs, `<turn ID>/<block ID>`, and a block's ID is its place in the turn, because a run's first row changes when a
   response that began with nothing to show turns out to be tool calls.
3. **The list moves only as far as showing the run takes.** FlashList follows the end
   (`maintainVisibleContentPosition.autoscrollToBottomThreshold`, `useBoundDetection.ts` in 2.3.2) on the next
   change of its data while the list is still near the end, not the moment a row grows: on the simulator a run
   opened at the end of a finished thread stayed where it was. So a small run opened near the end is carried up by
   the next streamed row, and the last run of a thread, whose summary is the line above the composer, opens under
   the composer. Once FlashList has laid the opened run out (`onCommitLayoutEffect`), `settle` in `transcript.tsx`
   leaves the list alone while the steps end above the composer; goes to the thread's end when the run is its last
   thing, where FlashList goes on following the work; and otherwise scrolls until the steps' end is in view or the
   summary is under the header, whichever comes first. FlashList's `scrollToIndex` ends at FlashList's own last
   offset, which leaves out the footer, the list's bottom padding and keyboard-controller's inset for the composer
   (about 200 points here), so only the move that puts the summary under the header uses it; the others are
   `scrollToEnd` and `scrollToOffset`.

With them: the summary keeps its chevron while its run works, so it shows whether it is open; and a new turn is one
whose input is placed, so a message that waits in the queue (three row IDs from sent to placed) no longer closes
the run the reader watches, once when sent and again when its turn starts.

## As built

- **Rows** (`chat/types.ts`): `fresh` on a placed input, true for a turn of its own and false for a steer, from its
  admission (`infinichat-view.ts`, the delivery rows). Contract version 5.
- **Turns** (`chat/turns.ts`, shared): `turnsOf(messages)` groups rows into turns; `blocksOf(rows)` lays a turn out
  as message blocks (the person's rows, the agent's rows with text or an error) and step runs (every other row; a
  reply with thinking or searches is in the run before it as well, for those).
- **The Mac** (`turn-row.tsx`, `message-row.tsx`, `transcript.tsx`): a turn is a virtualized row of blocks. A
  `MessageRow` is the bubble or the reply with its sources, error and copy action; a `StepsRun` is a `Trace` with a
  `TraceCollapsible` whose trigger is the summary line with `StatusIcon` (running while a step runs, error when a
  tool failed) and whose content, `keepMounted` as the pattern says, is the run's `StepRows`: `ToolRow`,
  `ReportRow`, a notice `Marker`, or a reply's `ReasoningRow` and `SearchRows`. The working line is the newest
  turn's last row. The open set is empty whenever a new turn begins, plus the turns the reader opened since; the
  thread opens on the newest turn's start and settles a new one there.
- **The phone** (`turn-item.tsx`, `message-row.tsx`, `step-row.tsx`, `transcript.tsx`): the same as a FlashList of
  turns; a run's summary is a pressable line with a spinner while it works and a chevron for whether it is open,
  its steps `StepRow`s under a hairline rule: the tool card, a notice, and closed lines for a report and for a
  reply's thinking, with its searches. The regular chat screen shares the component, so its threads fold by turn
  too.

## Size

About 250 lines over the package and the two apps; the Mac and phone turn components are 70 and 60.

## Checks

Verified on this Mac: the typechecks and lints; the server bundle rebuilt, which both apps install on their machines
on the next connect. To verify by the owner on the Mac and the iPhone: every turn's steps folded under their
summaries, the newest included, a click or tap opening a turn's steps, a send folding the rest, a steer staying in
the open turn.

The phone's runs (2026-11-17): typecheck, lint and the package's tests, and on an EAS iOS simulator
(`development-simulator` build, Metro through the tunnel) with a scratch screen that gave `ChatTranscript` canned
rows, since the simulator reaches no model: a run shows tool cards and a closed "Thought" line and the reply once,
after it; a tap opens that run and leaves the turn's other run closed; at the end of a finished thread a two-step
run opens under its summary, which does not move, a 25-step run comes to rest with its summary under the header
(recorded: it opens in place, then glides, with no jump to the end), and closing it brings the thread back; the
last run of a thread still working opens onto its newest step and stays there as steps arrive. Not checked: a real
conversation on the iPhone, a queued message's turn starting while a run is open, VoiceOver.
