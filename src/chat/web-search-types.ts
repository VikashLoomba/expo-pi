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

export interface WebSearchCitation {
  id: string;
  url: string;
  title: string;
  /** UTF-16 offsets into the unmodified aggregate ChatMessage.text. End is exclusive. */
  startIndex: number;
  endIndex: number;
}

export interface WebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchPresentation {
  calls: readonly WebSearchCall[];
  citations: readonly WebSearchCitation[];
  sources: readonly WebSearchSource[];
}
