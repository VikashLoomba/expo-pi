import { uuidv7 } from '@earendil-works/pi-ai';
import type { ImageLimits, ImageProcessor, PreparedImage } from '@earendil-works/pi-durable/tools';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { DEFAULT_JPEG_QUALITY } from './model-catalog';

/** Each shrink step while an image is still over the model's byte limit, as pi-durable's Photon processor shrinks. */
const SHRINK = 0.75;

/** A fitted image, with the file it was saved to and its dimensions. */
export interface FittedImage extends PreparedImage {
  uri: string;
  width: number;
  height: number;
}

export interface FitOptions {
  /** JPEG quality in percent; `DEFAULT_JPEG_QUALITY` without one. */
  quality?: number;
  /** The image's original dimensions when the caller knows them, for the `resized` note. */
  original?: { width: number; height: number };
}

/**
 * The image at `uri` fitted to `limits` the way pi-durable's Photon processor fits a file: decoded no larger than
 * the limits, which also turns it upright and reads any format iOS decodes, saved as JPEG, and shrunk by 3/4 while
 * its base64 is still over `maxBytes`. Downsampling happens while decoding, so a full-size photo never sits in
 * memory. Resolves undefined when no size fits, as the processor contract asks.
 */
export async function fitImage(uri: string, mimeType: string, limits: ImageLimits,
  { quality = DEFAULT_JPEG_QUALITY, original }: FitOptions = {}): Promise<FittedImage | undefined> {
  let { maxWidth, maxHeight } = limits;
  for (;;) {
    const rendered = await ImageManipulator.manipulate(uri, { maxWidth, maxHeight }).renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality / 100, base64: true });
    rendered.release();
    if (saved.base64 === undefined) return undefined;
    const to = { width: saved.width, height: saved.height };
    if (saved.base64.length <= limits.maxBytes) {
      const resized = original && (to.width !== original.width || to.height !== original.height);
      return { uri: saved.uri, data: saved.base64, mimeType: 'image/jpeg', ...to,
        ...(mimeType === 'image/jpeg' ? {} : { convertedFrom: mimeType }),
        ...(resized ? { resized: { from: original, to } } : {}) };
    }
    new File(saved.uri).delete();
    maxWidth = Math.floor(to.width * SHRINK);
    maxHeight = Math.floor(to.height * SHRINK);
    if (maxWidth < 1 || maxHeight < 1) return undefined;
  }
}

/**
 * pi-durable's `ImageProcessor` for `createCodingTools({ images })` on expo-image-manipulator: the bytes `read`
 * hands over go to a cache file, which iOS decodes and fits; only the base64 result leaves.
 */
export function createExpoImages(): ImageProcessor {
  return {
    async prepare(bytes, mimeType, limits) {
      // Expo's native bridge identifies a typed array by its constructor name and aborts the app on a subclass such
      // as the remote reader's `Buffer`, so it only ever receives a plain view of the same bytes.
      const plain = bytes.constructor === Uint8Array
        ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const source = new File(Paths.join(Paths.cache, `pi-read-${uuidv7()}.${mimeType.slice('image/'.length)}`));
      await source.write(plain);
      try {
        const fitted = await fitImage(source.uri, mimeType, limits);
        if (!fitted) return undefined;
        new File(fitted.uri).delete();
        const { uri: _uri, width: _width, height: _height, ...prepared } = fitted;
        return prepared;
      } finally {
        source.delete();
      }
    },
  };
}
