import { createServer, type Server } from 'node:http';

import {
  OPENAI_DISCOVERY, OPENAI_REDIRECT_URI, validateOpenAICallback,
} from '@pi-agent/infinichat/pi/openai-auth/core';
import { Utils } from 'electrobun/main';

import type { MacInfiniChat } from './infinichat';

const CALLBACK = new URL(OPENAI_REDIRECT_URI);

/** The page the browser lands on, as the phone's receiver answers it (`OAuthCallbackHTTP.swift`). */
function page(success: boolean): string {
  const title = success ? 'Sign-in complete' : 'Sign-in failed';
  const next = success ? 'Return to InfiniChat to continue.' : 'Return to the sign-in page to continue.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>`
    + `<body><h1>${title}</h1><p>${next}</p></body></html>`;
}

/** The state a ChatGPT authorization URL expects its callback to return with; another provider's URL has none. */
function stateOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const expected = new URL(OPENAI_DISCOVERY.authorizationEndpoint);
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname
    || parsed.searchParams.get('redirect_uri') !== OPENAI_REDIRECT_URI) return undefined;
  return parsed.searchParams.get('state') ?? undefined;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * This Mac's part of a sign-in on the holder machine, the counterpart of the phone's flow in `useInfiniChatAccount`:
 * the attempt runs on the machine through pi-ai, which has no browser there and asks for the browser's return URL as
 * a `manual_code` prompt. Here the attempt's URL opens in the default browser once, and a receiver on ChatGPT's
 * loopback redirect catches the callback and answers that prompt, so nothing is pasted. The receiver listens only
 * while the attempt runs and closes with it; a callback that fails its check leaves the prompt for the providers
 * sheet to answer by hand. It follows the shown machine's attempt as state, so a closed window changes nothing.
 */
export class SignInRelay {
  private readonly stop: () => void;
  /** The attempt whose URL was opened. */
  private opened?: number;
  private receiver?: { attempt: number; server: Server; callback?: string; answered?: number };

  constructor(private readonly infinichat: MacInfiniChat) {
    this.stop = infinichat.subscribe(() => this.sync());
    this.sync();
  }

  close(): void {
    this.stop();
    this.release();
  }

  private sync(): void {
    const shown = this.infinichat.getSignIn() ?? null;
    if (shown === null || !shown.running) {
      this.release();
      return;
    }
    if (this.receiver !== undefined && this.receiver.attempt !== shown.attempt) this.release();
    if (shown.url !== undefined && this.opened !== shown.attempt) {
      this.opened = shown.attempt;
      Utils.openExternal(shown.url);
      const state = stateOf(shown.url);
      if (state !== undefined) this.listen(shown.attempt, state);
    }
    const receiver = this.receiver;
    const prompt = shown.prompt;
    if (receiver?.callback === undefined || prompt === undefined || prompt.prompt.type !== 'manual_code'
      || receiver.answered === prompt.id) return;
    receiver.answered = prompt.id;
    void this.infinichat.answer(prompt.id, receiver.callback).catch((error: unknown) => {
      console.warn(`The sign-in callback could not be handed to the machine: ${message(error)}`);
    });
  }

  private listen(attempt: number, state: string): void {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', CALLBACK.origin);
      let success = false;
      if (url.pathname === CALLBACK.pathname && this.receiver?.server === server
        && this.receiver.callback === undefined) {
        try {
          validateOpenAICallback(url.toString(), state);
          this.receiver.callback = url.toString();
          success = true;
        } catch (error) {
          console.warn(`The sign-in callback was refused: ${message(error)}`);
        }
      }
      const body = page(success);
      response.writeHead(success ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', Connection: 'close',
      });
      response.end(body);
      if (success) this.sync();
    });
    server.on('error', (error) => {
      console.warn(`The sign-in receiver could not listen on ${CALLBACK.host}: ${error.message}. `
        + 'Paste the return URL in the providers sheet.');
      if (this.receiver?.server === server) this.receiver = undefined;
    });
    server.listen(Number(CALLBACK.port), CALLBACK.hostname);
    this.receiver = { attempt, server };
  }

  private release(): void {
    this.receiver?.server.close();
    this.receiver = undefined;
  }
}
