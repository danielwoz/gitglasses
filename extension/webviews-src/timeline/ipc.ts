// Typed postMessage protocol between the extension host and the timeline
// webview. FileHistoryEntry is imported type-only so the browser bundle
// carries no runtime code from the protocol package.

import type { FileHistoryEntry } from '@gitglasses/protocol';

export type { FileHistoryEntry };

export type HostToWebviewMessage =
  | { type: 'reset'; path: string }
  | { type: 'entries'; entries: FileHistoryEntry[]; nextCursor?: string }
  | { type: 'theme' };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'loadMore'; cursor: string }
  | { type: 'openDiff'; sha: string };
