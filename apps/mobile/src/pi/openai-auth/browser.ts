import type { LoopbackRedirect } from '@pi-agent/infinichat/pi/infinichat-remote/sign-in-attempt';
import * as WebBrowser from 'expo-web-browser';

import receiver from '../../../modules/pi-oauth-callback/src/PiOAuthCallbackModule';

/** What Expo's authentication browser settles with: `AuthRequest.promptAsync` or `WebBrowser.openAuthSessionAsync`. */
type Presented = { type: string; url?: string };
type BrowserOutcome = { source: 'browser'; result?: Presented };
type CallbackOutcome = { source: 'listener'; url?: string };

/**
 * A browser sign-in that returns to the loopback `redirect`: Expo owns presentation (`present`), and the native
 * receiver owns only the HTTP callback on the redirect's port and path. Resolves with the whole callback URL, from the
 * receiver or the browser, or undefined without one, for the flow's manual return.
 */
export async function openLoopbackBrowser(redirect: LoopbackRedirect, present: () => Promise<Presented>,
  signal: AbortSignal): Promise<string | undefined> {
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
      sessionId = await receiver.start(redirect.url.hostname, redirect.port, redirect.url.pathname, redirect.state);
      callback = receiver.waitForCallback(sessionId).then(
        (value): CallbackOutcome => ({ source: 'listener', url: value }),
        (): CallbackOutcome => ({ source: 'listener' }),
      );
    } catch {
      signal.throwIfAborted();
      // Whenever the receiver cannot start (an occupied port, an active session, a startup failure),
      // Expo's browser and the flow's manual return still complete this same attempt.
    }
    signal.throwIfAborted();
    browserPending = true;
    browser = present().then(
      (result): BrowserOutcome => ({ source: 'browser', result }),
      (): BrowserOutcome => ({ source: 'browser' }),
    ).then((outcome) => { browserPending = false; settledBrowser = outcome; return outcome; });
    const first = await (callback ? Promise.race([callback, browser]) : browser);
    signal.throwIfAborted();
    if (first.source === 'listener') {
      // Latch the callback before dismissing. Expo releases its own auth lock
      // only after the browser settles, so drain it before permitting a retry.
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
