import { uuidv7 } from '@earendil-works/pi-ai';
import {
  launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync, type ImagePickerAsset,
  type ImagePickerResult,
} from 'expo-image-picker';

import { fitImage } from '../pi/images';
import type { ImageInput } from '../pi/model-catalog';
import type { ChatImage } from '../pi/user-input';

/** A photo fitted to the chat's model: pi-ai's image part, and a file the composer shows while it is a draft. */
export interface PhotoAttachment extends ChatImage {
  id: string;
  uri: string;
}

export type PhotoSource = 'camera' | 'library';

/**
 * Photos the user takes or picks, each fitted to the model's image limits as the `read` tool's processor fits a
 * file. Resolves empty when the user cancels.
 */
export async function pickPhotos(source: PhotoSource, limits: ImageInput): Promise<PhotoAttachment[]> {
  const result = await (source === 'camera' ? takePhoto() : launchImageLibraryAsync({
    mediaTypes: 'images', allowsMultipleSelection: true, orderedSelection: true,
    selectionLimit: limits.maxPerMessage ?? 0,
  }));
  if (result.canceled) return [];
  const photos: PhotoAttachment[] = [];
  for (const asset of result.assets) photos.push(await prepare(asset, limits));
  return photos;
}

async function takePhoto(): Promise<ImagePickerResult> {
  const permission = await requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('Allow camera access for Pi Agent in Settings to take a photo.');
  return launchCameraAsync({ mediaTypes: 'images' });
}

async function prepare(asset: ImagePickerAsset, limits: ImageInput): Promise<PhotoAttachment> {
  const fitted = await fitImage(asset.uri, asset.mimeType ?? 'image/jpeg', limits,
    { quality: limits.jpegQuality, original: { width: asset.width, height: asset.height } });
  if (!fitted) throw new Error('The photo is too large to send to this model.');
  return { id: uuidv7(), uri: fitted.uri, data: fitted.data, mimeType: fitted.mimeType };
}
