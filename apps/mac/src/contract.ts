import { hostNamed, remote } from '@earendil-works/chord';
import { Type, type Static } from '@earendil-works/pi-ai';

/** Who acts on the main process's objects: a window, or the main process's own code. */
export type MacPrincipal = { kind: 'owner' } | { kind: 'host' };
export const principalKey = (principal: MacPrincipal) => principal.kind;

/** What the app is: its version and where it keeps its data, for the sidebar's footer. */
export const AboutSchema = Type.Object({ version: Type.String(), userData: Type.String() });
export type About = Static<typeof AboutSchema>;

/**
 * The Mac app as its main process serves it to its windows. Every window acts as the owner, so all of them share one
 * object. Later pieces add InfiniChat, the chats, the account and the machines as objects of their own.
 */
export const MacApp = remote('infinichat.mac', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: { owner: { state: { about: AboutSchema } } },
});
