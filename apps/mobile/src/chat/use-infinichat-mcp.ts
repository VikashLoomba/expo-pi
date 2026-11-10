import type { McpView, RemoteMcp } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-client';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { openSignInPage as openPage } from '../pi/machine-sign-in';
import { useMachines, useShownMachine } from './chat-provider';
import { useMachineSignIn, useSignInPage } from './use-machine-sign-in';

const subscribeNothing = () => () => {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** The latest sign-in of the machine's MCP servers. */
const mcpAttempt = (mcp: RemoteMcp) => mcp.getAttempt();

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
  // This phone's part of an attempt it started; it ends with the screen and with the machine shown.
  const relay = useMachineSignIn(mcp, mcpAttempt);
  const attempt = view?.signInAttempt ?? null;
  const { browserOpen, openSignInPage } = useSignInPage(attempt, (_shown, url) => openPage(url),
    ({ server }) => setNotice({ server, message: 'Could not open the sign-in page. Please try again.' }));
  const signIn = (server: string) => relay.run((machine) => machine.signIn(server),
    (text) => setNotice(text === undefined ? undefined : { server, message: text }));
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
  return {
    view,
    machine: remote === undefined ? undefined : listed?.machines[remote.machineId]?.name ?? 'the machine',
    notice,
    busy,
    browserOpen,
    signIn,
    cancelSignIn: relay.cancel,
    signOut: (server: string) => act(server, () => mcp?.signOut(server) ?? Promise.resolve()),
    reconnect: (server: string) => act(server, () => mcp?.reconnect(server) ?? Promise.resolve()),
    answer: (promptId: number, value: string) => {
      if (!mcp) return false;
      void mcp.answer(promptId, value).catch((error: unknown) => {
        if (attempt) setNotice({ server: attempt.server, message: message(error) });
      });
      return true;
    },
    openSignInPage,
  };
}
