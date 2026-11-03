import type { ShownAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/sign-in-attempt';
import { useState } from 'react';

import { useOpenExternal } from '../../lib/app-context';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

type Prompt = NonNullable<ShownAttempt['prompt']>;

const MANUAL_INSTRUCTIONS = 'Finish sign-in in your browser. If it does not return here, copy the full address of '
  + 'the final callback page and paste it below, even if that page does not load.';

/**
 * A sign-in step of a machine's attempt as form rows (the phone's `AuthPromptRows`), for a provider's or an MCP
 * server's sign-in, keyed by the prompt so an answer never outlives it.
 */
export function AuthPromptRows({ pending, url, submit }: {
  pending: Prompt; url: string | undefined; submit: (id: number, value: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const openExternal = useOpenExternal();
  const { prompt, id } = pending;
  const manual = prompt.type === 'manual_code';
  const send = () => {
    if (!answer.trim()) return;
    submit(id, answer);
    setAnswer('');
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">{manual ? MANUAL_INSTRUCTIONS : prompt.message}</p>
      {manual && url !== undefined && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => openExternal(url)}>
          Open in browser
        </Button>
      )}
      {prompt.type === 'select' ? prompt.options.map((option) => (
        <Button key={option.id} type="button" variant="outline" size="sm" className="h-auto flex-col items-start"
          onClick={() => submit(id, option.id)}>
          <span>{option.label}</span>
          {option.description !== undefined && (
            <span className="text-xs font-normal text-muted-foreground">{option.description}</span>
          )}
        </Button>
      )) : (
        <div className="flex gap-2">
          <Input type={manual || prompt.type === 'secret' ? 'password' : 'text'} value={answer} autoComplete="off"
            placeholder={manual ? 'Paste the full callback URL' : prompt.placeholder}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              send();
            }} />
          <Button type="button" size="sm" disabled={!answer.trim()} onClick={send}>Continue</Button>
        </div>
      )}
    </div>
  );
}
