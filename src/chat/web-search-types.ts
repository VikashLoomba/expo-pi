import { Type, type Static } from '@earendil-works/pi-ai';

/** Presentation-only metadata. Native response items and encrypted state stay out of the UI. */
const WebSearchCallSchema = Type.Object({
  id: Type.String(),
  status: Type.Enum(['running', 'completed', 'failed', 'interrupted']),
  action: Type.Enum(['search', 'open_page', 'find_in_page']),
  queries: Type.Optional(Type.ReadonlyObject(Type.Array(Type.String()))),
  url: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type WebSearchCall = Static<typeof WebSearchCallSchema>;

const WebSearchSourceSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.String()),
  /** The answer's Markdown links cite this page. */
  cited: Type.Optional(Type.Boolean()),
});
export type WebSearchSource = Static<typeof WebSearchSourceSchema>;

/**
 * Search activity and sources of one assistant response. Citations are already Markdown links in the answer
 * text, so there is nothing to decorate: sources are the union of the calls' results and the cited URLs,
 * cited first, a citation matching its result ignoring the `utm_source=openai` parameter.
 */
export const WebSearchPresentationSchema = Type.Object({
  calls: Type.ReadonlyObject(Type.Array(WebSearchCallSchema)),
  sources: Type.ReadonlyObject(Type.Array(WebSearchSourceSchema)),
});
export type WebSearchPresentation = Static<typeof WebSearchPresentationSchema>;
