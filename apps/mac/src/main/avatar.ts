import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';

import { Utils } from 'electrobun/main';

import { writeSettings, type Settings } from './settings';

const FOLDER = 'avatar';
/** The image files the open dialog offers: the ones WKWebView draws. */
const IMAGE_TYPES = 'png,jpg,jpeg,gif,webp';

/**
 * InfiniChat's avatar on this Mac, the counterpart of the phone's `infinichat-avatar.ts`: only this app draws the
 * conversation here, so it is a file under the app's user data named in `settings.json`, wherever the conversation
 * runs, which the window loads as `appdata://avatar/<file>`. Each image gets a new name, so the page never shows a
 * cached earlier one.
 */
export class MacAvatar {
  private readonly listeners = new Set<() => void>();
  private readonly folder = join(Utils.paths.userData, FOLDER);

  constructor(private readonly settings: Settings) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The avatar's URL for the page; undefined for InfiniChat's own mark. */
  readonly getSnapshot = (): string | undefined => {
    const name = this.settings.avatar;
    return name !== undefined && existsSync(join(this.folder, name)) ? `appdata://${FOLDER}/${name}` : undefined;
  };

  /** Keeps a copy of the image chosen in the open dialog as the avatar; null when the user cancels. */
  async choose(): Promise<string | null> {
    const [source] = await Utils.openFileDialog({
      startingFolder: Utils.paths.pictures, allowedFileTypes: IMAGE_TYPES, canChooseFiles: true,
      canChooseDirectory: false, allowsMultipleSelection: false,
    });
    if (source === undefined) return null;
    const name = `${randomUUID()}${extname(source).toLowerCase()}`;
    mkdirSync(this.folder, { recursive: true });
    copyFileSync(source, join(this.folder, name));
    this.replace(name);
    return this.getSnapshot() ?? null;
  }

  /** Goes back to InfiniChat's own mark. */
  clear(): void {
    this.replace(undefined);
  }

  private replace(name: string | undefined): void {
    const previous = this.settings.avatar;
    this.settings.avatar = name;
    writeSettings(this.settings);
    if (previous !== undefined && previous !== name) rmSync(join(this.folder, previous), { force: true });
    for (const listener of [...this.listeners]) listener();
  }
}
