#!/usr/bin/env python3
"""Render the guide's implementation listings directly from the checked-in sources."""
from pathlib import Path
import re
import sys
ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
MODULES = {
 '01-architecture.md': ['src/index.mts'],
 '02-memory-tree-views.md': ['src/memory.mts'],
 '03-summary-tasks.md': ['src/summary.mts'],
 '04-turns-and-coordinator.md': ['src/prompt.mts', 'src/app.mts'],
 '05-tools-and-recall.md': ['src/tools.mts'],
 '06-background-agents.md': ['src/agents.mts'],
 '08-host-and-lifecycle.md': ['src/node.mts', 'examples/demo.mts', 'examples/anthropic-node.mts'],
}
START = '<!-- implementation:start -->'
END = '<!-- implementation:end -->'

def main():
    check = '--check' in sys.argv
    stale = []
    sources = {name: (ROOT / name).read_text() for names in MODULES.values() for name in names}
    for filename, names in MODULES.items():
        path = DOCS / filename
        text = path.read_text()
        if text.count(START) != 1 or text.count(END) != 1:
            raise SystemExit(f'Expected exactly one implementation region in {filename}')
        listing = '\n\n'.join(f'### `{name}`\n\n[Complete source](../{name})\n\n```typescript\n{sources[name].rstrip()}\n```' for name in names)
        text = re.sub(re.escape(START) + r'.*?' + re.escape(END), lambda _: START + '\n\n' + listing + '\n\n' + END, text, flags=re.S)
        if check:
            if path.read_text() != text: stale.append(filename)
        else:
            path.write_text(text)
    if stale:
        raise SystemExit('Stale implementation listings: ' + ', '.join(stale))
    print(f'Rendered {len(sources)} complete source modules in {len(MODULES)} linked topic files.')
if __name__ == '__main__': main()
