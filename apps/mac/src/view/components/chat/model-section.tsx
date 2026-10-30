import {
  createModelSettings, findCatalogModel, type ChatModelSettings, type ModelCatalog, type ModelOption,
  type ModelThinkingLevel,
} from '@pi-agent/infinichat/pi/model-catalog';
import type { ReactNode } from 'react';

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '../ui/combobox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

const thinkingLabels: Record<ModelThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};

export function thinkingLevelLabel(level: ModelThinkingLevel) {
  return thinkingLabels[level] ?? level;
}

/** A model's name and ID, searched as one, as the phone's model list filters them. */
const modelText = (model: ModelOption) => `${model.name} ${model.id}`.toLocaleLowerCase();

/**
 * One model choice as a form section, the phone's `ModelSection`: the provider and reasoning effort are menus, and
 * the model, which can be one of hundreds, a searchable combobox. Choosing another provider clears the model.
 * `children` lead the rows, such as the switch that makes the choice the section's own.
 */
export function ModelSection({ title, caption, error, catalog, settings, disabled, onChange, children }: {
  title: string; caption?: string; error?: string; catalog: ModelCatalog; settings: ChatModelSettings;
  disabled: boolean; onChange: (settings: ChatModelSettings) => void; children?: ReactNode;
}) {
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const model = findCatalogModel(catalog, settings.model);
  const levels = model?.thinkingLevels ?? [];
  const canChooseEffort = levels.length > 1 || (levels.length === 1 && !levels.includes(settings.thinkingLevel));
  const effortNote = !model ? undefined : !model.reasoning ? 'This model does not support reasoning.'
    : levels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined;
  const efforts = levels.includes(settings.thinkingLevel) ? levels : [settings.thinkingLevel, ...levels];
  const note = [effortNote, caption].filter(Boolean).join(' ');
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <FieldGroup>
        {children}
        <Field orientation="horizontal">
          <FieldLabel>Provider</FieldLabel>
          <Select items={catalog.map((entry) => ({ value: entry.id, label: entry.name }))}
            value={settings.model.provider || null} disabled={disabled}
            onValueChange={(providerId) => {
              if (providerId === null || providerId === settings.model.provider) return;
              onChange({ model: { provider: providerId, modelId: '' }, thinkingLevel: settings.thinkingLevel });
            }}>
            <SelectTrigger className="w-60"><SelectValue placeholder="Choose a provider" /></SelectTrigger>
            <SelectContent>
              {catalog.map((entry) => (
                <SelectItem key={entry.id} value={entry.id} disabled={!entry.models.length}>{entry.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Model</FieldLabel>
          <Combobox items={provider?.models ?? []} value={model ?? null} disabled={disabled || !provider?.models.length}
            itemToStringLabel={(item) => item.name} isItemEqualToValue={(a, b) => a.id === b.id}
            filter={(item, query) => modelText(item).includes(query.trim().toLocaleLowerCase())}
            onValueChange={(chosen) => {
              if (chosen !== null) onChange(createModelSettings(chosen, settings.thinkingLevel));
            }}>
            <ComboboxInput className="w-60" placeholder={provider ? 'Search models' : 'Choose a provider first'} />
            <ComboboxContent>
              <ComboboxEmpty>No matches. Try another search.</ComboboxEmpty>
              <ComboboxList>
                {(item: ModelOption) => (
                  <ComboboxItem key={item.id} value={item}>
                    <span className="flex flex-col">
                      <span>{item.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {`${item.id} · ${item.reasoning ? 'Reasoning available' : 'No reasoning control'}`}
                      </span>
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Reasoning effort</FieldLabel>
          <Select items={efforts.map((level) => ({ value: level, label: thinkingLevelLabel(level) }))}
            value={settings.thinkingLevel} disabled={disabled || !canChooseEffort}
            onValueChange={(level) => {
              const thinkingLevel = levels.find((each) => each === level);
              if (thinkingLevel) onChange({ ...settings, thinkingLevel });
            }}>
            <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              {efforts.map((level) => (
                <SelectItem key={level} value={level}>{thinkingLevelLabel(level)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {error ? <FieldDescription className="text-destructive">{error}</FieldDescription>
          : note ? <FieldDescription>{note}</FieldDescription> : null}
      </FieldGroup>
    </FieldSet>
  );
}
