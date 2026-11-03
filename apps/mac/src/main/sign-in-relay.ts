import { createServer, type Server } from 'node:http';

import {
  isLoopbackCallback, loopbackRedirect, type LoopbackRedirect, type ShownAttempt,
} from '@pi-agent/infinichat/pi/infinichat-remote/sign-in-attempt';
import { Utils } from 'electrobun/main';

/**
 * A sign-in attempt kept as state: the holder machine's provider or MCP sign-in, as `MacInfiniChat` mirrors them, or
 * this Mac's own.
 */
export interface SignInSource {
  subscribe(listener: () => void): () => void;
  getSignIn(): ShownAttempt | null | undefined;
}

/** The page the browser lands on, as the phone's receiver answers it (`OAuthCallbackHTTP.swift`). */
function page(success: boolean): string {
  const title = success ? 'Sign-in complete' : 'Sign-in failed';
  const next = success ? 'Return to InfiniChat to continue.' : 'Return to the sign-in page to continue.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>`
    + `<body><h1>${title}</h1><p>${next}</p></body></html>`;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * This Mac's part of a sign-in, the counterpart of the phone's flow in `useInfiniChatAccount`: the attempt's URL opens
 * in the default browser once. An attempt on the holder machine runs there with no browser and asks for the
 * browser's return URL as a `manual_code` prompt: a provider's through pi-ai, an MCP server's through the tools
 * plugin. When its authorization URL returns to a loopback redirect (`loopbackRedirect`), a receiver on that port and
 * path catches the callback, and `answer` hands it to that prompt, so nothing is pasted. The receiver listens only
 * while the attempt runs and closes with it; a callback that fails its check leaves the prompt for the sheet to
 * answer by hand. When the holder is this Mac, its own callback server already listens there and the browser reaches
 * it, so the port being taken is no failure. An attempt of this Mac's own account has no `answer`: pi-ai's flow
 * listens for the callback here, so only the browser is this relay's part. It follows the attempt as state, so a
 * closed window changes nothing.
 */
export class SignInRelay {
  private readonly stop: () => void;
  /** The attempt whose URL was opened. */
  private opened?: number;
  private receiver?: { attempt: number; server: Server; callback?: string; answered?: number };

  constructor(private readonly source: SignInSource,
    private readonly answer?: (promptId: number, value: string) => Promise<void>) {
    this.stop = source.subscribe(() => this.sync());
    this.sync();
  }

  close(): void {
    this.stop();
    this.release();
  }

  private sync(): void {
    const shown = this.source.getSignIn() ?? null;
    if (shown === null || !shown.running) {
      this.release();
      return;
    }
    if (this.receiver !== undefined && this.receiver.attempt !== shown.attempt) this.release();
    if (shown.url !== undefined && this.opened !== shown.attempt) {
      this.opened = shown.attempt;
      Utils.openExternal(shown.url);
      const redirect = this.answer === undefined ? undefined : loopbackRedirect(shown.url);
      if (redirect !== undefined) this.listen(shown.attempt, redirect);
    }
    const receiver = this.receiver;
    const prompt = shown.prompt;
    if (this.answer === undefined || receiver?.callback === undefined || prompt === undefined
      || prompt.prompt.type !== 'manual_code' || receiver.answered === prompt.id) return;
    receiver.answered = prompt.id;
    void this.answer(prompt.id, receiver.callback).catch((error: unknown) => {
      console.warn(`The sign-in callback could not be handed to the machine: ${message(error)}`);
    });
  }

  private listen(attempt: number, redirect: LoopbackRedirect): void {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirect.url.origin).toString();
      let success = false;
      if (this.receiver?.server === server && this.receiver.callback === undefined) {
        if (isLoopbackCallback(url, redirect)) {
          this.receiver.callback = url;
          success = true;
        } else {
          console.warn('The sign-in callback was refused: it does not match the sign-in’s redirect and state.');
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
    server.on('error', (error: Error) => {
      if (this.receiver?.server === server) this.receiver = undefined;
      // Taken by the holder's own callback server when it runs on this Mac, which the browser then reaches.
      if ('code' in error && error.code === 'EADDRINUSE') return;
      console.warn(`The sign-in receiver could not listen on ${redirect.url.host}: ${error.message}. `
        + 'Paste the return URL in the sheet.');
    });
    // `localhost` is served on 127.0.0.1, as pi-mcp's callback server serves it; browsers fall back to it.
    server.listen(redirect.port, redirect.url.hostname === 'localhost' ? '127.0.0.1' : redirect.url.hostname);
    this.receiver = { attempt, server };
  }

  private release(): void {
    this.receiver?.server.close();
    this.receiver = undefined;
  }
}
