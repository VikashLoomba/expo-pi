import { uuidv7 } from '@earendil-works/pi-ai';
import type { ImageLimits, ImageProcessor, PreparedImage } from '@earendil-works/pi-durable/tools';
import { DEFAULT_JPEG_QUALITY } from '@pi-agent/infinichat/pi/model-catalog';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { exifOrientation } from './exif';

/** Each shrink step while an image is still over the model's byte limit, as pi-durable's Photon processor shrinks. */
const SHRINK = 0.75;
/** Formats every provider takes inline (pi-durable `src/tools/image-processor.ts`, `INLINE_IMAGE_TYPES`). */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PHOTOS = new Set(['image/jpeg', 'image/heic', 'image/heif']);

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
 * The image at `uri` as it is, when it is upright, of a format providers take inline and within `limits`, once it
 * decodes, as pi-durable's Photon processor returns one (`src/images/index.ts`); `uri` is then the source's own.
 * Decoded no larger than one pixel past the limits, an image that fits decodes whole, so its size is its own.
 */
async function asItIs(uri: string, mimeType: string, limits: ImageLimits): Promise<FittedImage | undefined> {
  if (!INLINE.has(mimeType)) return undefined;
  const file = new File(uri);
  // Photon reads the orientation of JPEG and WebP files only.
  if ((mimeType === 'image/jpeg' || mimeType === 'image/webp') && exifOrientation(await file.bytes()) !== 1) {
    return undefined;
  }
  const data = await file.base64();
  if (data.length > limits.maxBytes) return undefined;
  const decoded = await ImageManipulator.manipulate(uri,
    { maxWidth: limits.maxWidth + 1, maxHeight: limits.maxHeight + 1 }).renderAsync();
  const { width, height } = decoded;
  decoded.release();
  return width <= limits.maxWidth && height <= limits.maxHeight ? { uri, data, mimeType, width, height } : undefined;
}

/**
 * The image at `uri` fitted to `limits` the way pi-durable's Photon processor fits a file: as it is when it already
 * fits (`asItIs`); otherwise decoded no larger than the limits, which also turns it upright and reads any format iOS
 * decodes, saved as PNG, then JPEG, JPEG first for a photo, and shrunk by 3/4 while its base64 is still over
 * `maxBytes`. Downsampling happens while decoding, so a full-size photo never sits in memory. Resolves undefined when
 * no size fits, as the processor contract asks.
 */
export async function fitImage(uri: string, mimeType: string, limits: ImageLimits,
  { quality = DEFAULT_JPEG_QUALITY, original }: FitOptions = {}): Promise<FittedImage | undefined> {
  const kept = await asItIs(uri, mimeType, limits);
  if (kept) return kept;
  // Photon tries JPEG first for a JPEG; an iPhone's HEIC photo, which Photon can't read, is a photo too.
  const formats = PHOTOS.has(mimeType) ? [SaveFormat.JPEG, SaveFormat.PNG] : [SaveFormat.PNG, SaveFormat.JPEG];
  let { maxWidth, maxHeight } = limits;
  for (;;) {
    const rendered = await ImageManipulator.manipulate(uri, { maxWidth, maxHeight }).renderAsync();
    const size = { width: rendered.width, height: rendered.height };
    try {
      for (const format of formats) {
        const saved = await rendered.saveAsync({ format, compress: quality / 100, base64: true });
        if (saved.base64 === undefined) return undefined;
        if (saved.base64.length <= limits.maxBytes) {
          const fitted = format === SaveFormat.PNG ? 'image/png' : 'image/jpeg';
          const to = { width: saved.width, height: saved.height };
          const resized = original && (to.width !== original.width || to.height !== original.height);
          return { uri: saved.uri, data: saved.base64, mimeType: fitted, ...to,
            ...(fitted === mimeType ? {} : { convertedFrom: mimeType }),
            ...(resized ? { resized: { from: original, to } } : {}) };
        }
        new File(saved.uri).delete();
      }
    } finally {
      rendered.release();
    }
    maxWidth = Math.floor(size.width * SHRINK);
    maxHeight = Math.floor(size.height * SHRINK);
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
        // An image that fits as it is is the source file itself, which the `finally` removes.
        if (fitted.uri !== source.uri) new File(fitted.uri).delete();
        const { uri: _uri, width: _width, height: _height, ...prepared } = fitted;
        return prepared;
      } finally {
        source.delete();
      }
    },
  };
}
