# Piece 6: Scheduled tasks and the background

## Goal

Scheduled tasks notify the phone at their time wherever InfiniChat runs, and the phone's background machinery only
runs for work that is on the phone. The Scheduled tasks sheet already works remotely: piece 1 puts `scheduled` and
`cancelScheduled` in the contract, and piece 3 renders them.

## Owner decision (2026-10-21)

It shouldn't matter where a scheduled task runs: the phone still gets the notification. While InfiniChat runs on a
machine, the notification doesn't start the task; the machine already did. Opening it shows the agent already
working.

## What exists today

- **Notifications.** `ScheduledTaskNotifier` keeps one local notification per waiting task. In its own words
  (`src/pi/infinichat-notifications.ts:24-30`): "Nothing handles the tap: opening the app reopens the Harness, whose
  wait task then sends its task at once, and the 'Run now' action launches the app in the background for the same."
  On the phone, the notification is also what wakes the Harness.
- **Keep-alive.** `KeepAliveController` holds a location stream and a Live Activity while an observed Harness has
  live work (`src/keep-alive/controller.ts:41-46`), because iOS would otherwise suspend the work.

## Builds

- **Notifications from either side.** Piece 1's split gives the notifier its waiting-task list from the
  `InfiniChatHost`:
  - on the phone, from the local Harness, as today;
  - while InfiniChat is on a machine, from the `RemoteInfiniChat` reference's `scheduled` state.

  The notifier reconciles iOS's pending notifications against that list as it does now, so moving either way
  replaces the set without duplicates.
- **Actions while remote.** "Run now" exists only to launch the app in the background so its Harness runs the task.
  On a machine the task runs at its time anyway, so the category used for remote tasks has only "Open". Tapping
  either opens InfiniChat, where the agent is already working.
- **What the phone can know.** It schedules notifications for the tasks it has received. A task the agent schedules
  on the machine while the phone is disconnected gets its notification when the phone next connects; a task deleted
  meanwhile is removed then. Reaching a phone that isn't connected would need push notifications (not in this
  piece).
- **Keep-alive.** While remote, `chat-provider` doesn't call `keepAlive.observe` for InfiniChat (there is no local
  Harness). Ordinary chats keep their keep-alive unchanged.

### As built

pi 1.4.0 (tag `4a080252f`; pi-durable, pi-ai and Chord 1.4.0, the latest on npm on 2026-10-22), Expo 58.0.17,
expo-notifications 58.1.6.

- **One notifier for the app** (`src/pi/infinichat-notifications.ts`). `ScheduledTaskNotifications` is created by
  the provider beside the keep-alive controller and closed with it at unmount (`src/chat/chat-provider.tsx`). Its
  `follow(source)` switches it to the side that holds the conversation open: the list, `runsOn` (`phone` or
  `machine`), and where a failure shows. It never closes what it follows.
  - The phone follows its own list when it opens: `openPhoneInfiniChat` calls `follow` with the service's `scheduled`
    and its `report`, as it attaches the keep-alive (`src/pi/infinichat-phone.ts:42`). That covers a launch, a move
    back, a Cancel that reopens the phone, and a reopen after a storage failure.
  - A machine is followed when the provider shows it: `showMachine` is `MoveSides.show` (the end of a move there, and
    a Cancel of a move back) and what `open()` calls when the home record says `there` (a launch, and each return to
    the app). A failure shows as the provider's InfiniChat error (`InfiniChat: …`), as a failed open does; the
    machine's own report is the server's and is dismissed there.
- **Only a real list from the owner reconciles.** The notifier does nothing while its list is `undefined`. The
  server now says `null` while it doesn't hold the conversation open or hasn't read its tasks yet
  (`ScheduledSchema` in `src/pi/infinichat-remote/contract.ts`, `currentScheduled` in `server/serve.ts`), and the
  client turns `null` into `undefined` (`src/pi/infinichat-remote/client.ts`). Before, the server sent `[]` for
  both, so a move there cancelled every notification right after `adopt` and added them again once the machine had
  read its tasks, and a move back cancelled them all after `relinquish` until the phone opened (checked against that
  server; see [references](references.md#piece-6-on-macos)). While a move runs, the notifier still follows the side
  that gave the conversation up: a closed phone's list never changes again, and a machine's goes `null` once it
  relinquishes, so nothing is dropped, and the other side's list replaces the set once that side is shown.
- **Replaced in place.** Identifiers stay `infinichat-task-<task id>`. A moved conversation keeps pi-durable's task
  IDs, so a held request whose category is not the current side's counts as missing and is scheduled again under
  the same identifier, which replaces the pending one (Apple, `UNNotificationRequest.init(identifier:content:trigger:)`:
  "If the identifier matches a pending request, the new request replaces the pending request"; expo-notifications
  adds it with `UNUserNotificationCenter.add`, `ios/.../Scheduling/SchedulerModule.swift:46`). No request is
  cancelled for a move, so there is never a moment without one.
- **Categories.** The phone's is unchanged: `infinichatScheduledTask` with "Run now" (`opensAppToForeground: false`)
  and "Open". A machine's is `infinichatMachineTask` with "Open" only. Each is registered the first time it is used.
- **The tap opens InfiniChat** (`src/hooks/use-scheduled-task-taps.ts`, called by `src/app/_layout.tsx`), as the SDK 58
  notifications reference routes a tap with Expo Router ("Handle push notifications with navigation", Expo Router):
  on mount it reads `getLastNotificationResponse()`, then adds `addNotificationResponseReceivedListener`, and clears
  the response once handled. A response opens InfiniChat when its request identifier is a scheduled task's and its
  action is the default (a tap on the notification) or "Open" (`opensInfiniChat` in the notifier's module); "Run now"
  stays in the background as before. The route is `router.dismissTo('/')` then `router.navigate('/')`. In expo-router
  58.0.25 neither alone does it, as checked in the simulator: `navigate` from a sheet pushes the tabs again above the
  sheet (the stack router pushes unless asked to pop, `build/react-navigation/routers/StackRouter.js:268-276`), and
  `dismissTo` with no sheet open leaves the Chats tab selected (the tab router has no `POP_TO`, and an action
  addressed to a navigator stops there, `build/global-state/reduceNavigationTree.js:78-82`).
- **Each task is scheduled on its own.** iOS refuses a task due within about a second (the DATE trigger floors to whole
  seconds and refuses a time not ahead, `ios/.../TriggerRecords.swift:102-110`), so one refusal no longer holds back
  the tasks after it: the first error is kept and reported after the loop, as the provider's teardown does.
- **The machine's list notifies only when it changes.** `RemoteInfiniChat` has one store for its view, report and
  connection, which notifies at every streamed change of the transcript. Its `scheduled` now has a store of its own,
  notified when the list it shows changes. The notifier enqueues a sync at each notification of the list it follows,
  and the sync reads that list when it runs. Measured in the harness: one streamed answer from the machine gave 24–26
  notifications of the client's store, none of its list's, and no read of iOS's pending set. The phone's
  `ScheduledTasks` makes a new list at each task graph change, so the phone reconciles as often as before.
- **Keep-alive: no change was needed.** Piece 3's structure already holds: the only `keepAlive.observe` for
  InfiniChat is in `openPhoneInfiniChat` (`src/pi/infinichat-phone.ts:41`), so while InfiniChat is on a machine its
  work is never counted, and a move there detaches the phone's Harness when it closes it. Ordinary chats still pass
  `keepAlive` to `DurableChatService.open`.

## Ownership and lifetime

The notifier is created by the provider, beside the keep-alive controller, and closed with it at unmount. It borrows
whichever side holds the conversation open, the phone's `ScheduledTasks` or the `RemoteInfiniChat` reference's state,
and closes nothing of either. The keep-alive controller is unchanged and simply not given the remote conversation.


| Resource | Created by | Borrowed by | Closed by |
| --- | --- | --- | --- |
| `ScheduledTaskNotifications` | the provider's lifecycle effect | — | the provider's teardown, after the keep-alive |
| Its subscription to a side's list | `follow` | — | the next `follow`, or `close` |
| The phone's `ScheduledTasks` | `InfiniChatService.open` | the notifier, while it follows the phone | the service's close |
| `RemoteInfiniChat`'s `scheduled` store | the client | the notifier, while it follows the machine | the client's close |
| The tap listener | the root layout's effect | — | the effect's cleanup |
| iOS's pending notifications | the notifier | — | the notifier when a task leaves the list; iOS when one is delivered |

## Size

About 80 lines: the notifier's list source ~40, the remote category ~20, the keep-alive condition ~20.

As built after the review and the rebase onto piece 7, +173 −62 outside the asset and its manifest:
- the notifier +84 −37 (`follow`, the source type, the second category, each task scheduled on its own, the tap
  predicate, the comments);
- the tap: a new 27-line hook and +2 in the root layout;
- the provider +15 −4, the phone host +7 −4;
- the client +24 −8 (the list's own store), the contract +5 −1, `serve.ts` +8 −7, a comment in
  `infinichat-scheduled.ts`;
- the keep-alive 0, as above.

The estimate did not include the tap (about 30 lines) or the client's list store (about 15).

The server asset was rebuilt for the `null`, on top of piece 7's: 8,332,583 bytes (bundle `722983cc…`).

## Deviations

- **The server's `scheduled` is `null` until it is known.** The contract had no way to say "not read yet", and an
  empty list made the phone cancel every notification during each move. The phone reinstalls the server when its
  bundle changes, as for every piece.
- **The machine's failures go to the provider's InfiniChat error.** The phone has no local report on a machine's
  InfiniChat, whose report is the server's.
- **The client's list store compares the list it shows.** Chord does let a holder follow one member
  (`ref.scheduled.subscribe`), but the client copies the reference's values in one place, `refresh`, only once it has
  checked which server answers, and a connect changes the list shown without that member changing. So `refresh`
  notifies the list's own listeners when the list differs from the one it showed: an identity check, since Chord keeps
  a member's value until that member changes (one streamed answer: 24–26 notifications of the client's store, none of
  the list's).

## Checks

On the owner's iPhone Release install, conversation on a machine:

- Schedule a task five minutes out and lock the phone. At its time the notification shows. Opening it shows the agent
  already working on the machine, with no "Run now" on that notification.
- Schedule one, then turn Tailscale off before its time. The machine runs it anyway, and its report is in the
  transcript after reconnecting.
- Move back to the phone: the waiting tasks' notifications are the phone's again, with "Run now".
- No location indicator or InfiniChat Live Activity appears for work on the machine.

Done in this piece on the implementer's Mac: 24 of 24 checks in Node, with stand-ins for iOS's notifications, SSH and
the other native modules, against the server built from this commit with scripted models; and the tap in the iOS
simulator, on a development build of this commit. The results are in
[references](references.md#piece-6-on-macos). Still unverified, on the phone:

- iOS itself: a delivered notification on the lock screen, the two categories' actions, a real tap on a banner (the
  simulator checks sent the response through expo-notifications' own emitter), a launch from a tap (the
  `getLastNotificationResponse()` path), "Run now" from a machine's leftover phone notification, and a request
  replaced under its identifier.
- Delivery when a task is due within about a second of its list reaching the phone: the DATE trigger floors to
  whole seconds and refuses a time not ahead (`ios/.../TriggerRecords.swift:103-107`), which then shows as an error.
- The checks above over Tailscale, with the phone locked and the app suspended.

## For the owner

- **`schedule_task`'s description.** It tells the agent "If the app is closed at that time, the user gets a
  notification and the task reaches you when the app is next opened" (`src/pi/infinichat/schedule.ts:51-53`). While
  InfiniChat runs on a machine, the task reaches the agent at its time instead. Changing the text changes the agent's
  tools for the existing conversation. The Scheduled tasks sheet's footer is right on both sides.

## Not in this piece

Push notifications from the server (needs APNs and a relay; no requirement yet).
