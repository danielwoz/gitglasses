// Typed postMessage protocol between the extension host and the Line Story
// panel. Types are imported type-only, so the browser bundle carries no
// runtime code from the protocol or integrations packages.

import type { CommitDetails } from '@gitglasses/protocol';
import type { LineStory } from '@gitglasses/integrations';
import type { DetailsToHostMessage } from '../graph/ipc';

export type { CommitDetails, LineStory };

/** What the panel keeps across reloads, and its serializer restores. */
export interface LineStoryPanelState {
  uri: string;
  line: number;
}

/** A story as the panel shows it. */
export interface LineStoryView {
  story: LineStory<CommitDetails>;
  /** The file as the user knows it, e.g. "src/parser.ts". */
  file: string;
}

export type HostToLineStoryMessage =
  | { type: 'loading'; state: LineStoryPanelState; file: string }
  /** The story so far; sent again as each part arrives. */
  | { type: 'story'; view: LineStoryView; state: LineStoryPanelState }
  /** No story can be told, e.g. the file has no blame. */
  | { type: 'error'; message: string; state: LineStoryPanelState };

/** One earlier version's change to the file, for a diff editor. */
export interface VersionTarget {
  sha: string;
  path: string;
  /** The file's path before the change; absent when the change added it. */
  previousPath?: string;
}

export type LineStoryToHostMessage =
  | DetailsToHostMessage
  | { type: 'ready' }
  | { type: 'refresh' }
  /** Reveal the line in its editor. */
  | { type: 'openLine' }
  | { type: 'openUrl'; url: string }
  /** Connect the forge the story names. */
  | { type: 'connect' }
  | { type: 'manageTrust' }
  /** Compare the line's uncommitted change with HEAD. */
  | { type: 'openWorkingChanges' }
  | { type: 'openVersion'; target: VersionTarget };
