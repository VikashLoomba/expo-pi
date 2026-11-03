import { num, obj, oneOf, opt, str, type Static } from '@earendil-works/pi-schema';

/** Small, validated UI state from tool arguments and durable result details (`pi/file-tool-presentation.ts`). */
export const FileToolPresentationSchema = obj({
  kind: oneOf(['read', 'write', 'edit']),
  path: str(),
  summary: str(),
  diff: opt(str()),
  firstChangedLine: opt(num()),
}, { open: true });
export type FileToolPresentation = Static<typeof FileToolPresentationSchema>;
