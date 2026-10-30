import type { MachineAccess } from '@pi-agent/infinichat/pi/infinichat-remote/client';
import {
  getModelSettingsError, type ChatModelSettings, type ModelCatalog,
} from '@pi-agent/infinichat/pi/model-catalog';
import { useState } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { errorText, useMember } from '../../hooks/use-ref';
import { AgentMark, ChatAgentContext } from '../chat/agent';
import { ModelSection } from '../chat/model-section';
import { Notice } from '../chat/notices';
import { Button } from '../ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { FormSheet } from './form-sheet';

/** The main model answers and works; the summary model writes the memory's summaries in the background. */
type Role = 'main' | 'summary';
const ROLES: readonly Role[] = ['main', 'summary'];
const TITLES: Record<Role, string> = { main: 'Main model', summary: 'Summary model' };
const CAPTIONS: Record<Role, string> = {
  main: 'The main model answers you. InfiniChat sends and summarizes nothing until both models are chosen.',
  summary: 'The summary model condenses the chat into the memory each answer starts from. Summaries run in the '
    + 'background after every message, so a fast, inexpensive model suits them.',
};
const SUBAGENTS_TITLE = 'Subagent model';
const SUBAGENTS_CAPTION = 'Subagents work in the background on tasks InfiniChat hands them, when you ask for them.';
/** How UniiChat's prompt.txt describes the user's own instructions, which follow the prompt. */
const INSTRUCTIONS_PLACEHOLDER = 'Who you are, how your files are organized and how you want work done.';
const DEFAULT_NAME = 'InfiniChat';
const TITLE = 'InfiniChat settings';
/** OptChat has no default model; an unchosen one is shown as such until the user picks it. */
const unchosen: ChatModelSettings = { model: { provider: '', modelId: '' }, thinkingLevel: 'off' };

/**
 * The settings the conversation keeps; the avatar is this Mac's and applies as it is chosen. `subagents` is `null`
 * while subagents run on the main model.
 */
type Draft = {
  main: ChatModelSettings; summary: ChatModelSettings; instructions: string; name: string;
  subagents: ChatModelSettings | null;
};
const sameSettings = (left: ChatModelSettings, right: ChatModelSettings) => left.model.provider === right.model.provider
  && left.model.modelId === right.model.modelId && left.thinkingLevel === right.thinkingLevel;
const sameChoice = (left: ChatModelSettings | null, right: ChatModelSettings | null) =>
  left === null || right === null ? left === right : sameSettings(left, right);

/**
 * InfiniChat's settings as the phone's sheet (`infinichat-settings/index.tsx`): the draft is taken from the
 * conversation's controls as the sheet opens and kept until Save or Cancel, whatever the conversation does meanwhile.
 */
export function SettingsSheet({ open, onClose, onOpenProviders }: {
  open: boolean; onClose: () => void; onOpenProviders: (providerId: string) => void;
}) {
  const ref = useInfiniChatRef();
  const controls = useMember(ref.controls);
  const catalog = useMember(ref.catalog) ?? [];
  const accesses = useMember(ref.access) ?? {};
  const avatar = useMember(ref.avatar) ?? undefined;
  const machine = useMember(ref.machine)?.name ?? 'the machine';
  if (!controls) {
    return (
      <FormSheet open={open} onClose={onClose} title={TITLE}>
        <p className="text-muted-foreground">InfiniChat settings will be available when InfiniChat finishes loading.</p>
      </FormSheet>
    );
  }
  return (
    <SettingsForm open={open} onClose={onClose} onOpenProviders={onOpenProviders} catalog={catalog}
      accesses={accesses} avatar={avatar} machine={machine}
      initial={{ main: controls.settings, summary: controls.summary ?? unchosen, instructions: controls.instructions,
        name: controls.name, subagents: controls.subagents }} />
  );
}

function SettingsForm({ open, onClose, onOpenProviders, initial: opened, catalog, accesses, avatar, machine }: {
  open: boolean; onClose: () => void; onOpenProviders: (providerId: string) => void; initial: Draft;
  catalog: ModelCatalog; accesses: MachineAccess; avatar: string | undefined; machine: string;
}) {
  const ref = useInfiniChatRef();
  // The saved settings the draft is compared with, as the sheet opened; what the conversation does meanwhile waits.
  const [initial] = useState(opened);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const changed = !sameSettings(draft.main, initial.main) || !sameSettings(draft.summary, initial.summary)
    || !sameChoice(draft.subagents, initial.subagents)
    || draft.instructions !== initial.instructions || draft.name !== initial.name;
  const errors: Record<Role, string | undefined> = {
    main: getModelSettingsError(catalog, draft.main), summary: getModelSettingsError(catalog, draft.summary),
  };
  const subagentsError = draft.subagents ? getModelSettingsError(catalog, draft.subagents) : undefined;
  const canSave = !saving && changed && !errors.main && !errors.summary && !subagentsError;
  const providerName = (providerId: string) => catalog.find((entry) => entry.id === providerId)?.name || providerId;
  // A chosen provider that is not connected yet; the choices can still be saved.
  const unconnected = [...new Set([draft.main.model.provider, draft.summary.model.provider,
    draft.subagents?.model.provider ?? ''])]
    .filter((providerId) => providerId && !accesses[providerId]?.connected);
  // A provider that was never chosen needs no notice: its row asks for one.
  const choiceError = (settings: ChatModelSettings, error: string | undefined) => !settings.model.provider ? undefined
    : settings.model.modelId ? error : 'Choose a model to finish changing the provider.';
  const choose = (role: Role, settings: ChatModelSettings) => {
    setDraft((current) => role === 'main' ? { ...current, main: settings } : { ...current, summary: settings });
  };
  // Choosing a model of their own starts from the main one, which they ran on until then.
  const sameAsMain = (
    <Field orientation="horizontal">
      <FieldLabel htmlFor="infinichat-subagents-same">Same as main model</FieldLabel>
      <Switch id="infinichat-subagents-same" checked={draft.subagents === null} disabled={saving}
        onCheckedChange={(same) => setDraft((current) => ({ ...current, subagents: same ? null : current.main }))} />
    </Field>
  );
  const save = () => {
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    // One commit on the machine: the main model and the instructions with pi-durable's `configure`, and the summary
    // and subagent models and the name in OptChat's ConfigDoc.
    void ref.updateSettings({ main: draft.main, summary: draft.summary, instructions: draft.instructions.trim(),
      name: draft.name.trim(), subagents: draft.subagents }).then(onClose, (cause: unknown) => {
      setError(errorText(cause, 'Could not save these settings. Try again.'));
    }).finally(() => setSaving(false));
  };
  const act = (work: Promise<unknown>, fallback: string) => {
    setError(undefined);
    void work.catch((cause: unknown) => setError(errorText(cause, fallback)));
  };
  return (
    <FormSheet open={open} onClose={onClose} dirty={changed} title={TITLE} className="sm:max-w-xl"
      save={{ label: 'Save', disabled: !canSave, busy: saving, onSave: save }}>
      <div className="-mx-4 flex max-h-[65vh] flex-col gap-5 overflow-y-auto px-4">
        {error !== undefined && <Notice message={error} />}
        <FieldSet>
          <FieldLegend>Name and avatar</FieldLegend>
          <FieldGroup>
            <div className="flex items-center gap-3.5">
              <ChatAgentContext value={{ name: draft.name.trim() || DEFAULT_NAME, avatar }}>
                <AgentMark size={56} />
              </ChatAgentContext>
              <Field className="flex-1">
                <FieldLabel htmlFor="infinichat-name">Name</FieldLabel>
                <Input id="infinichat-name" value={draft.name} placeholder={DEFAULT_NAME} disabled={saving}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={saving}
                onClick={() => act(ref.setAvatar(), 'The avatar could not be chosen.')}>
                {avatar ? 'Choose Another Avatar…' : 'Choose Avatar…'}
              </Button>
              {avatar && (
                <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={saving}
                  onClick={() => act(ref.clearAvatar(), 'The avatar could not be removed.')}>
                  Remove Avatar
                </Button>
              )}
            </div>
            <FieldDescription>
              It goes by this name in the chat and in its own instructions. The avatar is an image file you choose
              and stays on this Mac.
            </FieldDescription>
          </FieldGroup>
        </FieldSet>
        {ROLES.map((role) => (
          <ModelSection key={role} title={TITLES[role]} caption={CAPTIONS[role]}
            error={choiceError(draft[role], errors[role])} catalog={catalog} settings={draft[role]} disabled={saving}
            onChange={(settings) => choose(role, settings)} />
        ))}
        {draft.subagents ? (
          <ModelSection title={SUBAGENTS_TITLE} caption={SUBAGENTS_CAPTION}
            error={choiceError(draft.subagents, subagentsError)} catalog={catalog} settings={draft.subagents}
            disabled={saving} onChange={(subagents) => setDraft((current) => ({ ...current, subagents }))}>
            {sameAsMain}
          </ModelSection>
        ) : (
          <FieldSet>
            <FieldLegend>{SUBAGENTS_TITLE}</FieldLegend>
            <FieldGroup>
              {sameAsMain}
              <FieldDescription>{SUBAGENTS_CAPTION}</FieldDescription>
            </FieldGroup>
          </FieldSet>
        )}
        {unconnected.map((providerId) => (
          <Notice key={providerId} tone="neutral"
            message={accesses[providerId]?.error ?? `Sign in to ${providerName(providerId)} on ${machine} before `
              + 'InfiniChat can use it. You can save your choice now.'}
            action={saving ? undefined : `Sign in on ${machine}`} onAction={() => onOpenProviders(providerId)} />
        ))}
        <FieldSet>
          <FieldLegend>Instructions</FieldLegend>
          <FieldGroup>
            <Textarea value={draft.instructions} placeholder={INSTRUCTIONS_PLACEHOLDER} rows={5} disabled={saving}
              onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} />
            <FieldDescription>
              InfiniChat runs each command on {machine} or on one of your machines, choosing for each command.
              Changing models keeps InfiniChat’s memory and history.
            </FieldDescription>
          </FieldGroup>
        </FieldSet>
      </div>
    </FormSheet>
  );
}
