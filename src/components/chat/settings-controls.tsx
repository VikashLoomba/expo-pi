import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import {
  findCatalogModel, type ChatModelSettings, type ModelCatalog, type ModelThinkingLevel,
} from '@/pi/model-catalog';
import { ChatIcon } from './icon';

const thinkingLabels: Record<ModelThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};

export function thinkingLevelLabel(level: ModelThinkingLevel) {
  return thinkingLabels[level] ?? level;
}

export function SettingRow({ label, value, detail, onPress, disabled, testID }: {
  label: string; value: string; detail?: string; onPress: () => void; disabled?: boolean; testID: string;
}) {
  const colors = useChatColors();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label}, ${value}${detail ? `. ${detail}` : ''}`}
    accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.setting, { borderColor: colors.border, opacity: pressed || disabled ? 0.55 : 1 }]}>
    <View style={styles.copy}>
      <Text style={[styles.label, { color: colors.secondary }]}>{label}</Text>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      {detail && <Text style={[styles.detail, { color: colors.muted }]}>{detail}</Text>}
    </View>
    <ChatIcon name="chevron" color={colors.muted} size={14} />
  </Pressable>;
}

/** The pickers of one model choice. */
export type ModelPicker = 'provider' | 'model' | 'effort';

/** The provider, model and reasoning effort rows of one model choice; `testID` prefixes each row's. */
export function ModelSettingRows({ catalog, settings, disabled, onOpen, testID }: {
  catalog: ModelCatalog; settings: ChatModelSettings; disabled: boolean; onOpen: (picker: ModelPicker) => void;
  testID: string;
}) {
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const model = findCatalogModel(catalog, settings.model);
  const canChooseEffort = !!model?.thinkingLevels.length
    && (model.thinkingLevels.length > 1 || !model.thinkingLevels.includes(settings.thinkingLevel));
  return <>
    <SettingRow testID={`${testID}-provider`} label="Provider"
      value={provider?.name || settings.model.provider || 'Choose a provider'} disabled={disabled}
      onPress={() => onOpen('provider')} />
    <SettingRow testID={`${testID}-model`} label="Model"
      value={model?.name || settings.model.modelId || 'Choose a model'}
      detail={model && model.id !== model.name ? model.id : undefined} disabled={disabled || !provider?.models.length}
      onPress={() => onOpen('model')} />
    <SettingRow testID={`${testID}-effort`} label="Reasoning effort" value={thinkingLevelLabel(settings.thinkingLevel)}
      detail={!model ? 'Choose an available model first.' : !model.reasoning ? 'This model does not support reasoning.'
        : model.thinkingLevels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined}
      disabled={disabled || !canChooseEffort} onPress={() => onOpen('effort')} />
  </>;
}

/** A model picker's choices: the catalog's providers, the chosen provider's models, or the model's efforts. */
export function modelChoices(
  catalog: ModelCatalog, settings: ChatModelSettings, picker: ModelPicker,
): SettingsChoice[] {
  if (picker === 'provider') {
    return catalog.map((entry) => ({ id: entry.id, title: entry.name,
      description: entry.models.length ? `${entry.models.length} ${entry.models.length === 1 ? 'model' : 'models'}`
        : 'No models available',
      disabled: entry.models.length === 0 }));
  }
  if (picker === 'model') {
    const provider = catalog.find((entry) => entry.id === settings.model.provider);
    return (provider?.models ?? []).map((entry) => ({ id: entry.id, title: entry.name,
      description: `${entry.id} · ${entry.reasoning ? 'Reasoning available' : 'No reasoning control'}` }));
  }
  return (findCatalogModel(catalog, settings.model)?.thinkingLevels ?? [])
    .map((level) => ({ id: level, title: thinkingLevelLabel(level) }));
}

export function HeaderAction({ title, onPress, disabled, loading, testID }: {
  title: string; onPress: () => void; disabled?: boolean; loading?: boolean; testID?: string;
}) {
  const colors = useChatColors();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title}
    accessibilityState={{ disabled: !!disabled, busy: !!loading }} disabled={disabled || loading} onPress={onPress}
    style={({ pressed }) => [styles.headerAction, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    {loading ? <ActivityIndicator size="small" color={colors.accent} />
      : <Text style={[styles.headerLabel, { color: colors.accent }]}>{title}</Text>}
  </Pressable>;
}

export interface SettingsChoice {
  id: string;
  title: string;
  description?: string;
  disabled?: boolean;
}

export function SettingsChoices({ choices, selectedId, onSelect, disabled, search, onSearch, searchPlaceholder, description, bottomInset = 0 }: {
  choices: readonly SettingsChoice[]; selectedId: string; onSelect: (id: string) => void; disabled?: boolean;
  search?: string; onSearch?: (value: string) => void; searchPlaceholder?: string; description: string; bottomInset?: number;
}) {
  const colors = useChatColors();
  return <View style={styles.choices}>
    <View style={styles.choiceIntro}>
      <Text style={[styles.description, { color: colors.secondary }]}>{description}</Text>
      {onSearch && <View style={[styles.search, { backgroundColor: colors.subtle }]}>
        <ChatIcon name="search" color={colors.muted} size={18} />
        <TextInput testID="settings-search" accessibilityRole="search" accessibilityLabel={searchPlaceholder}
          value={search} onChangeText={onSearch} placeholder={searchPlaceholder} placeholderTextColor={colors.muted}
          editable={!disabled} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search"
          style={[styles.searchInput, { color: colors.text }]} />
      </View>}
    </View>
    <FlatList testID="settings-choices" data={choices} keyExtractor={(item) => item.id} extraData={`${selectedId}:${disabled}`}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: bottomInset + 24 }}
      ListEmptyComponent={<Text style={[styles.empty, { color: colors.secondary }]}>No matches. Try another search.</Text>}
      renderItem={({ item }) => {
        const selected = item.id === selectedId;
        const unavailable = !!disabled || !!item.disabled;
        return <Pressable testID={`settings-choice-${item.id}`} accessibilityRole="radio"
          accessibilityLabel={`${item.title}${item.description ? `. ${item.description}` : ''}`}
          accessibilityState={{ checked: selected, disabled: unavailable }} disabled={unavailable} onPress={() => onSelect(item.id)}
          style={({ pressed }) => [styles.choice, { borderColor: colors.border, backgroundColor: selected ? colors.accentSoft : colors.surface, opacity: unavailable ? 0.5 : pressed ? 0.7 : 1 }]}>
          <View style={styles.copy}>
            <Text style={[styles.choiceTitle, { color: colors.text }]}>{item.title}</Text>
            {item.description && <Text style={[styles.detail, { color: colors.secondary }]}>{item.description}</Text>}
          </View>
          <View style={[styles.radio, { borderColor: selected ? colors.accent : colors.muted, backgroundColor: selected ? colors.accent : 'transparent' }]}>
            {selected && <ChatIcon name="check" color={colors.onAccent} size={12} />}
          </View>
        </Pressable>;
      }} />
  </View>;
}

const styles = StyleSheet.create({
  setting: { flexDirection: 'row', alignItems: 'center', padding: 18, gap: 16, minHeight: 88, borderBottomWidth: StyleSheet.hairlineWidth },
  copy: { flex: 1, gap: 5 },
  label: { fontSize: 13, fontWeight: '500' },
  value: { fontSize: 17, fontWeight: '500' },
  detail: { fontSize: 12, lineHeight: 18 },
  choices: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center' },
  choiceIntro: { padding: 20, gap: 16 },
  description: { fontSize: 14, lineHeight: 21 },
  search: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, borderRadius: 13, gap: 9 },
  searchInput: { flex: 1, fontSize: 16, minHeight: 48, paddingVertical: 12 },
  choice: { flexDirection: 'row', alignItems: 'center', padding: 17, gap: 16, minHeight: 70, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, marginBottom: 8 },
  choiceTitle: { fontSize: 16, fontWeight: '500' },
  radio: { width: 23, height: 23, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: 30 },
  headerAction: { minHeight: 44, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  headerLabel: { fontSize: 16, fontWeight: '500' },
});
