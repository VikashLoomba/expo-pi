/**
 * Tailscale SSH's check mode sends the sign-in it wants as an SSH auth banner before authentication, and waits
 * (tailscale `ssh/tailssh/tailssh.go`, `HoldAndDelegate`): the person signs in with the URL in a browser, and the
 * waiting connection goes on. A check holds for the tailnet's check period, 12 hours by default, so one sign-in
 * covers every connection the app makes meanwhile. `ssh` prints the banner to stderr; the phone's SSH library hands
 * it to its `onBanner` handler.
 */
const LOGIN_URL = /https:\/\/login\.tailscale\.com\/[^\s'"<>]+/;

/** The sign-in URL in a banner or a piece of `ssh` output, if any. */
export const tailscaleLogin = (text: string): string | undefined => LOGIN_URL.exec(text)?.[0];

/** Opens each sign-in URL once, the app's way. */
export class TailscaleLogins {
  private readonly opened = new Set<string>();

  constructor(private readonly open: (url: string) => void) {}

  /** Watches banners or `ssh` diagnostics for the sign-in. */
  watch(text: string): void {
    const url = tailscaleLogin(text);
    if (url === undefined || this.opened.has(url)) return;
    this.opened.add(url);
    this.open(url);
  }
}
