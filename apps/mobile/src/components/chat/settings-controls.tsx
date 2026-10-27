import { Button, Host, HStack, Image, Label, List, Picker, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  disabled as disable, font, foregroundStyle, listStyle, pickerStyle, tag,
} from '@expo/ui/swift-ui/modifiers';
import {
  findCatalogModel, type ChatModelSettings, type ModelCatalog, type ModelOption, type ModelThinkingLevel,
  type ProviderOption,
} from '@pi-agent/infinichat/pi/model-catalog';
import { useCallback } from 'react';
import { ActivityIndicator, PlatformColor, StyleSheet, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ActionButton, InlineNotice } from './primitives';

const thinkingLabels: Record<ModelThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};

export function thinkingLevelLabel(level: ModelThinkingLevel) {
  return thinkingLabels[level] ?? level;
}

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
// Inside a button, hierarchical styles derive from the tint, so its text takes the label colors explicitly.
const buttonLabel = foregroundStyle(PlatformColor('label'));
const buttonDetail = foregroundStyle(PlatformColor('secondaryLabel'));

/** A form section's footer: an error in the danger color, otherwise the caption. */
export function SectionFooter({ error, caption }: { error?: string; caption?: string }) {
  const colors = useChatColors();
  if (error) return <Text modifiers={[foregroundStyle(colors.danger)]}>{error}</Text>;
  return caption ? <Text>{caption}</Text> : null;
}

/** A form row that pushes another screen, labelled with its current value. */
export function PushRow({ label, value, disabled, onPress }: {
  label: string; value?: string; disabled?: boolean; onPress: () => void;
}) {
  return <Button onPress={onPress} modifiers={[disable(disabled)]}>
    <HStack spacing={8}>
      <Text modifiers={[buttonLabel]}>{label}</Text>
      <Spacer />
      {value ? <Text modifiers={[buttonDetail]}>{value}</Text> : null}
      <Image systemName="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />
    </HStack>
  </Button>;
}

/**
 * One model choice as a form section: the provider and reasoning effort are menus, and the model, which can be one
 * of hundreds, opens a searchable list. Choosing another provider opens that list at once.
 */
export function ModelSection({ title, error, caption, catalog, settings, disabled, onChange, onChooseModel }: {
  title: string; error?: string; caption?: string; catalog: ModelCatalog; settings: ChatModelSettings;
  disabled: boolean; onChange: (settings: ChatModelSettings) => void; onChooseModel: () => void;
}) {
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const model = findCatalogModel(catalog, settings.model);
  const levels = model?.thinkingLevels ?? [];
  const canChooseEffort = levels.length > 1 || (levels.length === 1 && !levels.includes(settings.thinkingLevel));
  const effortNote = !model ? undefined : !model.reasoning ? 'This model does not support reasoning.'
    : levels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined;
  const chooseProvider = (providerId: string) => {
    if (providerId === settings.model.provider) return;
    onChange({ model: { provider: providerId, modelId: '' }, thinkingLevel: settings.thinkingLevel });
    onChooseModel();
  };
  const chooseEffort = (value: string) => {
    const thinkingLevel = levels.find((level) => level === value);
    if (thinkingLevel) onChange({ ...settings, thinkingLevel });
  };
  return <Section title={title} footer={<SectionFooter error={error}
    caption={[effortNote, caption].filter(Boolean).join(' ') || undefined} />}>
    <Picker<string> label="Provider" selection={settings.model.provider} onSelectionChange={chooseProvider}
      modifiers={[pickerStyle('menu'), disable(disabled)]}>
      {!provider && <Text modifiers={[tag(settings.model.provider)]}>
        {settings.model.provider || 'Choose a provider'}
      </Text>}
      {catalog.map((entry) => <Text key={entry.id} modifiers={[tag(entry.id), disable(!entry.models.length)]}>
        {entry.name}
      </Text>)}
    </Picker>
    <PushRow label="Model" value={model?.name || settings.model.modelId || 'Choose a model'}
      disabled={disabled || !provider?.models.length} onPress={onChooseModel} />
    <Picker<string> label="Reasoning effort" selection={settings.thinkingLevel} onSelectionChange={chooseEffort}
      modifiers={[pickerStyle('menu'), disable(disabled || !canChooseEffort)]}>
      {!levels.includes(settings.thinkingLevel) && <Text modifiers={[tag(settings.thinkingLevel)]}>
        {thinkingLevelLabel(settings.thinkingLevel)}
      </Text>}
      {levels.map((level) => <Text key={level} modifiers={[tag(level)]}>{thinkingLevelLabel(level)}</Text>)}
    </Picker>
  </Section>;
}

/** A provider's models as a checkmark list, filtered by the screen's search field. */
export function ModelChoices({ provider, selectedId, query, onSelect }: {
  provider: ProviderOption | undefined; selectedId: string; query: string; onSelect: (model: ModelOption) => void;
}) {
  const colors = useChatColors();
  const needle = query.trim().toLocaleLowerCase();
  const models = (provider?.models ?? [])
    .filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(needle));
  const renderModel = useCallback(({ item }: { item: ModelOption }) => <Button onPress={() => onSelect(item)}>
    <HStack spacing={12}>
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[buttonLabel]}>{item.name}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), buttonDetail]}>
          {`${item.id} · ${item.reasoning ? 'Reasoning available' : 'No reasoning control'}`}
        </Text>
      </VStack>
      <Spacer />
      {item.id === selectedId && <Image systemName="checkmark" size={15} color={colors.accent} />}
    </HStack>
  </Button>, [colors.accent, onSelect, selectedId]);
  return <Host style={styles.fill} seedColor={colors.accent} testID="model-choices">
    <List modifiers={[listStyle('insetGrouped')]}>
      <Section footer={provider ? <Text>{`Models from ${provider.name}.`}</Text> : undefined}>
        {models.length
          ? <List.ForEach data={models} keyExtractor={(model) => model.id} estimatedItemSize={56}>
            {renderModel}
          </List.ForEach>
          : <Text modifiers={[secondary]}>{needle ? 'No matches. Try another search.' : 'No models available.'}</Text>}
      </Section>
    </List>
  </Host>;
}

/** A notice as its own form section, with an optional action below it. */
export function SettingsNotice({ message, tone = 'error', action, onAction, testID }: {
  message: string; tone?: 'error' | 'neutral'; action?: string; onAction?: () => void; testID?: string;
}) {
  const colors = useChatColors();
  return <Section>
    <Label title={message} systemImage={tone === 'error' ? 'exclamationmark.circle' : 'info.circle'}
      modifiers={tone === 'error' ? [foregroundStyle(colors.danger)] : [secondary]} testID={testID} />
    {action && onAction ? <Button label={action} onPress={onAction} /> : null}
  </Section>;
}

/** A settings sheet that cannot open its form yet: still loading, or its conversation is gone. */
export function SettingsUnavailable({ loading, message, onClose }: {
  loading: boolean; message: string; onClose: () => void;
}) {
  const colors = useChatColors();
  return <View style={[styles.unavailable, { backgroundColor: colors.background }]}>
    {loading ? <ActivityIndicator color={colors.accent} /> : <>
      <InlineNotice message={message} />
      <ActionButton title="Close" secondary onPress={onClose} />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  unavailable: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
});
