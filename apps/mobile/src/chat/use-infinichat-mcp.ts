import type { McpView } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { openSignInPage, relayMachineSignIn } from '../pi/machine-sign-in';
import { useMachines, useShownMachine } from './chat-provider';

const subscribeNothing = () => () => {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What `/mcp` shows while InfiniChat runs on this iPhone, as `/reload-plugins` says (`infinichat-service.ts`). */
export const MCP_ON_PHONE = 'MCP servers run on a machine’s InfiniChat server. Move InfiniChat to a machine to use them.';

/** `/mcp`'s notice for one server: what its last action here ran into. */
export interface McpNotice { server: string; message: string }

/**
 * The MCP servers of the machine InfiniChat runs on, as `/mcp` shows them (`RemoteMcp`), and their sign-ins, which run
 * on the machine as its provider sign-ins do: this iPhone's browser and receiver only return the callback to its
 * prompt (`relayMachineSignIn`). Undefined `view` until connected; `machine` is undefined while InfiniChat runs here.
 */
export function useInfiniChatMcp() {
  const remote = useShownMachine();
  const listed = useMachines();
  const mcp = remote?.mcp;
  const getView = useCallback((): McpView | undefined => mcp?.getSnapshot(), [mcp]);
  const view = useSyncExternalStore(mcp?.subscribe ?? subscribeNothing, getView, getView);
  const [notice, setNotice] = useState<McpNotice>();
  const [busy, setBusy] = useState<string>();
  const [browserOpen, setBrowserOpen] = useState(false);
  // This phone's part of an attempt it started; it ends with the screen and with the machine shown.
  const flow = useRef<AbortController | null>(null);
  useEffect(() => () => flow.current?.abort(), [mcp]);
  const cancelSignIn = useCallback(() => {
    flow.current?.abort();
    if (mcp?.getAttempt()?.running) void mcp.cancelSignIn().catch(() => {});
  }, [mcp]);

  const signIn = async (server: string) => {
    if (!mcp || flow.current) return;
    const controller = new AbortController();
    flow.current = controller;
    setNotice(undefined);
    try {
      // A sign-in the machine never started has no state there to say why.
      const attempt = await mcp.signIn(server).catch((error: unknown) => {
        setNotice({ server, message: message(error) });
        throw error;
      });
      await relayMachineSignIn(mcp, attempt, controller.signal, () => {
        setNotice({ server, message: 'Sign-in could not be completed. Please try again.' });
        void mcp.cancelSignIn().catch(() => {});
      });
    } catch {
      // The machine's state says how its attempt went.
    } finally {
      if (flow.current === controller) flow.current = null;
      controller.abort();
    }
  };
  /** A server action other than sign-in, one at a time, whose failure shows as the server's notice. */
  const act = async (server: string, action: () => Promise<void>) => {
    if (busy !== undefined) return;
    setBusy(server);
    setNotice(undefined);
    try {
      await action();
    } catch (error) {
      setNotice({ server, message: message(error) });
    } finally {
      setBusy(undefined);
    }
  };
  const attempt = view?.signInAttempt ?? null;
  return {
    view,
    machine: remote === undefined ? undefined : listed?.machines[remote.machineId]?.name ?? 'the machine',
    notice,
    busy,
    browserOpen,
    signIn,
    cancelSignIn,
    signOut: (server: string) => act(server, () => mcp?.signOut(server) ?? Promise.resolve()),
    reconnect: (server: string) => act(server, () => mcp?.reconnect(server) ?? Promise.resolve()),
    answer: (promptId: number, value: string) => {
      if (!mcp) return false;
      void mcp.answer(promptId, value).catch((error: unknown) => {
        if (attempt) setNotice({ server: attempt.server, message: message(error) });
      });
      return true;
    },
    openSignInPage: async () => {
      if (!attempt?.running || attempt.url === undefined) return;
      setBrowserOpen(true);
      try {
        await openSignInPage(attempt.url);
      } catch {
        setNotice({ server: attempt.server, message: 'Could not open the sign-in page. Please try again.' });
      } finally {
        setBrowserOpen(false);
      }
    },
  };
}
