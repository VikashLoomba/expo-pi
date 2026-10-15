# OptChat with pi-durable 1.2.0

A linked implementation guide and source package for one ongoing OptChat conversation, using native pi-durable documents, tasks, conversations and extension APIs. The behavioral source is [Victor Taelin’s OptChat / UniiChat guide](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

## Guide

1. [Architecture and implementation contract](docs/01-architecture.md)
2. [Canonical memory, binary tree and saved views](docs/02-memory-tree-views.md)
3. [Native summary tasks and queue admission](docs/03-summary-tasks.md)
4. [Prompt, input admission and native coordinator](docs/04-turns-and-coordinator.md)
5. [Native tools, bounded output and recall](docs/05-tools-and-recall.md)
6. [Requested background agents and permanent reports](docs/06-background-agents.md)
7. [Provider caching](docs/07-provider-cache.md)
8. [Portable host and native lifecycle](docs/08-host-and-lifecycle.md)
9. [Behavior-derived validation](docs/09-validation.md)
10. [Pinned implementation references](docs/10-references.md)

Read the architecture first, then the topic files in order. Complete implementation listings appear with their explanations and link to the corresponding source files. The source files, not separately edited pseudocode, generate the listings. Host-specific credentials, platform tools and storage adapters stay at the portable integration boundary.

## Source and validation

- [Source modules](src/)
- [Tests](test/)
- [Offline native-runtime demo](examples/demo.mts)
- [Opt-in Anthropic host](examples/anthropic-node.mts)
- [Package commands](package.json)
- [Listing generator](scripts/build-docs.py)

Regenerate code listings after source edits with `python3 scripts/build-docs.py`. Check listings without rewriting them with `python3 scripts/build-docs.py --check`. The complete test suite and included persistent host require Linux, Node.js 22.19 or newer, and the `flock` utility; validation uses Node.js 24.19. The portable core is separate from this host. Run `npm ci`, `npm run typecheck`, and `npm test` from the package root. This package does not modify the Expo application or migrate an existing chat database.

## Run the offline demo

Use Node 22.19 or newer. After installing dependencies, `npm run demo` builds and runs the complete assembly with scripted model responses through the real native Harness. It does not call a paid provider. The Anthropic host is separately opt-in and requires model selection and credentials in the process environment; see [host setup](docs/08-host-and-lifecycle.md).
