import { arr, bool, obj, oneOf, opt, str, type Static } from '@earendil-works/pi-schema';

/** Presentation-only metadata. Native response items and encrypted state stay out of the UI. */
const WebSearchCallSchema = obj({
  id: str(),
  status: oneOf(['running', 'completed', 'failed', 'interrupted']),
  action: oneOf(['search', 'open_page', 'find_in_page']),
  queries: opt(arr(str())),
  url: opt(str()),
  pattern: opt(str()),
  error: opt(str()),
}, { open: true });
export type WebSearchCall = Static<typeof WebSearchCallSchema>;

const WebSearchSourceSchema = obj({
  url: str(),
  title: opt(str()),
  /** The answer's Markdown links cite this page. */
  cited: opt(bool()),
}, { open: true });
export type WebSearchSource = Static<typeof WebSearchSourceSchema>;

/**
 * Search activity and sources of one assistant response. Citations are already Markdown links in the answer
 * text, so there is nothing to decorate: sources are the union of the calls' results and the cited URLs,
 * cited first, a citation matching its result ignoring the `utm_source=openai` parameter.
 */
export const WebSearchPresentationSchema = obj({
  calls: arr(WebSearchCallSchema),
  sources: arr(WebSearchSourceSchema),
}, { open: true });
export type WebSearchPresentation = Static<typeof WebSearchPresentationSchema>;
