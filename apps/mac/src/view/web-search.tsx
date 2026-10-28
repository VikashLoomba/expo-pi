import type { WebSearchCall } from '@pi-agent/infinichat/chat/web-search-types';
import {
  safeSourceUrl, searchCallLabel, sourceHost, type SearchSource,
} from '@pi-agent/infinichat/chat/web-search-presentation';
import { useState } from 'react';

import { useOpenExternal } from './app-context';
import { Icon } from './icon';

function SearchCall({ call }: { call: WebSearchCall }) {
  const openExternal = useOpenExternal();
  const running = call.status === 'running';
  const failed = call.status === 'failed';
  const interrupted = call.status === 'interrupted';
  const url = call.url && safeSourceUrl(call.url);
  return (
    <div className="search-call">
      {running ? <span className="spinner" />
        : <Icon name={failed ? 'warning' : interrupted ? 'stop' : 'check'} size={14}
          className={failed ? 'failed' : ''} />}
      <div className="search-call-content">
        <span className={`card-detail${failed ? ' failed' : ''}`}>{searchCallLabel(call)}</span>
        {call.queries?.map((query, index) => <span key={`${index}:${query}`} className="search-query">{query}</span>)}
        {call.pattern && <span className="search-query">“{call.pattern}”</span>}
        {url && (
          <button type="button" className="link-button" onClick={() => openExternal(url)}>{sourceHost(url)}</button>
        )}
        {running && !call.queries?.length && !call.pattern && !url
          && <span className="card-detail">Preparing search…</span>}
        {call.error && <span className="card-detail failed">{call.error}</span>}
      </div>
    </div>
  );
}

/** Search activity lives with its assistant response, as on the phone (`web-search.tsx`). */
export function WebSearchActivity({ calls }: { calls: readonly WebSearchCall[] }) {
  const [expanded, setExpanded] = useState<boolean | undefined>(undefined);
  const active = calls.filter((call) => call.status === 'running').at(-1);
  const failed = calls.some((call) => call.status === 'failed');
  const interrupted = calls.some((call) => call.status === 'interrupted');
  const open = expanded ?? !!active;
  if (!calls.length) return null;
  const label = active ? searchCallLabel(active)
    : failed ? 'Web search failed' : interrupted ? 'Search interrupted' : 'Searched the web';
  const detail = active?.queries?.at(-1) ?? (active?.url ? sourceHost(active.url) : undefined);
  return (
    <div className="card">
      <button type="button" className="card-header" aria-expanded={open} onClick={() => setExpanded(!open)}>
        {active ? <span className="spinner" />
          : <Icon name={failed ? 'warning' : interrupted ? 'stop' : 'search'} className={failed ? 'failed' : ''} />}
        <span className="card-identity">
          <span className={`card-name${failed && !active ? ' failed' : ''}`}>{label}</span>
          {!open && detail && <span className="card-detail">{detail}</span>}
        </span>
        {calls.length > 1 && <span className="card-status">{calls.length}</span>}
        <Icon name={open ? 'down' : 'chevron'} size={12} />
      </button>
      {open && <div className="card-details">{calls.map((call) => <SearchCall key={call.id} call={call} />)}</div>}
    </div>
  );
}

export function WebSearchSources({ sources }: { sources: readonly SearchSource[] }) {
  const openExternal = useOpenExternal();
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;
  const hosts = [...new Set(sources.map((source) => source.host))].slice(0, 3).join(' · ');
  return (
    <div className="card">
      <button type="button" className="card-header" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Icon name="search" />
        <span className="card-identity">
          <span className="card-name">Sources · {sources.length}</span>
          {!expanded && <span className="card-detail">{hosts}</span>}
        </span>
        <Icon name={expanded ? 'down' : 'chevron'} size={12} />
      </button>
      {expanded && (
        <div className="card-details" style={{ padding: '4px 0' }}>
          {sources.map((source) => (
            <button key={source.url} type="button" className="source-row" onClick={() => openExternal(source.url)}>
              <span className="source-number">{source.number}</span>
              <span className="card-identity">
                <span>{source.title}</span>
                <span className="card-detail">{source.host}{source.cited ? ' · Cited' : ''}</span>
              </span>
              <Icon name="chevron" size={10} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
