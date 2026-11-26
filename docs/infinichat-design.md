# InfiniChat's design, on pi-durable and Chord

InfiniChat is UniiChat's design, built on pi-durable and Chord where UniiChat is built on files, git and processes
of its own. This says what the design is, which pi-durable or Chord mechanism carries each part of it, and where
InfiniChat differs or adds. It is written against pi 1.6.0 (upstream tag `v1.6.0`, commit `faac585`); the upstream
example each part starts from is named with it.

The basis is one commit, `VictorTaelin/UniiChat ff32319`, "Unii: a tree of AI agents with long memory". Its author
pushed it to `main` on 2026-11-01 and withdrew it the same day, so `main` is back at `0500bf6`, the release with a
master and its subagents, which InfiniChat followed until server 5.0.0. The commit can still be fetched by its hash.
Its design is in the header comments of `Server.ts`, `Memory.ts` and `Tools.ts`, in `prompt.txt` and `INTERFACE.md`,
and its requirements are listed in `spec/SPEC_CHECK.md`.

The agent core is `packages/infinichat/src/pi/infinichat` (its tests in `packages/infinichat/test`), the
conversation's service over it `infinichat-service.ts`, and what moves it between devices `infinichat-remote/`. For a
detailed walkthrough and architecture diagrams of context assembly, turns, summaries, zoom, and the agent tree, see
[`docs/infinichat-harness/`](infinichat-harness/README.md). A machine's server is described in
`docs/server-plugins.md`.

## What UniiChat has, and what carries it here

| UniiChat (`ff32319`) | Here | Carried by |
| --- | --- | --- |
| A tree of agents, each with one chat that never ends, in a folder of its own (`Server.ts`) | Every agent is a pi-durable conversation of one session, owned by an anchor task; the tree is one document of root's conversation, so a spawn names and lists its child in one commit (`agents.ts`) | Conversations and task ownership, `22-subagent-background.ts`; `defineDoc` |
| The memory tree: a line per message, lines merged in pairs; the view of the whole chat, which changes only at its end (`Memory.ts`) | `memory.ts` keeps the messages, the nodes and the views as documents of the agent's conversation; a summary is a task (`summary.ts`, `BuildNode`) | `defineDocFamily`, `defineTask` |
| Summaries are built as messages arrive, `JOBS` at once, and one that ends starts the next (`Memory.pump`) | A build starts the builds it frees in the commit that publishes its line, or records its failure (`pumpBuilds`) | A task's own commit |
| Each call gets the view, then its new messages; one prompt for every agent, so all share the cache (`Tools.ts`) | A turn starts with a reset and one user message: the view, then the host's turn state and the agent's place, then the new messages. The prompt is one extension section | `ResetEntry`; `section` of an extension |
| `zoom` and `date` read the agent's own chat | The same tools, on the memory of the conversation the call is made in (`tools.ts`) | A tool call's conversation |
| An agent talks only to its parent and its children, by `tell`; its final reply is kept for itself; root answers the user by `tell("user")` | `tell` admits a message into the other agent's conversation in the caller's commit; a reply is logged in the agent's own memory and sent nowhere (`agents.ts`, `app.ts`) | A commit across conversations, `34-submit-in-commit.ts` |
| Only a message wakes an agent, and it is awake while its turn runs (`Unii.turn`) | The commit that admits a message to an agent at rest starts its turn's coordinator, a task that ends with the turn. While it waits it holds no invocation: it sleeps on a signal. "Awake" is a live coordinator, for the place and for the screens | Signals and sleeps, `38-signals.ts`; `SubmissionSettled`, `43-subagent-waits.ts` |
| A message reaches the running call between tool calls, else the next call | A message for a running turn is admitted as a steer of its run; otherwise it opens the next turn | `whenBusy: 'steer'` |
| A tool call's entries are logged as they are made (`Unii.on`) | A tool round is logged as it ends, in a task its generation waits for, so its summaries start while the turn runs | `afterTools` and a hook task, `46-after-tools-terminate.ts` |
| A stopped turn wakes again for the messages it never took | A stop ends the run; the messages it had not taken are submitted anew and start the next turn (`countRequeued`, `requeueAborted`) | Withdrawal of a queued submission |
| An act that would change a chat twice is recorded first and answered from its record (`Memory.acted`) | A request ID admits its input once: the same ID with the same input is the same admission, also after a restart (`admitInput`) | A document written in the admitting commit |
| `spawn`, `hide`, `show`, `list`; a spawn is whole or not at all; a child starts with only its task | The same tools, a spawn in one commit, with optional `cwd` for an existing project directory and without UniiChat's "user's OK" gate (owner, 2026-11-25) | One commit |
| Thoughts are for the views alone: no call gets them back | Thinking stays in pi-durable's own history, which the transcript shows; memory logs replies, tool calls and results | Native entries |
| Every window is a view on the hub's chats | On a machine, the server's store object holds the conversation's state, and each app holds `infinichat.remote` and, per agent on screen, `infinichat.agent`. On the phone the app is the host | Chord contracts and references (`docs/server-plugins.md`) |

## Where InfiniChat differs

- **One process.** UniiChat runs each awake agent in a process of its own, which ends with the turn and kills what
  it started. A pi-durable session has one writing process, and every agent of the tree is a conversation of that
  one session, so all agents run in the host's process: the app on the phone, the server on a machine. Chord's
  workers would give a process per address, each with its own store, which is not one session.
- **Project directories and devices, not worktrees.** A UniiChat agent works in a git worktree its parent reviews
  and merges, and every command runs on the server. A child here may be spawned with an optional project `cwd`
  (`~/…` or `/…`), which its tools start in on any machine where that directory exists, falling back to its default
  scratch folder `<work>/<name>` elsewhere (and on the phone) without auto-creating missing project paths
  (`device-tools.ts`). Nothing commits or merges for it.
- **A message is logged when a call takes it.** UniiChat logs a message as it arrives. Here an admitted message
  waits in the agent's input documents and enters memory as the call that takes it starts, so memory holds it where
  the model read it.
- **A restart resumes.** UniiChat cuts the turns that ran and tells each so in a note. pi-durable resumes the tasks
  a close or a crash interrupted, so a turn goes on where it was, with no note. On a machine the Harness opens
  paused until every plugin has loaded, so a tool call a restart cut off finds its tool.
- **A child starts on its parent's model**, as pi-durable copies an owner's agent; UniiChat starts it on the
  server's default.
- **Left out:** `/goal`, chat imports (and the `ai` kind), and UniiChat's `mac` and screen tools: a machine's
  agents operate its desktop through Cua Driver, an MCP server, instead (`docs/server-plugins.md`). Nothing in code
  asks for approval of a `spawn`, as nothing does in UniiChat.

## What InfiniChat adds

- **Scheduled tasks.** UniiChat has "nothing runs on a clock" (its D16). Root can schedule a message to itself
  (`schedule.ts`): one background task per conversation, found again by its key
  (`api.createTask(…, { key: 'scheduled' })`), which sleeps until a task is due and admits its message as any other.
  The tools are root's alone.
- **Continue.** A run that ended without an answer can be continued: the host's commit opens the turn and names the
  Continue, and the coordinator submits it, so its end is told as an input's is.
- **Structured questions and ephemeral credentials (`ask_user`, `SecretVault`).** Any agent in the tree can park
  on `ask_user` (`ask.ts`, following pi-durable `39-ask-a-person.ts` and `40-tool-waits-for-webhook.ts`) with a batch
  of `text` and `secret` questions, offered directly beside `codemode`, `tell` and `spawn`. Secret values never enter
  pi-durable signals, SQLite, Memory, or sync folders: the host keeps them in RAM (`secrets.ts`, 30 min TTL, wiped on
  clear/relinquish/restart), returns opaque handles (`{{secret:s_...}}`), resolves handles at `bash` (`secrets` env
  map), `write`, `edit`, and MCP (`mcp-tools.ts`) execution boundaries, and redacts active values across tool outputs.
- **Code mode and MCP on a machine**, with the images in their results fitted to the model before they are stored
  (`docs/server-plugins.md`).
- **The conversation moves** between the phone and machines, below.

## The conversation's store, and moving it

Only one side holds the conversation at a time, and only the holder opens it: the phone's home record
(`infinichat-remote/home.ts`) and each server's `state.json` say who. pi-durable has no lock across processes, so
those records are the authority, and a move writes each phase before the step that needs it.

**The store.** The conversation is kept in a Chord store (`infinichat-store.ts`): pi-durable's `StoreStorage` over
`openStore(sqliteBackend(…))`, on Node's SQLite on a machine and expo-sqlite on the phone, in
`infinichat-store.db`. Upstream's examples give a host its store (`35-durable-on-the-store.ts`,
`37-harness-registry.ts`); here the store is the conversation's, opened and closed by whoever holds it, because the
conversation comes to a device and leaves it while that device's host lives. The phone's and the Mac's ordinary
chats stay on pi-durable's own `SqliteStorage`.

**The conversion.** A conversation the releases before server 5.1.0 left in `infinichat.db`, pi-durable's own
storage, becomes the store once, when its holder first opens it (`infinichat-convert.ts`): copied record by record
into a store aside, which takes the store's name only when the copy is whole. Upstream has no converter between its
storages; this one is the owner's exception to the rule against migration code (2026-11-20). The server keeps the
old file in `backup/before-<release>/` first, as it does before any release first opens the database.

**A move** is Chord's session sync (`@earendil-works/chord/sync`, experimental), as its test "hands a session back
and forth" does it (`infinichat-remote/sync.ts`, `move.ts`). The side that gives the conversation closes its
Harness and uploads what its store committed since the two sides last shared it; the side that takes it applies
that to its copy and opens it once the copy ends where the giver said the conversation does. The remote is a folder
on a machine, `~/.infinichat/sync`, Chord's own `FileSystemSyncRemote` over the files of whatever reaches it, as
p2's backup to a folder is (`apps/p2/src/runtime/backup.ts`):

| Move | Folder | Who uploads | Who applies |
| --- | --- | --- | --- |
| Phone to machine | The machine's | The phone, through its connection's environment | The machine's server, from its own disk (`pull`) |
| Machine to phone | The machine's | The machine's server (`relinquish`) | The phone, through its connection's environment |
| Machine to machine | The giver's own; or the taker's, when the giver took the conversation from it | The giver's server | The taker's server, over its own SSH or from its own disk |

Each side that has held the conversation keeps its store as its copy, which nothing but the next move there
touches. Each keeps a bookmark per folder, what its copy last shared with it: the phone with its settings, a
machine in `~/.infinichat/synced/`.

Where this is not upstream's use of sync:

- **Several folders.** Upstream has one remote, and devices upload as they commit. A folder here hears of the
  conversation only when it moves through it, so its history can be behind a conversation that went another way.
  Where the giver does not continue a folder's history, the folder starts over with the giver's whole store; where
  a taker's copy is not one the folder continues, the taker restores the whole store beside its copy and puts it in
  its place (a machine keeps the copy it replaces in `released/`). Upstream forks a copy that diverged; here the
  holder's store is the conversation.
- **A machine gives the conversation back through the folder it took it from**, so two machines that pass it
  between them share one folder's history, and each move sends only what the other lacks.
- **Uploads happen at moves only.** A folder remote lists every slot on every upload and pull, one file read each,
  so nothing uploads from a live store, and nothing keeps a copy fresh between moves. A holder's outbox then grows
  with every commit, and a commit rewrites the documents it changes whole, so a long stay's commits are several
  times the store. A holder drops an outbox of more than 10,000 commits (`openInfiniChatStore`), and its next move
  sends the store whole. A store that has never moved keeps no outbox.
- **Compression on the phone.** Sync gzips through `CompressionStream`, which Hermes lacks; a library supplies it
  (`apps/mobile/src/pi/compression-streams.ts`), the one polyfill the app adds, by the owner's exception.

What a move costs, on a copy of the owner's conversation (9,535 messages, a 216 MB store): the whole store is 73 MiB
to send, a turn is about 0.1 MiB, and a hop to another device and back, after the first, sends only the turns made
there.

**The contract.** `infinichat.remote` is at version 13 (bounded live `messages` window with `transcriptBounds` and
per-client stateless `loadHistory` pagination, added over v12's `ask_user` / secrets) and `infinichat.agent` is at
version 2. Apps on versions 8 to 12 keep chatting with a newer server;
versions 8 to 10 have moves refused with a message to update the app (`docs/server-plugins.md`, "Contract versions").

## Choices that are the implementer's, for the owner to change

From the tree of agents (2026-11-18):

1. On a machine the model is offered `tell` and `spawn` beside code mode, as its own calls, so what an agent says is
   a call of its transcript and never a line of a script.
2. The schedule tools are root's, an extension a child goes without.
3. The compaction rules keep the release's text (`0500bf6`) with the tree's words for whom a line serves, without
   the withdrawn prompt's other changes to how a line is written.

From the turn, the store and the move (2026-11-20):

4. `restartLimit` stays `Infinity`: on a phone every iOS kill of the app counts for whatever task ran then, and a
   summary's build pi-durable ended for it would keep its place and never write its line.
5. `onAbort: 'keep'` is not used for a stopped turn's messages: it places a kept message ahead of the next turn's
   view, which breaks the shape every call has and its cache, and it does not wake the agent. The requeue is
   InfiniChat's own.
6. The outbox's limit of 10,000 commits, about half of what the owner's whole store is to send.
7. Nothing keeps a copy fresh between moves, where launch and each return from the background did for the page
   diffs: a move after a long stay sends the whole store.
8. A phone gives into the folder of the machine that takes the conversation, also when it took it from another
   machine, which sends the store whole and compresses it on the phone. Giving it through the folder it was taken
   from, for the taker to read over SSH, would send only the phone's commits.
