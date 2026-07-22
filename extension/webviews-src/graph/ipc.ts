// Typed postMessage protocol between the extension host and the graph
// webview. GraphRow is imported type-only so the browser bundle carries no
// runtime code from the protocol package.

import type { GraphRef, GraphRow } from '@gitglasses/protocol';

export type { GraphRef, GraphRow };

export type HostToWebviewMessage =
  | { type: 'reset' }
  | { type: 'rows'; rows: GraphRow[]; nextCursor?: string }
  | { type: 'theme' };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'select'; shas: string[] }
  | { type: 'openCommit'; sha: string }
  | { type: 'copySha'; sha: string };
