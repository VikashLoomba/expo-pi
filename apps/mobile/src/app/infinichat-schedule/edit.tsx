import {
  Button, DatePicker, Form, Host, Picker, Section, Text, TextField, useNativeState,
} from '@expo/ui/swift-ui';
import { disabled as disable, lineLimit, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import type { ScheduledTask } from '@pi-agent/infinichat/pi/infinichat-scheduled';
import {
  ONCE, REPEAT_CHOICES, repeatKey, repeatLabel, type ScheduledInput,
} from '@pi-agent/infinichat/pi/infinichat/schedule';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { useChatApp, useScheduledTasks } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

/** Edits the scheduled task `id` names, as the list showed it; saving or deleting returns to the list. */
export default function EditScheduledTaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useChatColors();
  const tasks = useScheduledTasks();
  // The task as the screen opened: saving replaces it with a task of another ID.
  const [task] = useState(() => tasks?.find((each) => String(each.id) === id));
  if (!task) {
    return <Host style={styles.fill} seedColor={colors.accent}>
      <Form>
        <SettingsNotice message="This task already reached InfiniChat or was deleted." />
      </Form>
    </Host>;
  }
  return <TaskForm task={task} />;
}

function TaskForm({ task }: { task: ScheduledTask }) {
  const colors = useChatColors();
  const { infiniChat } = useChatApp();
  const text = useNativeState(task.task);
  const [draft, setDraft] = useState<ScheduledInput>({ task: task.task, until: task.until,
    ...(task.repeat === undefined ? {} : { repeat: task.repeat }) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The repeats offered, and the task's own when InfiniChat set another.
  const repeats = task.repeat === undefined || REPEAT_CHOICES.some((each) => repeatKey(each) === repeatKey(task.repeat))
    ? REPEAT_CHOICES : [...REPEAT_CHOICES, task.repeat];
  const changed = draft.task.trim() !== task.task || draft.until !== task.until
    || repeatKey(draft.repeat) !== repeatKey(task.repeat);
  const canSave = !busy && changed && !!draft.task.trim();
  /** Deletes the task, or replaces it with `replacement`; either fails once the task has reached InfiniChat. */
  const finish = async (replacement?: ScheduledInput) => {
    if (busy) return;
    if (replacement && replacement.until <= Date.now()) {
      setError('Choose a time in the future.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (await infiniChat.cancelScheduled(task.id, replacement)) router.back();
      else setError('This task already reached InfiniChat.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change this task. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return <>
    <Stack.Toolbar placement="right">
      {busy ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel="Save task" disabled={!canSave}
          onPress={() => { void finish({ ...draft, task: draft.task.trim() }); }} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="scheduled-task-form">
      <Form>
        {error && <SettingsNotice testID="scheduled-task-save-error" message={error} />}
        <Section title="Task" footer={<Text>InfiniChat receives this as a message at the time below.</Text>}>
          <TextField text={text} placeholder="What InfiniChat should do" axis="vertical"
            onTextChange={(value) => setDraft((current) => ({ ...current, task: value }))}
            modifiers={[lineLimit({ min: 3, max: 10 }), disable(busy)]} />
        </Section>
        <Section>
          <DatePicker title="Runs at" selection={new Date(draft.until)} range={{ start: new Date() }}
            displayedComponents={['date', 'hourAndMinute']} modifiers={[disable(busy)]}
            onDateChange={(date) => setDraft((current) => ({ ...current, until: date.getTime() }))} />
          <Picker<string> label="Repeat" selection={repeatKey(draft.repeat)}
            modifiers={[pickerStyle('menu'), disable(busy)]}
            onSelectionChange={(chosen) => setDraft(({ repeat: _before, ...current }) => {
              const repeat = repeats.find((each) => repeatKey(each) === chosen);
              return repeat === undefined ? current : { ...current, repeat };
            })}>
            <Text modifiers={[tag(ONCE)]}>Never</Text>
            {repeats.map((each) =>
              <Text key={repeatKey(each)} modifiers={[tag(repeatKey(each))]}>{repeatLabel(each)}</Text>)}
          </Picker>
        </Section>
        <Section>
          <Button label="Delete task" systemImage="trash" role="destructive" modifiers={[disable(busy)]}
            onPress={() => { void finish(); }} />
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
