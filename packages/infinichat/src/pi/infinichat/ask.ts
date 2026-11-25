import type { Context } from '@earendil-works/chord/context';
import {
  ROOT_CONVERSATION_ID, defineSignal, defineTool, type ConversationId, type Harness, type TaskId,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import {
  arr, bool, compile, lit, num, obj, oneOf, opt, str, type Static,
} from '@earendil-works/pi-schema';

import { ROOT, TreeDoc } from './agents';
import type { SecretVault } from './secrets';

/** Built-in tool name and signal name for user questions, matching pi-durable's parked-tool pattern. */
export const ASK_USER_TOOL = 'ask_user';
export const ASK_ANSWER_SIGNAL = 'optchat.ask-answer';
const ANSWER_KEY = 'answer';

export const QuestionKindSchema = oneOf(['text', 'secret']);
export type QuestionKind = Static<typeof QuestionKindSchema>;

/** One question in a batch asked by an agent. `purpose` is required when `kind` is `secret`. */
export const QuestionItemSchema = obj({
  id: str({ minLength: 1, description: 'Unique identifier for this question within the batch' }),
  kind: QuestionKindSchema,
  label: opt(str({ description: 'Short label for the field, e.g. "Sudo password" or "Environment"' })),
  prompt: str({ minLength: 1, description: 'The question shown to the user' }),
  purpose: opt(str({
    description: 'Required when kind is "secret": explain clearly what you will do with this credential.',
  })),
  placeholder: opt(str({ description: 'Optional input placeholder text' })),
}, { open: true });
export type QuestionItem = Static<typeof QuestionItemSchema>;

const AskUserParameters = obj({
  title: opt(str({ description: 'Optional short heading for this set of questions' })),
  questions: arr(QuestionItemSchema, {
    description: 'One or more questions for the user (general "text" and/or sensitive "secret" inputs).',
  }),
}, { open: true });

/** A parked `ask_user` batch waiting for the user, as screens display it. */
export const PendingQuestionBatchSchema = obj({
  taskId: num(),
  agent: str(),
  title: opt(str()),
  questions: arr(QuestionItemSchema),
  createdAt: num(),
}, { open: true });
export type PendingQuestionBatch = Static<typeof PendingQuestionBatchSchema>;

/** One answer sent by a client (closed for Chord method arguments); secret `value` goes to RAM before signaling. */
export const UserQuestionAnswerSchema = obj({
  id: str(),
  skipped: bool(),
  value: opt(str()),
  note: opt(str()),
});
export type UserQuestionAnswer = Static<typeof UserQuestionAnswerSchema>;

/** One answer stored in the durable signal: secrets carry only their opaque handle, never the raw value. */
const SanitizedAnswerSchema = obj({
  id: str(),
  skipped: bool(),
  value: opt(str()),
  handle: opt(str()),
  note: opt(str()),
}, { open: true });
type SanitizedAnswer = Static<typeof SanitizedAnswerSchema>;

export const AskAnswer = defineSignal({
  name: ASK_ANSWER_SIGNAL,
  version: 1,
  schema: obj({ answers: arr(SanitizedAnswerSchema) }),
});

/** What `ask_user` stores in its durable park checkpoint so restarts keep showing the pending questions. */
const AskCheckpointSchema = obj({
  title: opt(str()),
  questions: arr(QuestionItemSchema),
  createdAt: num(),
}, { open: true });
type AskCheckpoint = Static<typeof AskCheckpointSchema>;

/** pi-durable's parked tool checkpoint wrapper (`durable/src/harness/tool.ts`, `park`). */
const isParkedAskCheckpoint = compile(obj({
  phase: lit('parked'),
  checkpoint: AskCheckpointSchema,
}, { open: true }));

function formatReply(questions: readonly QuestionItem[], answers: readonly SanitizedAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const lines: string[] = [];
  let hasSecretHandle = false;
  for (const question of questions) {
    const answer = byId.get(question.id);
    const title = question.label ? `${question.id} (${question.label})` : question.id;
    if (!answer || answer.skipped) {
      lines.push(`- ${title}: [skipped]`);
    } else if (question.kind === 'secret') {
      if (answer.handle) {
        hasSecretHandle = true;
        lines.push(`- ${title}: secret handle ${answer.handle}`);
      } else {
        lines.push(`- ${title}: [skipped]`);
      }
    } else {
      lines.push(`- ${title}: ${answer.value ?? ''}`);
    }
    if (answer?.note) lines.push(`  note: ${answer.note}`);
  }
  if (hasSecretHandle) {
    lines.push('');
    lines.push('Use secret handles without exposing them: pass them to bash via the `secrets` env map '
      + '(e.g. secrets: { PW: "{{secret:...}}" } and reference "$PW"), or directly in MCP tool, write, or edit '
      + 'arguments. Never print secrets or type them into unmasked fields before taking a screenshot.');
  }
  return lines.join('\n');
}

/**
 * Unified question and secure-credential tool, offered directly to the model on every agent of the tree (root and
 * children). Parks durably on `AskAnswer` (pi-durable `test/examples/39-ask-a-person.ts` and
 * `40-tool-waits-for-webhook.ts`) so waiting for the user holds no process or QuickJS worker and survives restarts.
 */
export function askUserTool(): ToolRegistration {
  return defineTool<typeof AskUserParameters, { title?: string; questions: QuestionItem[]; status: string },
    AskCheckpoint>({
    name: ASK_USER_TOOL,
    description: 'Ask the user one or more questions in a single form and wait for their response. Supports both '
      + 'general inputs (kind: "text") and sensitive credentials (kind: "secret", such as sudo or website passwords). '
      + 'Always batch related questions into one call. For "secret" questions, you must provide a clear "purpose" '
      + 'explaining what you will do with the credential. Secret answers return an opaque handle ({{secret:...}}) '
      + 'instead of the raw value: pass handles to bash via its `secrets` env map (and reference "$VAR"), or directly '
      + 'in MCP tool (e.g. cua-driver), write, or edit arguments. Never ask the user to paste passwords into chat, '
      + 'never print secrets, and never type secrets into unmasked fields before taking a screenshot. The user can '
      + 'skip any question and may include additional notes alongside any answer or skip.',
    parameters: AskUserParameters,
    callers: ['model'],
    replay: 'safe',
    async execute(args, api, context) {
      const state = await api.readSignal(AskAnswer, ANSWER_KEY, context);
      if (state !== undefined && 'value' in state) {
        const questions = api.checkpoint?.questions ?? args.questions;
        const title = api.checkpoint?.title ?? args.title;
        return {
          output: [{ type: 'text', text: formatReply(questions, state.value.answers) }],
          details: { ...(title === undefined ? {} : { title }), questions, status: 'answered' },
        };
      }
      if (state !== undefined) {
        return { output: [{ type: 'text', text: 'The question expired before the user answered.' }], isError: true };
      }
      if (args.questions.length === 0) {
        throw new Error('Provide at least one question in questions.');
      }
      const seen = new Set<string>();
      for (const question of args.questions) {
        if (seen.has(question.id)) {
          throw new Error(`Duplicate question id ${JSON.stringify(question.id)}.`);
        }
        seen.add(question.id);
        if (question.kind === 'secret' && !question.purpose?.trim()) {
          throw new Error(`Secret question ${JSON.stringify(question.id)} requires a non-empty purpose.`);
        }
      }
      const checkpoint: AskCheckpoint = {
        ...(args.title === undefined ? {} : { title: args.title }),
        questions: args.questions,
        createdAt: api.now(),
      };
      await api.details({ ...checkpoint, status: 'waiting' }, context);
      return {
        sleep: {
          signals: [AskAnswer.key(ANSWER_KEY)],
          checkpoint,
        },
      };
    },
  });
}

/** One-line banner text for pending question batches across the tree, shared by iOS and Mac screens. */
export function pendingQuestionsBanner(batches: readonly PendingQuestionBatch[], rootName: string): string {
  if (batches.length === 1) {
    const batch = batches[0];
    const count = batch.questions.length;
    const hasSecret = batch.questions.some((question) => question.kind === 'secret');
    const what = hasSecret
      ? (count === 1 ? 'a credential' : `${count} questions (includes credential)`)
      : (count === 1 ? 'a question' : `${count} questions`);
    return batch.agent === ROOT ? `Waiting for your input · ${what}` : `${batch.agent} is asking ${what}`;
  }
  const agents = [...new Set(batches.map((batch) => batch.agent === ROOT ? rootName : batch.agent))];
  return `${batches.length} requests waiting for your input (${agents.join(', ')})`;
}

/** Whether a live task graph node is a parked `ask_user` call waiting for the user. */
export function isAskSleepNode(state: {
  readonly status: string;
  readonly signals?: readonly { readonly signal: string; readonly key: string }[];
}): boolean {
  return state.status === 'sleeping'
    && (state.signals?.some((entry) => entry.signal === ASK_ANSWER_SIGNAL && entry.key === ANSWER_KEY) ?? false);
}

async function agentNamesByConversation(harness: Harness, context: Context): Promise<Map<ConversationId, string>> {
  const names = new Map<ConversationId, string>();
  const tree = await harness.snapshot(TreeDoc, ROOT_CONVERSATION_ID, context);
  if (tree !== undefined) {
    for (const [name, agent] of Object.entries(tree.agents)) names.set(agent.conversationId, name);
  }
  if (!names.has(ROOT_CONVERSATION_ID)) names.set(ROOT_CONVERSATION_ID, ROOT);
  return names;
}

/** Inspects pi-durable's live tasks for every parked `ask_user` call across the agent tree, oldest first. */
export async function waitingQuestions(harness: Harness, context: Context): Promise<PendingQuestionBatch[]> {
  const [{ tasks }, names] = await Promise.all([
    harness.inspect(context),
    agentNamesByConversation(harness, context),
  ]);
  const pending: PendingQuestionBatch[] = [];
  for (const { record } of tasks) {
    if (record.kind !== 'pi.tool' || record.abortRequested || !isAskSleepNode(record.state)) continue;
    if (!('checkpoint' in record.state) || !isParkedAskCheckpoint.check(record.state.checkpoint)) continue;
    const { title, questions, createdAt } = record.state.checkpoint.checkpoint;
    pending.push({
      taskId: record.id,
      agent: names.get(record.conversationId) ?? ROOT,
      ...(title === undefined ? {} : { title }),
      questions,
      createdAt,
    });
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt || left.taskId - right.taskId);
}

/**
 * Delivers the user's answers to parked `ask_user` task `taskId`, looked up among live tasks so no TaskId is ever
 * minted. Secret values are stored only in `secrets` (RAM) before signaling, and revoked if signaling loses a race.
 */
export async function answerQuestionBatch(
  harness: Harness,
  secrets: SecretVault,
  taskId: number,
  answers: readonly UserQuestionAnswer[],
  context: Context,
): Promise<void> {
  const [{ tasks }, names] = await Promise.all([
    harness.inspect(context),
    agentNamesByConversation(harness, context),
  ]);
  let found: { id: TaskId; agent: string; questions: readonly QuestionItem[] } | undefined;
  for (const { record } of tasks) {
    if (record.id !== taskId || record.kind !== 'pi.tool' || record.abortRequested || !isAskSleepNode(record.state)) {
      continue;
    }
    if (!('checkpoint' in record.state) || !isParkedAskCheckpoint.check(record.state.checkpoint)) continue;
    found = {
      id: record.id,
      agent: names.get(record.conversationId) ?? ROOT,
      questions: record.state.checkpoint.checkpoint.questions,
    };
    break;
  }
  if (found === undefined) throw new Error('Those questions are no longer waiting for an answer.');
  const provided = new Map(answers.map((answer) => [answer.id, answer]));
  const mintedIds: string[] = [];
  const sanitized: SanitizedAnswer[] = [];
  try {
    for (const question of found.questions) {
      const entry = provided.get(question.id);
      const note = entry?.note?.trim() || undefined;
      if (!entry || entry.skipped) {
        sanitized.push({ id: question.id, skipped: true, ...(note === undefined ? {} : { note }) });
        continue;
      }
      const value = entry.value ?? '';
      if (question.kind === 'secret') {
        if (!value) {
          sanitized.push({ id: question.id, skipped: true, ...(note === undefined ? {} : { note }) });
          continue;
        }
        const minted = secrets.mint({
          value,
          label: question.label?.trim() || question.prompt,
          purpose: question.purpose?.trim() || question.prompt,
          agent: found.agent,
        });
        mintedIds.push(minted.id);
        sanitized.push({
          id: question.id,
          skipped: false,
          handle: minted.handle,
          ...(note === undefined ? {} : { note }),
        });
      } else {
        sanitized.push({
          id: question.id,
          skipped: false,
          value,
          ...(note === undefined ? {} : { note }),
        });
      }
    }
    const result = await harness.signal(found.id, AskAnswer, ANSWER_KEY, { answers: sanitized }, context);
    if (result !== 'delivered') {
      for (const id of mintedIds) secrets.clear(id);
      throw new Error('Those questions were already answered or cancelled.');
    }
  } catch (error) {
    for (const id of mintedIds) secrets.clear(id);
    throw error;
  }
}
