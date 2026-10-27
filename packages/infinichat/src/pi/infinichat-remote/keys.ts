import { quotePosix } from './machine';

/** An OpenSSH public key as `authorized_keys` matches it: its type and base64, with no comment. */
export const isSshKeyBlob = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9@.-]* [A-Za-z0-9+/]+={0,2}$/.test(value);

/** The key's type and base64 from a public key line, without the comment `ssh-keygen` appends. */
export const keyBlob = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(' ');

/**
 * The key exchange on a machine, after `set -eu`: the machine gets its own InfiniChat SSH key at
 * `~/.infinichat/ssh/id_ed25519`, made with `ssh-keygen` when missing, with which its InfiniChat server reaches the
 * other machines (`node/machines.ts`), and `authorized` goes into its `~/.ssh/authorized_keys` as `ssh-copy-id` puts
 * a key, each once. After `printMarker`'s line it prints `ok` and the machine's public key, or `unwritable` when the
 * account can neither write nor read its `authorized_keys`: one it can read but not write, as one made with sudo, is
 * replaced in its own `.ssh` by a copy it owns, which sshd reads the same. Run again, it changes nothing.
 */
export function keyExchangeLines(authorized: readonly string[], printMarker: string): string[] {
  return [
    'umask 077',
    'd="$HOME/.infinichat/ssh"', 'k="$d/id_ed25519"', 'mkdir -p "$d"',
    `[ -f "$k" ] || ssh-keygen -q -t ed25519 -N '' -C infinichat -f "$k"`,
    'mkdir -p "$HOME/.ssh"', 'chmod 700 "$HOME/.ssh"',
    'a="$HOME/.ssh/authorized_keys"', '[ -e "$a" ] || : > "$a"',
    'if [ ! -w "$a" ]; then',
    '  if [ -r "$a" ] && cp "$a" "$a.infinichat" && mv -f "$a.infinichat" "$a"; then :; else',
    `    ${printMarker}; printf '%s\\n' unwritable; exit 0; fi`,
    'fi',
    'chmod 600 "$a"',
    ...authorized.map((key) =>
      `grep -qF -- ${quotePosix(key)} "$a" || printf '%s\\n' ${quotePosix(`${key} infinichat`)} >> "$a"`),
    `${printMarker}; printf '%s\\n' ok`, 'cat "$k.pub"',
  ];
}
