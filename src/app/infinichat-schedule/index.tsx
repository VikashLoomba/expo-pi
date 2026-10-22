import {
  Button, ContentUnavailableView, Host, HStack, Image, List, ProgressView, Section, Spacer, Text, VStack,
} from '@expo/ui/swift-ui';
import { font, foregroundStyle, lineLimit, listStyle } from '@expo/ui/swift-ui/modifiers';
import { router, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { PlatformColor, StyleSheet } from 'react-native';

import { useChatApp, useScheduledTasks } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { ScheduledTask } from '@/pi/infinichat-scheduled';

// Inside a button, hierarchical styles derive from the tint, so its text takes the label colors explicitly.
const buttonLabel = foregroundStyle(PlatformColor('label'));
const buttonDetail = foregroundStyle(PlatformColor('secondaryLabel'));
const runTime = (until: number) =>
  new Date(until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** The tasks InfiniChat scheduled for later, soonest first: a swipe deletes one, a tap edits it. */
export default function ScheduledTasksScreen() {
  const colors = useChatColors();
  const { infiniChat } = useChatApp();
  const tasks = useScheduledTasks();
  // A deleted row leaves at once, as onDelete expects of its data; one whose delete failed comes back.
  const [deleted, setDeleted] = useState<readonly number[]>([]);
  const [error, setError] = useState<string>();
  const shown = tasks?.filter((task) => !deleted.includes(task.id));
  const remove = async (task: ScheduledTask) => {
    if (!infiniChat) return;
    setDeleted((current) => [...current, task.id]);
    setError(undefined);
    try {
      if (!(await infiniChat.cancelScheduled(task.id))) {
        setError('That task reached InfiniChat before it was deleted.');
      }
    } catch (cause) {
      setDeleted((current) => current.filter((id) => id !== task.id));
      setError(cause instanceof Error ? cause.message : 'Could not delete this task. Try again.');
    }
  };
  const renderTask = useCallback(({ item }: { item: ScheduledTask }) => <Button
    onPress={() => router.push({ pathname: '/infinichat-schedule/edit', params: { id: String(item.id) } })}>
    <HStack spacing={12}>
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[buttonLabel]}>{runTime(item.until)}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), buttonDetail, lineLimit(2)]}>{item.task}</Text>
      </VStack>
      <Spacer />
      <Image systemName="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />
    </HStack>
  </Button>, []);
  return <>
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close scheduled tasks" onPress={close} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="scheduled-tasks-screen">
      {!shown ? <ProgressView />
        : !shown.length && !error ? <ContentUnavailableView title="No scheduled tasks" systemImage="clock"
          description="Tasks InfiniChat schedules for later appear here." />
          : <List modifiers={[listStyle('insetGrouped')]}>
            {error && <SettingsNotice testID="scheduled-task-error" message={error} />}
            <Section footer={<Text>
              Each task reaches InfiniChat as a message at its time. If the app is closed then, you get a notification.
            </Text>}>
              <List.ForEach data={shown} keyExtractor={(task) => String(task.id)} estimatedItemSize={64}
                onDelete={(indices) => {
                  for (const task of shown.filter((_, index) => indices.includes(index))) void remove(task);
                }}>
                {renderTask}
              </List.ForEach>
            </Section>
          </List>}
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
