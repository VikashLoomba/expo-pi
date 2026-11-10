import type { ShownAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/sign-in-attempt';
import { useCallback, useEffect, useRef, useState } from 'react';

import { relayMachineSignIn, type MachineSignIns } from '../pi/machine-sign-in';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A machine's sign-ins as a screen starts and ends them: `RemoteInfiniChat`'s providers, `RemoteMcp`'s servers. */
export interface MachineSignInSource<A extends ShownAttempt> extends MachineSignIns<A> {
  cancelSignIn(): Promise<void>;
}

/**
 * This phone's part of a sign-in a machine runs, for its providers and its MCP servers alike, as the Mac app's one
 * `SignInRelay` serves both: one at a time, started on the machine, its browser's return relayed to the machine's
 * prompt (`relayMachineSignIn`), and ended with the screen and with the machine shown. `attemptOf` reads the
 * machine's latest attempt.
 */
export function useMachineSignIn<A extends ShownAttempt, S extends MachineSignInSource<A>>(
  source: S | undefined, attemptOf: (source: S) => A | null | undefined) {
  const flow = useRef<AbortController | null>(null);
  useEffect(() => () => flow.current?.abort(), [source]);
  /** Stops only this phone's part, as before a sign-out, which the machine follows with its own cancel. */
  const stop = useCallback(() => flow.current?.abort(), []);
  /** Stops this phone's part, and the machine's attempt when one is under way. */
  const cancel = useCallback(() => {
    flow.current?.abort();
    // Only an attempt under way, so leaving the screen while disconnected starts no connection.
    if (source !== undefined && attemptOf(source)?.running) void source.cancelSignIn().catch(() => {});
  }, [source, attemptOf]);
  /**
   * Starts an attempt with `start`, then relays its browser, unless `relay` is false: a sign-in whose return this
   * phone has no receiver for. `report` takes what this phone's part ran into, and undefined as it starts.
   */
  const run = async (start: (source: S) => Promise<number>, report: (message: string | undefined) => void,
    relay = true) => {
    if (source === undefined || flow.current) return;
    const controller = new AbortController();
    flow.current = controller;
    report(undefined);
    try {
      // A sign-in the machine never started has no state there to say why.
      const attempt = await start(source).catch((error: unknown) => {
        report(errorText(error));
        throw error;
      });
      if (!relay) return;
      await relayMachineSignIn(source, attempt, controller.signal, () => {
        report('Sign-in could not be completed. Please try again.');
        void source.cancelSignIn().catch(() => {});
      });
    } catch {
      // The machine's state says how its attempt went, and a browser that failed leaves its prompt there.
    } finally {
      if (flow.current === controller) flow.current = null;
      controller.abort();
    }
  };
  return { run, cancel, stop };
}

/**
 * The attempt's sign-in page again in the external browser, whose address bar shows the return URL to paste; one at a
 * time. `open` opens the attempt's URL, and `failed` says it couldn't.
 */
export function useSignInPage<A extends ShownAttempt>(shown: A | null | undefined,
  open: (shown: A, url: string, signal: AbortSignal) => Promise<void>, failed: (shown: A) => void) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const manual = useRef<AbortController | null>(null);
  const closeSignInPage = useCallback(() => manual.current?.abort(), []);
  const openSignInPage = async () => {
    if (!shown?.running || shown.url === undefined || manual.current) return;
    const controller = new AbortController();
    manual.current = controller;
    setBrowserOpen(true);
    try {
      await open(shown, shown.url, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      failed(shown);
    } finally {
      if (manual.current === controller) manual.current = null;
      setBrowserOpen(false);
    }
  };
  return { browserOpen, openSignInPage, closeSignInPage };
}
