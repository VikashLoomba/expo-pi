import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { useWatch } from '@earendil-works/chord/react';
import { ROOT } from '@pi-agent/infinichat/pi/infinichat/agents';
import { LockIcon, ShieldIcon } from 'lucide-react';
import { useState } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { errorText } from '../../lib/error-text';
import { Notice } from '../chat/notices';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import { FieldDescription } from '../ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../ui/item';
import { FormSheet } from './form-sheet';

function expiresIn(expiresAt: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  return `Expires in ~${minutes} min`;
}

/** Lists active ephemeral credentials held in RAM (metadata only) so the user can revoke one or all. */
export function SecretsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useInfiniChatRef();
  const secrets = useWatch(ref.activeSecrets) ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clear = (id?: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void ref.clearSecrets(id === undefined ? {} : { id }, BACKGROUND_CONTEXT).then(() => {
      if (id === undefined || secrets.length <= 1) onClose();
    }, (cause: unknown) => {
      setError(errorText(cause, 'Could not clear credentials.'));
    }).finally(() => setBusy(false));
  };
  return (
    <FormSheet open={open} onClose={onClose} title="Active credentials" className="sm:max-w-lg"
      leading={secrets.length > 0 ? (
        <Button type="button" variant="outline" className="text-destructive" disabled={busy} onClick={() => clear()}>
          Clear All
        </Button>
      ) : undefined}>
      <div className="-mx-4 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-4">
        {error !== undefined && <Notice message={error} />}
        {secrets.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><LockIcon /></EmptyMedia>
              <EmptyTitle>No active credentials</EmptyTitle>
              <EmptyDescription>
                Credentials stay in memory until they expire, you clear them, or the host restarts.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {secrets.map((secret) => (
              <Item key={secret.id} variant="outline">
                <ItemMedia variant="icon"><ShieldIcon /></ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {secret.label}
                    {secret.agent !== ROOT && <Badge variant="secondary">{secret.agent}</Badge>}
                  </ItemTitle>
                  <ItemDescription>{secret.purpose}</ItemDescription>
                  <ItemDescription>{expiresIn(secret.expiresAt)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button type="button" variant="outline" size="sm" className="text-destructive"
                    disabled={busy} onClick={() => clear(secret.id)}>
                    Clear
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        <FieldDescription>
          Values are kept in memory only, never saved to disk or shown to the model. Clearing invalidates handles
          immediately.
        </FieldDescription>
      </div>
    </FormSheet>
  );
}
