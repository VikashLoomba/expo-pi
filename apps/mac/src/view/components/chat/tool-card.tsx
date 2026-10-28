import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useState } from 'react';

import { Icon } from './icon';
import { MessageImages } from './message-images';

/** A tool call as the phone's `tool-card.tsx` shows it: a header that expands to its input, result and changes. */
export function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const tool = message.tool;
  if (!tool) return null;
  const file = tool.file;
  const label = tool.name.replace(/_/g, ' ');
  const status = tool.status === 'running' ? 'Working' : tool.status === 'error' ? 'Failed' : 'Complete';
  return (
    <div className="card">
      <button type="button" className="card-header" aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}>
        {tool.status === 'running' ? <span className="spinner" />
          : <Icon name={tool.status === 'error' ? 'warning' : 'check'}
            className={tool.status === 'error' ? 'failed' : ''} />}
        <span className="card-identity">
          <span className="card-name">{label}</span>
          {file && <span className="card-path">{file.path}</span>}
        </span>
        <span className={`card-status${tool.status === 'error' ? ' failed' : ''}`}>{status}</span>
        <Icon name={expanded ? 'down' : 'chevron'} size={12} />
      </button>
      {expanded && (
        <div className="card-details">
          {file ? (
            <>
              <pre className="output">{file.path}</pre>
              <span className="card-detail">{file.summary}</span>
            </>
          ) : tool.args ? (
            <>
              <span className="card-label">INPUT</span>
              <pre className="output">{tool.args}</pre>
            </>
          ) : null}
          <span className="card-label">RESULT</span>
          {message.images?.length ? <MessageImages images={message.images} /> : null}
          {(tool.output || !message.images?.length) && (
            <pre className="output">
              {tool.output || (tool.status === 'running' ? 'Waiting for a result…' : 'No text output.')}
            </pre>
          )}
          {file?.diff !== undefined && (
            <>
              <span className="card-label">
                CHANGES{file.firstChangedLine ? ` · LINE ${file.firstChangedLine}` : ''}
              </span>
              <pre className="output">{file.diff}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
