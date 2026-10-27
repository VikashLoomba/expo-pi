import { OPENAI_DISCOVERY } from '@pi-agent/infinichat/pi/openai-auth/core';
import type { AuthRequest, AuthSessionResult } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import receiver from '../../../modules/pi-oauth-callback/src/PiOAuthCallbackModule';

type BrowserOutcome = { source: 'browser'; result?: AuthSessionResult };
type CallbackOutcome = { source: 'listener'; url?: string };

/** Expo owns presentation; the native receiver owns only the HTTP callback. */
export async function openOpenAIBrowser(request: AuthRequest, url: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  let sessionId: string | undefined;
  let stopped: Promise<void> | undefined;
  let callback: Promise<CallbackOutcome> | undefined;
  let browser: Promise<BrowserOutcome> | undefined;
  let settledBrowser: BrowserOutcome | undefined;
  let browserPending = false;
  let browserDismissed = false;
  const stop = () => {
    if (sessionId) stopped ??= receiver.stop(sessionId);
    return stopped ?? Promise.resolve();
  };
  const dismiss = () => {
    if (!browserPending || browserDismissed) return;
    browserDismissed = true;
    try { WebBrowser.dismissAuthSession(); } catch { /* The browser may already have closed. */ }
  };
  const abort = () => { dismiss(); void stop().catch(() => {}); };
  const browserCallback = (outcome: BrowserOutcome) => {
    if (outcome.result?.type === 'locked') throw new Error('Another sign-in browser is open. Close it and try again.');
    return outcome.result?.type === 'success' || outcome.result?.type === 'error' ? outcome.result.url : undefined;
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    try {
      // Await real readiness, not merely listener construction, before the
      // browser can redirect. The native receiver caches an early callback.
      sessionId = await receiver.start(request.state);
      callback = receiver.waitForCallback(sessionId).then(
        (value): CallbackOutcome => ({ source: 'listener', url: value }),
        (): CallbackOutcome => ({ source: 'listener' }),
      );
    } catch {
      signal.throwIfAborted();
      // Whenever the receiver cannot start (an occupied port, an active session, a startup failure),
      // Expo's browser and Pi's manual_code fallback still complete this same PKCE attempt.
    }
    signal.throwIfAborted();
    browserPending = true;
    browser = request.promptAsync(OPENAI_DISCOVERY, { url }).then(
      (result): BrowserOutcome => ({ source: 'browser', result }),
      (): BrowserOutcome => ({ source: 'browser' }),
    ).then((outcome) => { browserPending = false; settledBrowser = outcome; return outcome; });
    const first = await (callback ? Promise.race([callback, browser]) : browser);
    signal.throwIfAborted();
    if (first.source === 'listener') {
      // Latch the callback before dismissing. Expo releases its own auth lock
      // only after promptAsync settles, so drain it before permitting a retry.
      // A failed receiver does not own or invalidate the browser. Let Expo's
      // ordinary return/dismissal path finish before offering manual entry.
      if (first.url && !settledBrowser) dismiss();
      const browserResult = await browser;
      signal.throwIfAborted();
      const returned = browserCallback(browserResult);
      return first.url ?? returned;
    }
    const returned = browserCallback(first);
    if (returned) return returned;
    if (callback) {
      // Native stop is an actor barrier: a callback already accepted is
      // delivered to the waiter; otherwise stop rejects it. This prevents a
      // simultaneous browser dismissal from discarding a buffered callback.
      await stop();
      const pending = await callback;
      signal.throwIfAborted();
      if (pending.url) return pending.url;
    }
    return undefined;
  } finally {
    signal.removeEventListener('abort', abort);
    dismiss();
    await stop();
    // No later browser completion or dismissal can affect a subsequent login.
    await browser;
    signal.throwIfAborted();
  }
}
