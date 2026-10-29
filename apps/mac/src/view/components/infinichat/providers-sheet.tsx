import { useEffect, useRef } from 'react';

import { useInfiniChatRef, type InfiniChatRef } from '../../hooks/use-infinichat';
import { useMember } from '../../hooks/use-ref';
import { Notice } from '../chat/notices';
import { ProviderSections } from '../providers/provider-sections';
import { FieldDescription } from '../ui/field';
import { FormSheet } from './form-sheet';

/** The providers of the machine InfiniChat runs on, signed in from this Mac and kept on that machine. */
export function ProvidersSheet({ open, onClose, focus }: { open: boolean; onClose: () => void; focus?: string }) {
  const ref = useInfiniChatRef();
  const machine = useMember(ref.machine)?.name ?? 'the machine';
  return (
    <FormSheet open={open} onClose={onClose} title={`Providers on ${machine}`} className="sm:max-w-xl">
      <Providers api={ref} machine={machine} focus={focus} />
    </FormSheet>
  );
}

function Providers({ api, machine, focus }: { api: InfiniChatRef; machine: string; focus?: string }) {
  const connection = useMember(api.connection);
  const shown = useMember(api.signInAttempt) ?? null;
  const running = useRef(false);
  useEffect(() => {
    running.current = shown?.running === true;
  }, [shown]);
  // As the phone's screen does: leaving ends the sign-in this sheet shows, and only that, so leaving while
  // disconnected starts no connection.
  useEffect(() => () => {
    if (running.current) void api.cancelSignIn().catch(() => {});
  }, [api]);
  return (
    <div className="-mx-4 flex max-h-[65vh] flex-col gap-5 overflow-y-auto px-4">
      {/* The sections keep the last values the machine sent until its reference is live again. */}
      {connection?.status === 'connecting' && <Notice tone="neutral" message={`Connecting to ${machine}…`} />}
      {connection?.status === 'failed' && (
        <Notice message={connection.error ?? `Can’t connect to ${machine}.`} action="Try Again"
          onAction={() => { void api.reconnect(); }} />
      )}
      <ProviderSections account={api} focus={focus} />
      <FieldDescription>
        InfiniChat on {machine} uses these sign-ins and API keys. They are saved on that machine, readable only by
        your account there, and renewed there. This Mac’s own sign-in, which your other chats use, stays separate.
      </FieldDescription>
    </div>
  );
}
