/** Presentation-only metadata. Native response items and encrypted state stay out of the UI. */
export interface WebSearchCall {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  action: 'search' | 'open_page' | 'find_in_page';
  queries?: readonly string[];
  url?: string;
  pattern?: string;
  error?: string;
}

export interface WebSearchSource {
  url: string;
  title?: string;
  /** The answer's Markdown links cite this page. */
  cited?: boolean;
}

/**
 * Search activity and sources of one assistant response. Citations are already Markdown links in the answer
 * text, so there is nothing to decorate: sources are the union of the calls' results and the cited URLs,
 * cited first, a citation matching its result ignoring the `utm_source=openai` parameter.
 */
export interface WebSearchPresentation {
  calls: readonly WebSearchCall[];
  sources: readonly WebSearchSource[];
}
