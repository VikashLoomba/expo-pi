import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { workspaceDirectoryName, type ByteReader, type Entry, type WorkspaceStorage, type Workspaces } from './storage';

/** One directory of a workspace, accessed through expo-file-system's `File`, `Directory` and `FileHandle`. */
class DeviceWorkspaceStorage implements WorkspaceStorage {
  constructor(private readonly root: Directory) {}

  /** The URI of a workspace path; segments are percent-encoded by `Paths.join`. */
  #uri(path: string): string {
    return path === '/' ? this.root.uri : Paths.join(this.root, path);
  }

  async info(path: string): Promise<Entry | undefined> {
    const uri = this.#uri(path);
    const found = Paths.info(uri);
    if (!found.exists) return undefined;
    // `Paths.info` reports no modification time, and a directory's own info would walk its whole subtree.
    if (found.isDirectory) return { kind: 'directory', size: 0, mtimeMs: 0 };
    const info = new File(uri).info();
    return { kind: 'file', size: info.size ?? 0, mtimeMs: info.modificationTime ?? 0 };
  }

  async list(path: string): Promise<string[]> {
    return new Directory(this.#uri(path)).list().map((entry) => entry.name);
  }

  read(path: string): Promise<Uint8Array> {
    return new File(this.#uri(path)).bytes();
  }

  async open(path: string): Promise<ByteReader> {
    const handle = new File(this.#uri(path)).open(FileMode.ReadOnly);
    return {
      size: async () => handle.size ?? 0,
      // Seeking and reading synchronously keeps concurrent reads of one handle from moving each other's offset.
      read: async (offset, length) => {
        handle.offset = offset;
        return handle.readBytesSync(length);
      },
      close: async () => handle.close(),
    };
  }

  write(path: string, bytes: Uint8Array, append: boolean): Promise<void> {
    // Expo's native bridge identifies a typed array by its constructor name and aborts the app on a subclass such as
    // the shell's `Buffer`, so it only ever receives a plain view of the same bytes.
    const plain = bytes.constructor === Uint8Array
      ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new File(this.#uri(path)).write(plain, { append });
  }

  async createDirectory(path: string): Promise<void> {
    new Directory(this.#uri(path)).create();
  }

  async remove(path: string): Promise<void> {
    const uri = this.#uri(path);
    if (Paths.info(uri).isDirectory) new Directory(uri).delete();
    else new File(uri).delete();
  }

  async move(source: string, destination: string): Promise<void> {
    const from = this.#uri(source);
    const to = this.#uri(destination);
    // A directory's destination does not exist, so it is renamed rather than moved into it.
    if (Paths.info(from).isDirectory) await new Directory(from).move(new Directory(to));
    else await new File(from).move(new File(to), { overwrite: true });
  }

  copyFile(source: string, destination: string): Promise<void> {
    return new File(this.#uri(source)).copy(new File(this.#uri(destination)), { overwrite: true });
  }
}

/**
 * Workspaces live in the app's document directory, one directory per workspace, and their temporary files in the
 * cache directory, where the system may purge them.
 */
export function createDeviceWorkspaces(directoryName = 'workspaces'): Workspaces {
  const root = new Directory(Paths.document, directoryName);
  const tempRoot = new Directory(Paths.cache, directoryName);
  return {
    workspace: (id) => {
      const name = workspaceDirectoryName(id);
      const files = new Directory(root, name);
      files.create({ intermediates: true, idempotent: true });
      // Created again for every environment, because a purge may have removed it since the last one.
      const temp = new Directory(tempRoot, name);
      temp.create({ intermediates: true, idempotent: true });
      return { files: new DeviceWorkspaceStorage(files), temp: new DeviceWorkspaceStorage(temp) };
    },
  };
}
