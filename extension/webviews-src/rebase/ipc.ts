// Typed postMessage protocol between the extension host and the interactive
// rebase editor webview. RebaseEntry is imported type-only so the browser
// bundle carries no runtime code from the protocol package.

import type { RebaseEntry } from '@gitglasses/protocol';

export type { RebaseEntry };

export type HostToWebviewMessage =
  | { type: 'init'; upstream: string; entries: { sha: string; summary: string }[] }
  | { type: 'busy'; busy: boolean };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'start'; plan: RebaseEntry[] }
  | { type: 'cancel' };
