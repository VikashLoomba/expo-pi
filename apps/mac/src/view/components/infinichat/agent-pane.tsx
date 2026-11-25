import type { Held } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { useHold, useWatch } from '@earendil-works/chord/react';
import { pendingQuestionsBanner } from '@pi-agent/infinichat/pi/infinichat/ask';
import {
  getModelSettingsError, type ChatModelSettings, type ModelCatalog,
} from '@pi-agent/infinichat/pi/model-catalog';
import { useMemo, useState } from 'react';

import { MacAgent } from '../../../contract';
import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { errorText } from '../../lib/error-text';
import { ChatAgentContext } from '../chat/agent';
import { ModelSection } from '../chat/model-section';
import { Notice } from '../chat/notices';
import { Placeholder } from '../chat/placeholder';
import { ThreadSourceContext } from '../chat/thread-source';
import { Transcript } from '../chat/transcript';
import { Button } from '../ui/button';
import { FormSheet, useSheet } from './form-sheet';

type AgentRef = Held<typeof MacAgent>;

const noChoice = () => {};
const sameSettings = (left: ChatModelSettings, right: ChatModelSettings) => left.model.provider === right.model.provider
  && left.model.modelId === right.model.modelId && left.thinkingLevel === right.thinkingLevel;

/**
 * One agent's chat in place of root's, as UniiChat's views show any unii's: held while it is shown, and the thread's
 * source meanwhile. The user reads it, stops its turn, continues a run that failed and picks its model, and talks
 * only to root, so there is no composer. The phone's `agent/[name].tsx` is its counterpart.
 */
export function AgentPane({ name, rootName, onAnswerQuestions }: {
  name: string; rootName: string; onAnswerQuestions: () => void;
}) {
  const ref = useHold(MacAgent, { name });
  if (ref === undefined) return <Placeholder>Opening {name}…</Placeholder>;
  return (
    <ThreadSourceContext value={ref}>
      <AgentChat name={name} rootName={rootName} agent={ref} onAnswerQuestions={onAnswerQuestions} />
    </ThreadSourceContext>
  );
}

function AgentChat({ name, rootName, agent, onAnswerQuestions }: {
  name: string; rootName: string; agent: AgentRef; onAnswerQuestions: () => void;
}) {
  const infinichat = useInfiniChatRef();
  const controls = useWatch(agent.controls);
  const catalog = useWatch(infinichat.catalog) ?? [];
  const pendingForAgent = (useWatch(infinichat.pendingQuestions) ?? []).filter((batch) => batch.agent === name);
  const modelSheet = useSheet();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const identity = useMemo(() => ({ name, avatar: undefined }), [name]);
  const busy = !!controls?.busy;
  const failure = busy ? undefined : controls?.runFailure;
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    setError(undefined);
    void agent.stop(BACKGROUND_CONTEXT).catch((cause: unknown) => {
      setError(errorText(cause, 'Something went wrong. Please try again.'));
    }).finally(() => setStopping(false));
  };
  const resume = () => {
    setError(undefined);
    void agent.continue(BACKGROUND_CONTEXT).catch((cause: unknown) => {
      setError(errorText(cause, 'The response could not continue. Try again.'));
    });
  };
  return (
    <ChatAgentContext value={identity}>
      <Transcript stopping={stopping} onChoose={noChoice} />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-6 pb-6">
        {failure && (
          <Notice tone={failure.reason === 'aborted' ? 'neutral' : 'error'} message={failure.message}
            action="Continue" onAction={resume} />
        )}
        {error !== undefined && <Notice message={error} action="Dismiss" onAction={() => setError(undefined)} />}
        {pendingForAgent.length > 0 && (
          <Notice tone="neutral" message={pendingQuestionsBanner(pendingForAgent, rootName)} action="Answer"
            onAction={onAnswerQuestions} />
        )}
        <div className="flex items-center gap-2 rounded-xl border px-4 py-2 text-sm text-muted-foreground">
          <span className="flex-1">Only {rootName} takes your messages. Ask it to tell {name}.</span>
          <Button type="button" variant="outline" size="sm" disabled={!controls} onClick={modelSheet.show}>
            Model…
          </Button>
          {busy && (
            <Button type="button" variant="outline" size="sm" disabled={stopping} onClick={stop}>Stop</Button>
          )}
        </div>
      </div>
      {controls && (
        <AgentModelSheet key={modelSheet.session} open={modelSheet.open} onClose={modelSheet.hide} name={name}
          agent={agent} opened={controls.settings} catalog={catalog} />
      )}
    </ChatAgentContext>
  );
}

/** The model and reasoning effort one agent runs on, as the settings sheet chooses root's. */
function AgentModelSheet({ open, onClose, name, agent, opened, catalog }: {
  open: boolean; onClose: () => void; name: string; agent: AgentRef; opened: ChatModelSettings;
  catalog: ModelCatalog;
}) {
  // The saved model the draft is compared with, as the sheet opened.
  const [initial] = useState(opened);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const changed = !sameSettings(draft, initial);
  const settingsError = getModelSettingsError(catalog, draft);
  const save = () => {
    setSaving(true);
    setError(undefined);
    void agent.setModel(draft, BACKGROUND_CONTEXT).then(onClose, (cause: unknown) => {
      setError(errorText(cause, 'Could not save this model. Try again.'));
    }).finally(() => setSaving(false));
  };
  return (
    <FormSheet open={open} onClose={onClose} dirty={changed} title={`${name}’s model`} className="sm:max-w-xl"
      save={{ label: 'Save', disabled: !changed || settingsError !== undefined, busy: saving, onSave: save }}>
      {error !== undefined && <Notice message={error} />}
      <ModelSection title="Model" catalog={catalog} settings={draft} disabled={saving} onChange={setDraft}
        caption={`${name} runs on this model from its next response. Changing it keeps its memory.`}
        error={!draft.model.provider ? undefined
          : draft.model.modelId ? settingsError : 'Choose a model to finish changing the provider.'} />
    </FormSheet>
  );
}
