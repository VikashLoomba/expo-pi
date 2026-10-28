const PATHS = {
  check: 'M4 12.5l5 5L20 7',
  warning: 'M12 3l10 18H2L12 3zm0 7v4m0 3v.5',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16l-4.5-4.5',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  spark: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  arrowDown: 'M12 5v14m-7-7l7 7 7-7',
  send: 'M12 19V5m-7 7l7-7 7 7',
  idea: 'M9 18h6m-5 3h4m-2-18a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3z',
  pencil: 'M4 20l4-1 11-11-3-3L5 16l-1 4z',
  number: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
} as const;
export type IconName = keyof typeof PATHS;

/** The transcript's small glyphs, drawn inline in place of the phone's SF Symbols. */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
