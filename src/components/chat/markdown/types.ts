/** UTF-16 offsets in visible text and the original, unmodified message. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  /** Present for a decoded escape/entity whose source and display lengths differ. */
  readonly sourceEnd?: number;
}

export interface MappedText {
  readonly text: string;
  readonly sourceSpans: readonly SourceSpan[];
}

export type InlineMark = 'strong' | 'emphasis' | 'code' | 'delete';

/** A leaf run can carry several marks, e.g. a bold, italic link label. */
export interface InlineRun extends MappedText {
  readonly key: number;
  readonly marks: readonly InlineMark[];
  /** null is a visible link label whose target is still streaming. */
  readonly href?: string | null;
}

/** Reused unchanged by prose, headings, list paragraphs, and table cells. */
export interface InlineFragment {
  readonly key: number;
  readonly sourceText: string;
  readonly runs: readonly InlineRun[];
}

export interface ListItem {
  readonly key: number;
  readonly checked: boolean | null;
  readonly blocks: readonly MarkdownBlock[];
}

export interface TableRow {
  readonly key: number;
  readonly cells: readonly InlineFragment[];
}

export type ColumnAlignment = 'left' | 'right' | 'center' | null;

export type MarkdownBlock =
  | { readonly kind: 'paragraph'; readonly key: number; readonly content: InlineFragment }
  | { readonly kind: 'heading'; readonly key: number; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly content: InlineFragment }
  | { readonly kind: 'code'; readonly key: number; readonly text: string; readonly language: string }
  | { readonly kind: 'list'; readonly key: number; readonly ordered: boolean; readonly start: number; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly key: number; readonly blocks: readonly MarkdownBlock[] }
  | { readonly kind: 'rule'; readonly key: number }
  | { readonly kind: 'table'; readonly key: number; readonly alignments: readonly ColumnAlignment[]; readonly header: TableRow; readonly rows: readonly TableRow[] };

export function assertNever(value: never): never {
  throw new Error(`Unhandled Markdown variant: ${JSON.stringify(value)}`);
}
