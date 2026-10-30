import type { Host } from '@earendil-works/chord';
import type { ChatControls } from '@pi-agent/infinichat/chat/types';
import {
  sameExecution, validateExecution, type ChatExecutionSettings,
} from '@pi-agent/infinichat/pi/execution/document';
import {
  createModelSettings, findCatalogModel, getModelSettingsError, type ChatModelSettings, type ModelThinkingLevel,
} from '@pi-agent/infinichat/pi/model-catalog';
import { useRef, useState, type ReactNode } from 'react';

import type { MacPrincipal } from '../../../contract';
import { useAccountRef, type ChatRef } from '../../hooks/use-chats';
import { useHeldMachines } from '../../hooks/use-machines';
import { errorText, useMember } from '../../hooks/use-ref';
import { providersPane, useOpenSettings } from '../../lib/app-context';
import { Alert, AlertAction, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { DirectoryBrowser } from './directory-browser';

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum',
};
export const thinkingLevelLabel = (level: ModelThinkingLevel) => THINKING_LABELS[level] ?? level;

const LOCAL = 'local';
const targetId = (execution: ChatExecutionSettings) =>
  execution.target.kind === 'local' ? LOCAL : execution.target.machineId;
const sameSettings = (left: ChatModelSettings, right: ChatModelSettings) =>
  left.model.provider === right.model.provider && left.model.modelId === right.model.modelId
  && left.thinkingLevel === right.thinkingLevel;

type Choice = { value: string; label: string; disabled?: boolean };

/** A labelled menu of choices, as the phone's form pickers; `extra` keeps a saved value the list no longer has. */
function ChoiceField({ id, label, value, choices, disabled, onChange }: {
  id: string; label: string; value: string; choices: Choice[]; disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const items = Object.fromEntries(choices.map((choice) => [choice.value, choice.label]));
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} items={items} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * The phone's chat settings sheet (`chat-settings/[id]/index.tsx`): the model section, the execution environment
 * (this Mac or a machine) with its working directory and folder browser, Refresh Models, and Cancel and Save, which
 * commits the execution and the model together or the model alone. The draft is the sheet's until saved.
 */
function ChatSettingsForm({ host, chat, initial, onDone }: {
  host: Host<MacPrincipal>; chat: ChatRef; initial: Pick<ChatControls, 'settings' | 'execution'>; onDone: () => void;
}) {
  const account = useAccountRef();
  const catalog = useMember(account.catalog) ?? [];
  const accesses = useMember(account.access);
  const machinesRef = useHeldMachines(host);
  const listed = useMember(machinesRef.machines);
  const self = useMember(machinesRef.self);
  const openSettings = useOpenSettings();
  const [settings, setSettings] = useState(initial.settings);
  const [execution, setExecution] = useState(initial.execution);
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  // Each environment keeps the directory typed for it, so switching back restores it.
  const directories = useRef(new Map([[targetId(initial.execution), initial.execution.cwd]]));

  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const model = findCatalogModel(catalog, settings.model);
  const levels = model?.thinkingLevels ?? [];
  const canChooseEffort = levels.length > 1 || (levels.length === 1 && !levels.includes(settings.thinkingLevel));
  const effortNote = !model ? undefined : !model.reasoning ? 'This model does not support reasoning.'
    : levels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined;
  const access = accesses?.[settings.model.provider];
  const settingsError = getModelSettingsError(catalog, settings);
  const machines = Object.entries(listed?.machines ?? {}).filter(([endpoint]) => endpoint !== self)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const target = execution.target;
  const machine = target.kind === 'ssh' ? listed?.machines[target.machineId] : undefined;
  const machineName = target.kind === 'ssh' ? machine?.name ?? target.machineId : undefined;
  const changed = !sameSettings(settings, initial.settings);
  const executionChanged = !sameExecution(execution, initial.execution);
  let executionError: string | undefined;
  // Any folder may be chosen for a chat on this Mac (`MacChats`); an unset one is the chat's own folder.
  try { validateExecution(execution, null); } catch (cause) { executionError = errorText(cause, 'Check the folder.'); }
  if (executionChanged && target.kind === 'ssh' && machine === undefined) executionError = 'Choose an available machine.';
  const disabled = saving || refreshing;
  const canSave = !disabled && (changed || executionChanged) && (!changed || !settingsError) && !executionError;

  const chooseProvider = (value: string | null) => {
    if (value === null || value === settings.model.provider) return;
    setSettings({ model: { provider: value, modelId: '' }, thinkingLevel: settings.thinkingLevel });
  };
  const chooseModel = (value: string | null) => {
    const option = provider?.models.find((entry) => entry.id === value);
    if (option) setSettings(createModelSettings(option, settings.thinkingLevel));
  };
  const chooseEffort = (value: string | null) => {
    const level = levels.find((entry) => entry === value);
    if (level) setSettings({ ...settings, thinkingLevel: level });
  };
  const chooseEnvironment = (value: string | null) => {
    if (value === null || value === targetId(execution)) return;
    directories.current.set(targetId(execution), execution.cwd);
    const cwd = directories.current.get(value) ?? null;
    setExecution(value === LOCAL ? { target: { kind: 'local' }, cwd } : { target: { kind: 'ssh', machineId: value }, cwd });
    setBrowsing(false);
  };
  const chooseFolder = () => {
    if (target.kind === 'ssh') {
      setBrowsing(true);
      return;
    }
    void chat.chooseLocalFolder().then((path) => {
      if (path !== null) setExecution({ ...execution, cwd: path });
    }, (cause: unknown) => setError(errorText(cause, 'The folder could not be chosen.')));
  };
  const refresh = () => {
    setRefreshing(true);
    setError(undefined);
    void account.refreshCatalog().catch((cause: unknown) => {
      setError(errorText(cause, 'Could not refresh models. Try again.'));
    }).finally(() => setRefreshing(false));
  };
  const save = () => {
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    const work = executionChanged
      ? chat.updateExecution({ execution, ...(changed ? { settings } : {}) })
      : chat.updateSettings({ settings });
    void work.then(onDone, (cause: unknown) => {
      setError(errorText(cause, 'Could not save these settings. Try again.'));
      setSaving(false);
    });
  };

  const providerChoices: Choice[] = [
    ...(provider ? [] : [{ value: settings.model.provider, label: settings.model.provider || 'Choose a provider' }]),
    ...catalog.map((entry) => ({ value: entry.id, label: entry.name, disabled: !entry.models.length })),
  ];
  const modelChoices: Choice[] = [
    ...(model ? [] : [{ value: settings.model.modelId, label: settings.model.modelId || 'Choose a model' }]),
    ...(provider?.models ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const effortChoices: Choice[] = [
    ...(levels.includes(settings.thinkingLevel) ? []
      : [{ value: settings.thinkingLevel, label: thinkingLevelLabel(settings.thinkingLevel) }]),
    ...levels.map((level) => ({ value: level, label: thinkingLevelLabel(level) })),
  ];
  const environmentChoices: Choice[] = [
    { value: LOCAL, label: 'This Mac' },
    ...(target.kind === 'ssh' && machine === undefined ? [{ value: target.machineId, label: target.machineId }] : []),
    ...machines.map(([endpoint, record]) => ({ value: endpoint, label: record.name })),
  ];
  const note = (text: string | undefined, tone: 'error' | 'muted' = 'muted'): ReactNode => text === undefined ? null
    : <FieldDescription className={tone === 'error' ? 'text-destructive' : undefined}>{text}</FieldDescription>;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Chat Settings</DialogTitle>
        <DialogDescription>These settings apply to the next response in this chat.</DialogDescription>
      </DialogHeader>
      {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <FieldGroup>
        <FieldSet>
          <FieldLegend>Model</FieldLegend>
          <ChoiceField id="chat-provider" label="Provider" value={settings.model.provider} choices={providerChoices}
            disabled={disabled} onChange={chooseProvider} />
          <ChoiceField id="chat-model" label="Model" value={settings.model.modelId} choices={modelChoices}
            disabled={disabled || !provider?.models.length} onChange={chooseModel} />
          <ChoiceField id="chat-effort" label="Reasoning effort" value={settings.thinkingLevel} choices={effortChoices}
            disabled={disabled || !canChooseEffort} onChange={chooseEffort} />
          {note(settingsError && (settings.model.modelId ? settingsError
            : 'Choose a model to finish changing the provider.'), 'error')}
          {note(effortNote)}
        </FieldSet>
        {access !== undefined && !access.connected && (
          <Alert>
            <AlertDescription>
              {access.error || `Connect ${provider?.name || settings.model.provider} in Settings before sending a `
                + 'message. You can save your choice now.'}
            </AlertDescription>
            <AlertAction>
              <Button type="button" variant="link" size="xs"
                onClick={() => openSettings(providersPane(settings.model.provider))}>Open Settings…</Button>
            </AlertAction>
          </Alert>
        )}
        <FieldSet>
          <FieldLegend>Execution</FieldLegend>
          <ChoiceField id="chat-environment" label="Environment" value={targetId(execution)}
            choices={environmentChoices} disabled={disabled || listed === undefined} onChange={chooseEnvironment} />
          <Field orientation="horizontal">
            <FieldLabel htmlFor="chat-cwd">Working directory</FieldLabel>
            <Input id="chat-cwd" className="w-56" value={execution.cwd ?? ''} disabled={disabled}
              placeholder={target.kind === 'ssh' ? 'Home directory' : 'This chat’s own folder'}
              onChange={(event) => setExecution({ ...execution, cwd: event.target.value.trim() ? event.target.value : null })} />
          </Field>
          {browsing && target.kind === 'ssh'
            ? <DirectoryBrowser chat={chat} machineId={target.machineId} machineName={machineName ?? 'the machine'}
              start={execution.cwd} onCancel={() => setBrowsing(false)}
              onChoose={(path) => {
                setExecution({ ...execution, cwd: path });
                setBrowsing(false);
              }} />
            : <div>
              <Button type="button" variant="outline" size="sm" disabled={disabled || (target.kind === 'ssh' && !machine)}
                onClick={chooseFolder}>Choose Folder…</Button>
            </div>}
          {note(executionError, 'error')}
          {note(target.kind === 'ssh' ? 'The machine runs the tools over SSH in the folder, or in its home directory '
            + 'when none is set. Switching environments does not copy files.'
            : 'The tools run on this Mac in the folder, or in a folder of the chat’s own when none is set.')}
        </FieldSet>
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={refresh}>
            {refreshing ? 'Refreshing Models…' : 'Refresh Models'}
          </Button>
          <span className="text-xs text-muted-foreground">You can choose a different provider or model for each chat.</span>
        </div>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onDone}>Cancel</Button>
        <Button type="button" disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
      </DialogFooter>
    </>
  );
}

/** The sheet over the chat; its form mounts fresh each time it opens, so a draft never outlives the sheet. */
export function ChatSettingsSheet({ host, chat, controls, open, onOpenChange }: {
  host: Host<MacPrincipal>; chat: ChatRef; controls: ChatControls; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <ChatSettingsForm host={host} chat={chat} initial={controls} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
