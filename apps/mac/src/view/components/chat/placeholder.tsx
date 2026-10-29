import type { ReactNode } from 'react';

/** A line in place of the thread: opening, unavailable, or held on another machine. */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex flex-1 items-center justify-center text-[15px] text-muted-foreground">{children}</p>
  );
}
