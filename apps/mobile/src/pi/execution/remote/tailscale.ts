import { TailscaleLogins } from '@pi-agent/infinichat/pi/infinichat-remote/tailscale';
import * as WebBrowser from 'expo-web-browser';

/** One SSH connection's Tailscale sign-in, if its auth banner asks for one. */
export interface TailscaleSignIn {
  /** Goes on the connection's `onBanner`. */
  onBanner: (message: string) => void;
  /** The connection settled, however it went: the browser it opened closes. */
  settled: () => void;
}

/**
 * Tailscale SSH's check-mode sign-in on this iPhone: the URL in the connection's auth banner opens in an in-app
 * browser, and that browser closes by itself once the held connection went on, as a sign-in browser does. The library
 * keeps the connection waiting meanwhile, outside its connect timeout. One browser at a time: a connection held
 * while another's browser is up goes on with that sign-in, since a check covers the tailnet's whole check period.
 */
export function tailscaleSignIn(): TailscaleSignIn {
  let open = false;
  const logins = new TailscaleLogins((url) => {
    open = true;
    WebBrowser.openBrowserAsync(url).catch(() => undefined).finally(() => { open = false; });
  });
  return {
    onBanner: (message) => logins.watch(message),
    settled: () => {
      if (open) void WebBrowser.dismissBrowser().catch(() => undefined);
    },
  };
}
