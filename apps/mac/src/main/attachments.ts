import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { uuidv7 } from '@earendil-works/pi-ai';
import type { ImageProcessor } from '@earendil-works/pi-durable/tools';
import type { ImageInput } from '@pi-agent/infinichat/pi/model-catalog';
import { Utils } from 'electrobun/main';

import type { Attachment } from '../contract';

/** pi-durable's processor contract: `undefined` is an image it can't decode or make fit (`image-processor.ts`). */
const UNFIT = 'The photo could not be read or made small enough to send to this model.';
/** What the Photon processor decodes: not HEIC, which macOS's Photos exports by default (pi-durable `src/images`). */
const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * Photos for the composer, fitted to the model's limits with the chat tools' processor, as the phone's
 * `photo-attachments.ts` fits them with its own: the composer then sends pi-ai's image part as it is.
 */
export class Attachments {
  constructor(private readonly images: ImageProcessor) {}

  async fit(bytes: Uint8Array, mimeType: string, limits: ImageInput): Promise<Attachment> {
    const prepared = await this.images.prepare(bytes, mimeType, limits);
    if (prepared === undefined) throw new Error(UNFIT);
    return { id: uuidv7(), data: prepared.data, mimeType: prepared.mimeType };
  }

  /** The photos chosen in the open dialog, fitted; none when the user cancels. */
  async pick(limits: ImageInput): Promise<Attachment[]> {
    const paths = await Utils.openFileDialog({
      allowedFileTypes: Object.keys(TYPES).map((extension) => extension.slice(1)).join(','),
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: true,
    });
    const chosen = limits.maxPerMessage === undefined ? paths : paths.slice(0, limits.maxPerMessage);
    const photos: Attachment[] = [];
    for (const path of chosen) {
      const mimeType = TYPES[extname(path).toLowerCase()];
      if (mimeType === undefined) throw new Error(`${path} is not a photo this model can take.`);
      photos.push(await this.fit(await readFile(path), mimeType, limits));
    }
    return photos;
  }
}
