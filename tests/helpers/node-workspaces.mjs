import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The app's `WorkspaceStorage` contract over node:fs, so Node tests exercise real directories. */
class NodeWorkspaceStorage {
  #ready;

  constructor(root) {
    this.root = root;
  }

  async #path(path) {
    this.#ready ??= mkdir(this.root, { recursive: true });
    await this.#ready;
    return join(this.root, path);
  }

  async info(path) {
    try {
      const stats = await lstat(await this.#path(path));
      return stats.isDirectory()
        ? { kind: 'directory', size: 0, mtimeMs: stats.mtimeMs }
        : { kind: 'file', size: stats.size, mtimeMs: stats.mtimeMs };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  async list(path) { return readdir(await this.#path(path)); }

  async read(path) { return new Uint8Array(await readFile(await this.#path(path))); }

  async open(path) {
    const handle = await open(await this.#path(path), 'r');
    return {
      size: async () => (await handle.stat()).size,
      read: async (offset, length) => {
        const bytes = new Uint8Array(length);
        const { bytesRead } = await handle.read(bytes, 0, length, offset);
        return bytes.subarray(0, bytesRead);
      },
      close: () => handle.close(),
    };
  }

  async write(path, bytes, append) {
    const target = await this.#path(path);
    if (append) await appendFile(target, bytes);
    else await writeFile(target, bytes);
  }

  async createDirectory(path) { await mkdir(await this.#path(path)); }

  async remove(path) { await rm(await this.#path(path), { recursive: true }); }

  async move(source, destination) { await rename(await this.#path(source), await this.#path(destination)); }

  async copyFile(source, destination) { await copyFile(await this.#path(source), await this.#path(destination)); }
}

export function nodeWorkspaces(directory) {
  return {
    workspace: (id) => new NodeWorkspaceStorage(join(directory, id)),
  };
}
