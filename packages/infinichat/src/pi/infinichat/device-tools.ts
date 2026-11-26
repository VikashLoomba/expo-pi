import type { Context } from '@earendil-works/chord/context';
import {
  AgentDoc, ROOT_CONVERSATION_ID, defineTool, type ConversationId, type DocumentReader, type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor,
} from '@earendil-works/pi-durable/tools';
import { map, opt, str, type Schema } from '@earendil-works/pi-schema';

import { TreeDoc, agentNamed, isProjectDir } from './agents';
import type { OptChatExtensionOptions } from './app';
import type { SecretVault } from './secrets';

/**
 * UniiChat's work dirs: a device's tools run in <work>/<who>, `main` for root and its name for any other agent.
 * A machine's work dir is a folder of its own in the account's home, as UniiChat's `~/.unii/work`.
 */
export const MACHINE_WORK = '.infinichat/work';
/** How the device list describes a machine, also on the machine itself once the conversation moves there. */
export const machineDescription = (host: { username: string; hostname: string }) =>
  `${host.username}@${host.hostname} over SSH, work dir ~/${MACHINE_WORK}`;

/** Resolves an agent's project directory (`~`, `~/…`, or `/…`) against a machine's account home directory. */
export function resolveMachineDir(home: string, dir: string): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${dir.slice(2)}`;
  return dir;
}

/** Checks whether `path` is an existing directory (following symlinks); propagates cancellation. */
async function isDirectory(env: ExecutionEnv, path: string, context: Context): Promise<boolean> {
  const info = await env.fileInfo(path, context);
  if (!info.ok) {
    if (info.error.code === 'aborted') throw info.error;
    return false;
  }
  if (info.value.kind === 'directory') return true;
  if (info.value.kind !== 'symlink') return false;
  const resolved = await env.canonicalPath(path, context);
  if (!resolved.ok) {
    if (resolved.error.code === 'aborted') throw resolved.error;
    return false;
  }
  const target = await env.fileInfo(resolved.value, context);
  if (!target.ok) {
    if (target.error.code === 'aborted') throw target.error;
    return false;
  }
  return target.value.kind === 'directory';
}

/** One device InfiniChat's tools run on, as the devices list at the start of each message names it. */
export type Device = {
  name: string;
  description: string;
  /** The device's environment in <work>/<who>, or at project directory `dir` when provided and supported. */
  environment(who: string, read: DocumentReader, context: Context, dir?: string): Promise<ExecutionEnv>;
};

/**
 * What InfiniChat's tools need from the host it runs on, and `env`, the conversation's environment
 * (`HarnessOptions.env`): the device holding the chat, which pi-durable's own tools, such as code mode, run on.
 */
export type InfiniChatDevices = Required<Pick<OptChatExtensionOptions, 'tools' | 'callEnv' | 'turnState' | 'env'>>;

const deviceParameter = str({
  description: 'The device to run on, from the list at the start of the message; by default the one holding this chat',
});
const secretsParameter = opt(map(str(), {
  description: 'Optional map of environment variable names to secret handles from ask_user (e.g. '
    + '{ SUDO_PW: "{{secret:...}}" }), injected into the command environment without exposing values.',
}));

/**
 * A built-in tool's parameters with an optional `device` first: the same JSON Schema object, as pi's built-in tools
 * write theirs with pi-schema (an open object, `durable/src/tools/bash.ts`), typed as the values it accepts the way
 * pi-schema's own builders type theirs. pi-schema has no combinator that adds a property to an object schema.
 */
function withDevice<T>(parameters: Schema<T>): Schema<T & { device?: string }> {
  // Its keywords as plain data, so the copy carries no value type of its own.
  const keywords = Object.fromEntries(Object.entries(parameters));
  const own = typeof keywords.properties === 'object' && keywords.properties !== null ? keywords.properties : {};
  return { ...keywords, properties: { device: deviceParameter, ...own } };
}

/** `bash` parameters with optional `device` and `secrets` env-var bindings. */
function withBashParameters<T>(
  parameters: Schema<T>,
): Schema<T & { device?: string; secrets?: Record<string, string> }> {
  const keywords = Object.fromEntries(Object.entries(parameters));
  const own = typeof keywords.properties === 'object' && keywords.properties !== null ? keywords.properties : {};
  return { ...keywords, properties: { device: deviceParameter, ...own, secrets: secretsParameter } };
}

/**
 * What a device tool keeps of the built-in registration; its schema gains `device` and `execute` injects that env.
 * Its description says where it runs, as UniiChat's does.
 */
const kept = ({ name, description, replay, outputLimits, structuredOutputSchema, callers }: ToolRegistration) => ({
  name,
  description: `${description} It runs on the device named, or the one holding this chat when none is, in the `
    + 'agent\'s project directory if set and present there, otherwise in <work>/<who> (<work> being the work dir '
    + 'the devices list gives for it and <who> main for root, or another agent\'s own name).',
  replay,
  outputLimits,
  structuredOutputSchema,
  callers,
});

/** The device a call's raw arguments name, kept through argument repair; none for the device holding the chat. */
const deviceArgument = (args: unknown): { device?: string } =>
  typeof args === 'object' && args !== null && 'device' in args && typeof args.device === 'string'
    ? { device: args.device } : {};

/**
 * The devices `list` returns, read at each use since they change, the first being the one holding the chat, as
 * InfiniChat's tools use them: pi-durable's bash, read, write and edit with an optional `device`, each calling the
 * built-in's `execute` with that device's environment, the holder's when none is named, as the Harness injects `env`
 * into every call. The holder is also the conversation's environment. Each use builds a fresh environment, as the chat
 * service's resolver does.
 */
export function infiniChatDevices(
  list: () => Promise<readonly Device[]>, images: ImageProcessor, secrets?: SecretVault,
): InfiniChatDevices {
  /** The device's environment, the holder's without a name, in the calling conversation's folder as UniiChat's. */
  async function environment(
    name: string | undefined, read: DocumentReader, conversationId: ConversationId, context: Context,
  ): Promise<ExecutionEnv> {
    const devices = await list();
    // The host keeps device names unique, so a name is one device.
    const device = name === undefined ? devices[0] : devices.find((candidate) => candidate.name === name);
    if (!device) {
      const names = devices.map((candidate) => JSON.stringify(candidate.name)).join(', ');
      throw new Error(`Unknown device ${JSON.stringify(name)}. The devices are ${names}.`);
    }
    // A child's `AgentDoc.cwd` holds either its own name (scratch folder) or a project path (`~` / `/…`).
    let who = 'main';
    let dir: string | undefined;
    if (conversationId !== ROOT_CONVERSATION_ID) {
      const stored = (await read.snapshot(AgentDoc, conversationId, context))?.cwd;
      if (stored !== undefined && isProjectDir(stored)) {
        dir = stored;
        const tree = await read.snapshot(TreeDoc, ROOT_CONVERSATION_ID, context);
        who = (tree && agentNamed(tree.agents, conversationId)) ?? 'main';
      } else {
        who = stored ?? 'main';
      }
    }
    if (dir !== undefined) {
      // Never auto-create a missing project path on a device that doesn't hold that repo; fall back to scratch dir.
      const candidate = await device.environment(who, read, context, dir);
      if (await isDirectory(candidate, candidate.cwd, context)) return candidate;
    }
    const env = await device.environment(who, read, context);
    getOrThrow(await env.createDir(env.cwd, { recursive: true }, context));
    return env;
  }
  // Per-call resolved secret env vars carried into `createBashTool({ prepare })` without mutating stored args.
  const injectedEnvs = new WeakMap<ToolExecutionApi, Readonly<Record<string, string>>>();
  const bash = createBashTool({
    prepare: (execution, callApi) => {
      const extra = injectedEnvs.get(callApi);
      if (extra !== undefined) Object.assign(execution.env, extra);
    },
  });
  const read = createReadTool({ images });
  const write = createWriteTool();
  const edit = createEditTool();
  const prepareEdit = edit.prepareArguments;
  const envFor = (device: string | undefined, api: DocumentReader & { conversationId: ConversationId },
    context: Context) =>
    environment(device, api, api.conversationId, context);
  return {
    tools: [
      defineTool({
        ...kept(bash),
        parameters: withBashParameters(bash.parameters),
        execute: async ({ device, secrets: bindings, ...args }, api, context) => {
          if (secrets?.containsHandle(args.command)) {
            throw new Error('Pass secret handles to bash through the `secrets` map '
              + '(e.g. secrets: { PW: "{{secret:...}}" }) and reference "$PW" in command.');
          }
          let resolvedEnv: Record<string, string> | undefined;
          if (bindings !== undefined && Object.keys(bindings).length > 0) {
            if (secrets === undefined) throw new Error('Secret handles are not available in this host.');
            resolvedEnv = secrets.resolveEnvMap(bindings);
          }
          const env = await envFor(device, api, context);
          const redactor = secrets?.hasActive()
            ? secrets.createStreamRedactor((chunk) => api.output(chunk))
            : undefined;
          const callApi: ToolExecutionApi = redactor === undefined
            ? { ...api, env }
            : {
              ...api,
              env,
              // Transforming streaming output requires dropping outputWindow so skipped chunks never bypass scrubbing.
              outputWindow: undefined,
              output: (chunk) => {
                redactor.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
              },
              retainedOutput: () => {
                redactor.flush();
                return api.retainedOutput();
              },
            };
          if (resolvedEnv !== undefined) injectedEnvs.set(callApi, resolvedEnv);
          try {
            return await bash.execute(args, callApi, context);
          } finally {
            redactor?.flush();
          }
        },
      }),
      defineTool({
        ...kept(read),
        parameters: withDevice(read.parameters),
        execute: async ({ device, ...args }, api, context) =>
          read.execute(args, { ...api, env: await envFor(device, api, context) }, context),
      }),
      defineTool({
        ...kept(write),
        parameters: withDevice(write.parameters),
        execute: async ({ device, ...args }, api, context) => {
          const content = secrets === undefined ? args.content : secrets.resolveString(args.content);
          return write.execute({ ...args, content }, { ...api, env: await envFor(device, api, context) }, context);
        },
      }),
      defineTool({
        ...kept(edit),
        parameters: withDevice(edit.parameters),
        prepareArguments: prepareEdit && ((args) => ({ ...prepareEdit(args), ...deviceArgument(args) })),
        execute: async ({ device, ...args }, api, context) => {
          const edits = secrets === undefined ? args.edits : args.edits.map((item) => ({
            ...item,
            oldText: secrets.resolveString(item.oldText),
            newText: secrets.resolveString(item.newText),
          }));
          return edit.execute({ ...args, edits }, { ...api, env: await envFor(device, api, context) }, context);
        },
      }),
    ],
    /** The device a completed call ran on, so its spilled output is read on the machine that produced it. */
    callEnv(call, target, context) {
      const { device } = call.arguments;
      return environment(typeof device === 'string' ? device : undefined, target.read, target.conversationId, context);
    },
    env: (target, context) => environment(undefined, target.read, target.conversationId, context),
    /** The device list at the start of each message; it changes, so it stays out of the cached prompt. */
    async turnState() {
      const devices = await list();
      return ['Devices:', ...devices.map((device, index) =>
        `${JSON.stringify(device.name)}${index === 0 ? ' (holds this chat, the default)' : ''}: ${device.description}`)]
        .join('\n');
    },
  };
}
