import { useMemo, type ComponentProps } from 'react';
import { Streamdown, type Components } from 'streamdown';

import { useOpenExternal } from '../../lib/app-context';

/**
 * A message's Markdown through streamdown, the web counterpart of the phone's react-native-enriched-markdown and
 * react-native-streamdown: unfinished Markdown is repaired while it streams, the HTML sanitized. Links open in the
 * default browser through the main process, so the page never navigates.
 */
export function MessageContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const openExternal = useOpenExternal();
  const components = useMemo((): Components => ({
    a: ({ href, children, node: _node, ...rest }: ComponentProps<'a'> & { node?: unknown }) => (
      <a {...rest} href={href} onClick={(event) => {
        event.preventDefault();
        if (href) openExternal(href);
      }}>
        {children}
      </a>
    ),
  }), [openExternal]);
  return (
    <Streamdown className="markdown" animated isAnimating={streaming} mode={streaming ? 'streaming' : 'static'}
      components={components} linkSafety={{ enabled: false }}>
      {text}
    </Streamdown>
  );
}
