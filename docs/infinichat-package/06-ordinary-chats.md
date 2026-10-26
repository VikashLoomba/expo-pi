# Piece 6: Ordinary chats

## Goal

The ordinary chat service moves into the package, so the Mac app can have its own ordinary chats, in its own
database, as the phone has its own (owner decision, 2026-10-26). The iPhone passes in what is host-specific. Nothing
changes on the phone. This piece needs only pieces 1 and 2, so it can come right after them.

## Starts from

- `src/pi/chat-service.ts` (403 lines) has the same shape as `InfiniChatService`. It imports pi packages and files
  piece 2 already moves (`chat-view`, `chat-projection`, `chat-metadata`, `model-catalog`, `model-auth`, `user-input`,
  `workspace/document`, `execution/document`, `native-web-search/durable`), plus five host-specific imports:

  | Import | Used for | Where |
  | --- | --- | --- |
  | `createExpoImages` (`images.ts`: expo-file-system, expo-image-manipulator) | `createCodingTools({ images })` | `:87` |
  | `WorkspaceExecutionEnv` (`workspace/execution-env.ts`: just-bash) | A chat's local environment | `:109` |
  | `Workspaces` (`workspace/storage.ts`, types only) | The local environment, and removing a deleted chat's workspace | `:62`, `:109`, `:316` |
  | `RemoteExecution` (`execution/remote/owner.ts`, type only; react-native-ssh behind it) | A chat on a configured machine | `:102` |
  | `chatTasks`, `KeepAliveController` (`keep-alive/controller.ts`, which imports `expo-location`) | Counting the chats' live work | `:131` |

- The Harness's `env` already follows pi's sandbox-per-conversation example (`chat-service.ts:100-110`, upstream
  `packages/durable/test/examples/29-sandbox-per-conversation.ts`): each tool call reads the chat's committed target
  and builds an environment for it. Only the builders are host-specific.
- `native-web-search/provider.ts` imports only pi-ai and files piece 2 moves, so it can move too.
- The phone's `src/pi/models.ts` and the server's `server/models.ts` register the same providers. The phone adds its
  native OpenAI sign-in (`openai-auth/index.ts`, native browser) and `withNativeWebSearch`.

## Builds

### `DurableChatService` takes its host-specific parts

```ts
static async open(options: {
  storage: Storage; models: Models; now?: () => number;
  /** Prepares photos for `read` (pi-durable "Images"). */
  images: ImageProcessor;
  /** A chat's own environment on this device, and removing it with the chat; none, and tools fail as today. */
  local?: { environment(workspaceId: string, cwd: string | undefined): ExecutionEnv; remove(workspaceId: string): void };
  /** A chat on a configured machine. */
  machines: { environment(machineId: string, cwd: string | undefined): Promise<ExecutionEnv> };
  /** Counts live work while open; returns its detach. */
  observe?: (harness: Harness) => () => void;
  newChat?: NewChatDefaults; authError?: (providerId: string) => string | undefined;
  onClosed?: (end: SessionEnd) => void;
}): Promise<DurableChatService>
```

| Input | iPhone | Mac |
| --- | --- | --- |
| `images` | `createExpoImages()` | pi-durable's Photon processor, as `server/devices.ts` builds it |
| `local` | `WorkspaceExecutionEnv` over the device's workspaces | A folder per chat with `NodeExecutionEnv`, as upstream's `29-sandbox-per-conversation.ts` does ("Here a sandbox is a directory"); tools run real commands there |
| `machines` | `owner.ts`'s `environment` | pi-env `RemoteExecutionEnv`, through the `node` subpath's machines owner (piece 5) |
| `observe` | `keepAlive.observe(harness, chatTasks)` | None: a Mac doesn't suspend work |
| `storage` | `openExpoSqliteStorage('pi-chats.db')` | `openNodeSqliteStorage` |

`chatTasks` and `infiniChatTasks` (`keep-alive/controller.ts:21`, `:30`) are pure predicates over a task. Move them
into the package next to the services they describe; the keep-alive controller imports them back.

### Also moving

- `native-web-search/provider.ts` (`withNativeWebSearch`).
- Optionally, one `registerChatProviders(models)` for the provider list both model factories repeat today. The phone
  and the Node side keep their own credential stores and sign-in flows.

### What stays in the iOS app

`images.ts`, `workspace/{execution-env,device-storage,storage,files}.ts`, `execution/remote/*`, `keep-alive/*`,
`openai-auth/{browser,installation,index}.ts`, `models.ts`, and the provider wiring.

## Ownership and lifetime

Unchanged on the phone. The provider still creates the service, the keep-alive controller and the remote owner, and
closes them in today's order. The service borrows `machines` and `local`, and calls `observe`'s detach when it closes.

## Deviations (need approval)

- `DurableChatService.open` takes builders instead of `Workspaces`, `RemoteExecution` and `KeepAliveController`.

## Size

`chat-service.ts` moves with about 20 lines changed at its seams, plus the two predicates and the web search provider.
The phone's wiring grows by about as much.

## Checks

- Lint, typecheck, server typecheck (unaffected).
- On the iPhone Release install:
  - A chat in the phone's workspace: a tool call reads and writes a file.
  - A chat on vikash-system: a tool call runs there.
  - A photo in a chat: `read` prepares it.
  - Web search with an OpenAI model: the sources show.
  - The keep-alive Live Activity appears while a chat works with the app in the background.
  - Deleting a chat removes its workspace.

## Not in this piece

The Mac app's chat screens. Sharing ordinary chats between devices is not planned: each device keeps its own.
