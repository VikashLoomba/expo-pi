import { uuidv7 } from '@earendil-works/pi-ai';
import { useCallback, useRef, useState } from 'react';

import type { Attachment } from '../../contract';
import { errorText } from './use-ref';

/** A draft keeps one request ID for every attempt to send it, so a resend after a failure is admitted once. */
export type Draft = { text: string; images: readonly Attachment[]; requestId: string };
const emptyDraft = (): Draft => ({ text: '', images: [], requestId: uuidv7() });

/** What fits photos to the shown model in the main process: `MacInfiniChat` and `MacChat` both do. */
export interface PhotoSource {
  pickPhotos(): Promise<Attachment[]>;
  attach(input: { name: string; mimeType: string; data: string }): Promise<Attachment>;
}

/** A file's bytes as base64, for the main process to fit. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * The composer's draft as the phone's chat screens keep it: text and photos with one request ID per attempt, the
 * photos fitted by the main process from the open dialog or from files dropped or pasted. The screen owns sending
 * and clears the draft with `reset` once a send is admitted; `localError` is the screen's own notice.
 */
export function useDraft(photos: PhotoSource) {
  const [draft, setDraft] = useState(emptyDraft);
  const [attaching, setAttaching] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const changeDraft = useCallback((text: string) => {
    setDraft((current) => current.text === text ? current : { ...current, text, requestId: uuidv7() });
  }, []);
  const removeImage = useCallback((id: string) => {
    setDraft((current) => ({ ...current, images: current.images.filter((image) => image.id !== id),
      requestId: uuidv7() }));
  }, []);
  const choosePrompt = useCallback((text: string) => {
    changeDraft(text);
    input.current?.focus();
  }, [changeDraft]);
  const attachWith = useCallback(async (work: () => Promise<readonly Attachment[]>) => {
    setAttaching(true);
    setLocalError(undefined);
    try {
      const images = await work();
      if (images.length) {
        setDraft((current) => ({ ...current, images: [...current.images, ...images], requestId: uuidv7() }));
      }
    } catch (cause) {
      setLocalError(errorText(cause, 'The photo could not be attached. Try again.'));
    } finally {
      setAttaching(false);
    }
  }, []);
  const attach = useCallback(() => { void attachWith(() => photos.pickPhotos()); }, [attachWith, photos]);
  const attachFiles = useCallback((files: readonly File[]) => {
    void attachWith(async () => {
      const fitted: Attachment[] = [];
      for (const file of files) {
        fitted.push(await photos.attach({ name: file.name, mimeType: file.type, data: await base64Of(file) }));
      }
      return fitted;
    });
  }, [attachWith, photos]);
  const reset = useCallback(() => setDraft(emptyDraft()), []);
  return { draft, changeDraft, removeImage, choosePrompt, attach, attachFiles, attaching, localError, setLocalError,
    reset, input };
}
