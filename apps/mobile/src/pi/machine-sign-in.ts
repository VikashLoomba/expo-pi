import {
  isLoopbackCallback, loopbackRedirect, type ShownAttempt,
} from '@pi-agent/infinichat/pi/infinichat-remote/sign-in-attempt';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { openLoopbackBrowser } from './openai-auth/browser';

/** A sign-in a machine runs for its clients, as `RemoteInfiniChat` (providers) and `RemoteMcp` (MCP servers) show it. */
export interface MachineSignIns<A extends ShownAttempt> {
  signInStep<T>(attempt: number, read: (shown: A) => T | undefined, signal: AbortSignal): Promise<T>;
  answer(promptId: number, value: string): Promise<void>;
}

/**
 * The browser for an authorization URL a machine built, which returns to that machine's loopback: the native receiver
 * listens on the same port and path here and catches the callback, as the phone's own ChatGPT sign-in does
 * (`openai-auth/browser.ts`). Resolves with the callback once it is the return to that redirect
 * (`isLoopbackCallback`), or undefined without one, when the machine's prompt waits for the return URL to be pasted.
 * A URL that returns elsewhere opens in the browser for the user to finish there.
 */
export async function openMachineSignIn(url: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const redirect = loopbackRedirect(url);
  if (redirect === undefined) {
    await WebBrowser.openBrowserAsync(url);
    return undefined;
  }
  const callback = await openLoopbackBrowser(redirect,
    () => WebBrowser.openAuthSessionAsync(url, redirect.url.href), signal);
  return callback !== undefined && isLoopbackCallback(callback, redirect) ? callback : undefined;
}

/**
 * This phone's part of machine sign-in attempt `attempt`: once it shows its URL, the browser opens and never outlives
 * the attempt, however that ends; a callback answers the attempt's `manual_code` prompt, so nothing is pasted. Without
 * one the prompt stays for the return URL. A browser that failed calls `onBrowserFailed`, for the caller to end the
 * attempt, as a failed browser ends the phone's own; leaving the machine's prompt open would wait for a paste nobody
 * was asked for. It rejects when the attempt ends first, which the machine's state explains.
 */
export async function relayMachineSignIn<A extends ShownAttempt>(signIns: MachineSignIns<A>, attempt: number,
  signal: AbortSignal, onBrowserFailed: () => void): Promise<void> {
  const url = await signIns.signInStep(attempt, (step) => step.url, signal);
  const browser = new AbortController();
  const stop = () => browser.abort();
  signal.addEventListener('abort', stop, { once: true });
  void signIns.signInStep(attempt, () => undefined, browser.signal).catch(stop);
  try {
    const callback = await openMachineSignIn(url, browser.signal).catch((error: unknown) => {
      if (!browser.signal.aborted) onBrowserFailed();
      throw error;
    });
    if (callback === undefined) return;
    const prompt = await signIns.signInStep(attempt,
      (step) => step.prompt?.prompt.type === 'manual_code' ? step.prompt.id : undefined, browser.signal);
    await signIns.answer(prompt, callback);
  } finally {
    signal.removeEventListener('abort', stop);
    browser.abort();
  }
}

/** The attempt's URL again, in the external browser, whose address bar shows the return URL to paste. */
export async function openSignInPage(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The sign-in link is invalid.');
  await Linking.openURL(parsed.href);
}
