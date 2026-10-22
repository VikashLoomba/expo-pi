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

## Ownership and lifetime

The notifier is created by the phone host and closed with it. In remote mode it borrows the `RemoteInfiniChat`
reference's state and closes nothing of it. The keep-alive controller is unchanged and simply not given the remote
conversation.

## Size

About 80 lines: the notifier's list source ~40, the remote category ~20, the keep-alive condition ~20.

## Checks

On the owner's iPhone Release install, conversation on a machine:

- Schedule a task five minutes out and lock the phone. At its time the notification shows. Opening it shows the agent
  already working on the machine, with no "Run now" on that notification.
- Schedule one, then turn Tailscale off before its time. The machine runs it anyway, and its report is in the
  transcript after reconnecting.
- Move back to the phone: the waiting tasks' notifications are the phone's again, with "Run now".
- No location indicator or InfiniChat Live Activity appears for work on the machine.

## Not in this piece

Push notifications from the server (needs APNs and a relay; no requirement yet).
