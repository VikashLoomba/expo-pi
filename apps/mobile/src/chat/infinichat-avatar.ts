import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import Storage from 'expo-sqlite/kv-store';

const KEY = 'pi.infinichat.avatar.v1';

export type InfiniChatAvatar = ReturnType<typeof createInfiniChatAvatar>;

/**
 * InfiniChat's avatar, an image the user made with Image Playground. Only the phone draws the conversation, so it is
 * a file in the app's documents named in the app's settings (expo-sqlite kv-store), wherever the conversation runs.
 * Each image gets a new name, so expo-image never shows a cached earlier one.
 */
export function createInfiniChatAvatar() {
  const named = (name: string | null) => {
    const file = name === null ? undefined : new File(Paths.document, name);
    return file?.exists ? file.uri : undefined;
  };
  let uri = named(Storage.getItemSync(KEY));
  const listeners = new Set<() => void>();
  const replace = (name: string | null) => {
    const previous = Storage.getItemSync(KEY);
    if (name === null) Storage.removeItemSync(KEY);
    else Storage.setItemSync(KEY, name);
    if (previous !== null) {
      const old = new File(Paths.document, previous);
      if (old.exists) old.delete();
    }
    uri = named(name);
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** The avatar's file URI; undefined for InfiniChat's own mark. */
    getSnapshot: () => uri,
    /** Keeps a copy of the image at `source`, such as Image Playground's temporary file, as the avatar. */
    set(source: string) {
      if (source === uri) return;
      const image = new File(source);
      const file = new File(Paths.document, `infinichat-avatar-${randomUUID()}${image.extension}`);
      image.copySync(file);
      replace(file.name);
    },
    /** Goes back to InfiniChat's own mark. */
    clear() {
      replace(null);
    },
  };
}
