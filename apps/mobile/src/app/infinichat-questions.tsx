import {
  Button, ContentUnavailableView, Form, Host, Label, Picker, ProgressView, Section, SecureField, Text, TextField,
  Toggle, useNativeState,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, disabled as disable, font, foregroundStyle, lineLimit, pickerStyle, tag,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { ROOT } from '@pi-agent/infinichat/pi/infinichat/agents';
import type {
  PendingQuestionBatch, QuestionItem, UserQuestionAnswer,
} from '@pi-agent/infinichat/pi/infinichat/ask';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { useChatApp, useInfiniChatQuestions } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const secretModifiers = [autocorrectionDisabled(), textInputAutocapitalization('never')];

interface DraftAnswer {
  value: string;
  note: string;
  skipped: boolean;
}

function dismiss() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function batchSummary(batch: PendingQuestionBatch): string {
  const count = batch.questions.length;
  const label = batch.title || `${count} question${count === 1 ? '' : 's'}`;
  return batch.agent === ROOT ? label : `${batch.agent} · ${label}`;
}

function QuestionSection({ question, draft, submitting, onChange }: {
  question: QuestionItem;
  draft: DraftAnswer;
  submitting: boolean;
  onChange: (next: DraftAnswer) => void;
}) {
  const colors = useChatColors();
  const valueText = useNativeState(draft.value);
  const noteText = useNativeState(draft.note);
  const [reveal, setReveal] = useState(false);
  const isSecret = question.kind === 'secret';
  const heading = question.label || (isSecret ? 'Credential' : 'Question');
  const footer = isSecret
    ? 'Held in memory only (never saved to disk or sent to the model).'
    : undefined;
  return (
    <Section title={heading} footer={footer === undefined ? undefined : <Text>{footer}</Text>}>
      <Text>{question.prompt}</Text>
      {isSecret && question.purpose !== undefined && (
        <Label title={`How it will be used: ${question.purpose}`} systemImage="lock.shield"
          modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.accent)]} />
      )}
      {!draft.skipped && (isSecret && !reveal ? (
        <SecureField text={valueText} placeholder={question.placeholder || 'Enter secret value'}
          modifiers={[...secretModifiers, disable(submitting)]}
          onTextChange={(value) => onChange({ ...draft, value })} />
      ) : (
        <TextField text={valueText}
          placeholder={question.placeholder || (isSecret ? 'Enter secret value' : 'Your answer')}
          axis={isSecret ? undefined : 'vertical'}
          modifiers={isSecret
            ? [...secretModifiers, disable(submitting)]
            : [lineLimit({ min: 1, max: 6 }), disable(submitting)]}
          onTextChange={(value) => onChange({ ...draft, value })} />
      ))}
      {!draft.skipped && isSecret && (
        <Button label={reveal ? 'Hide value' : 'Show value'} systemImage={reveal ? 'eye.slash' : 'eye'}
          modifiers={[disable(submitting)]} onPress={() => setReveal((current) => !current)} />
      )}
      <Toggle label="Skip this question" isOn={draft.skipped} modifiers={[disable(submitting)]}
        onIsOnChange={(skipped) => {
          if (skipped) valueText.set('');
          onChange({ ...draft, skipped, value: skipped ? '' : draft.value });
        }} />
      <TextField text={noteText} placeholder="Additional note (optional)" axis="vertical"
        modifiers={[lineLimit({ min: 1, max: 4 }), disable(submitting)]}
        onTextChange={(note) => onChange({ ...draft, note })} />
    </Section>
  );
}

function QuestionBatchScreen({ batch, batches, onSelectBatch, onSubmitted }: {
  batch: PendingQuestionBatch;
  batches: readonly PendingQuestionBatch[];
  onSelectBatch: (taskId: number) => void;
  onSubmitted: () => void;
}) {
  const colors = useChatColors();
  const { infiniChat } = useChatApp();
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(batch.questions.map((question) => [question.id, { value: '', note: '', skipped: false }])));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const updateDraft = (id: string, next: DraftAnswer) => {
    setDrafts((current) => ({ ...current, [id]: next }));
  };
  const ready = batch.questions.every((question) => {
    const entry = drafts[question.id];
    if (!entry) return false;
    if (entry.skipped) return true;
    return question.kind === 'secret' ? entry.value.length > 0 : entry.value.trim().length > 0;
  });
  const submitAnswers = async (answers: UserQuestionAnswer[]) => {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await infiniChat.answerQuestions(batch.taskId, answers);
      if (mounted.current) onSubmitted();
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Could not send your answers. Try again.');
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };
  const submit = () => {
    const answers: UserQuestionAnswer[] = batch.questions.map((question) => {
      const entry = drafts[question.id] ?? { value: '', note: '', skipped: true };
      const note = entry.note.trim();
      return {
        id: question.id,
        skipped: entry.skipped,
        ...(entry.skipped ? {} : { value: entry.value }),
        ...(note ? { note } : {}),
      };
    });
    void submitAnswers(answers);
  };
  const skipAll = () => {
    const answers: UserQuestionAnswer[] = batch.questions.map((question) => {
      const note = drafts[question.id]?.note.trim();
      return { id: question.id, skipped: true, ...(note ? { note } : {}) };
    });
    void submitAnswers(answers);
  };
  const agentBadge = batch.agent === ROOT ? undefined : `Asked by ${batch.agent}`;
  return <>
    <Stack.Screen options={{ title: batch.title || 'Questions' }} />
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close" onPress={dismiss} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      {submitting ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel="Submit answers" disabled={!ready} onPress={submit} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-questions-screen">
      <Form>
        {error && <SettingsNotice testID="questions-submit-error" message={error} />}
        {batches.length > 1 && (
          <Section title="Waiting requests">
            <Picker label="Request" selection={String(batch.taskId)} modifiers={[pickerStyle('menu')]}
              onSelectionChange={(value) => onSelectBatch(Number(value))}>
              {batches.map((item) => (
                <Text key={item.taskId} modifiers={[tag(String(item.taskId))]}>{batchSummary(item)}</Text>
              ))}
            </Picker>
          </Section>
        )}
        {agentBadge !== undefined && (
          <Section>
            <Label title={agentBadge} systemImage="person.circle" modifiers={[secondary]} />
          </Section>
        )}
        {batch.questions.map((question) => (
          <QuestionSection key={question.id} question={question}
            draft={drafts[question.id] ?? { value: '', note: '', skipped: false }}
            submitting={submitting} onChange={(next) => updateDraft(question.id, next)} />
        ))}
        <Section footer={batches.length > 1 ? <Text>Another agent is also waiting for your input.</Text> : undefined}>
          <Button label={submitting ? 'Submitting…' : 'Submit Answers'}
            modifiers={[disable(!ready || submitting)]} onPress={submit} />
          <Button label="Skip All" role="destructive" modifiers={[disable(submitting)]} onPress={skipAll} />
        </Section>
      </Form>
    </Host>
  </>;
}

/** Modal for answering one or more parked `ask_user` batches from root or any child agent. */
export default function InfiniChatQuestionsScreen() {
  const colors = useChatColors();
  const { agent: requestedAgent } = useLocalSearchParams<{ agent?: string }>();
  const batches = useInfiniChatQuestions();
  const [selectedTaskId, setSelectedTaskId] = useState<number>();
  const active = batches === undefined ? undefined
    : (selectedTaskId !== undefined ? batches.find((batch) => batch.taskId === selectedTaskId) : undefined)
      ?? (requestedAgent !== undefined ? batches.find((batch) => batch.agent === requestedAgent) : undefined)
      ?? batches[0];
  if (batches === undefined) {
    return <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close" onPress={dismiss} />
      </Stack.Toolbar>
      <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-questions-screen">
        <ProgressView />
      </Host>
    </>;
  }
  if (active === undefined) {
    return <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close" onPress={dismiss} />
      </Stack.Toolbar>
      <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-questions-screen">
        <ContentUnavailableView title="No pending questions" systemImage="checkmark.circle"
          description="When an agent needs input or a credential, its questions appear here." />
      </Host>
    </>;
  }
  return (
    <QuestionBatchScreen key={active.taskId} batch={active} batches={batches}
      onSelectBatch={setSelectedTaskId}
      onSubmitted={() => {
        if (batches.length <= 1) dismiss();
        else setSelectedTaskId(undefined);
      }} />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
