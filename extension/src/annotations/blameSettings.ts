// The blame settings, read through a getter so the parsing stays pure and
// unit-testable. Every key is under the `gitglasses.` section.

import type { BlameOptions } from '@gitglasses/protocol';
import {
  BlameTextSettings,
  DEFAULT_INLINE_FORMAT,
  DEFAULT_STATUS_BAR_FORMAT,
  parseDateStyle,
  parseFormat,
} from './blameFormat';

/** When GitGlasses shows its status bar blame. */
export type StatusBarMode = 'auto' | 'show' | 'hide';

export interface BlameSettings {
  currentLineEnabled: boolean;
  statusBar: StatusBarMode;
  hoversEnabled: boolean;
  text: BlameTextSettings;
  options: BlameOptions;
}

/** Settings whose change alters what blame says, not just how it looks. */
export const ATTRIBUTION_SETTINGS = [
  'gitglasses.blame.ignoreWhitespace',
  'gitglasses.blame.detectMovedLines',
  'gitglasses.blame.useIgnoreRevsFile',
];

/** Every setting BlameSettings reads. */
export const BLAME_SETTINGS = [
  'gitglasses.currentLine',
  'gitglasses.statusBar',
  'gitglasses.hovers',
  'gitglasses.blame',
];

/** VS Code's own Git extension shows blame in the status bar when this is on. */
export const BUILTIN_STATUS_BAR_BLAME = 'git.blame.statusBarItem.enabled';

type Getter = (key: string) => unknown;

function bool(get: Getter, key: string, fallback: boolean): boolean {
  const value = get(key);
  return typeof value === 'boolean' ? value : fallback;
}

export function parseBlameSettings(get: Getter): BlameSettings {
  const statusBar = get('statusBar.blame');
  const moves = get('blame.detectMovedLines');
  return {
    currentLineEnabled: bool(get, 'currentLine.enabled', true),
    statusBar: statusBar === 'show' || statusBar === 'hide' ? statusBar : 'auto',
    hoversEnabled: bool(get, 'hovers.enabled', true),
    text: {
      inlineFormat: parseFormat(get('currentLine.format'), DEFAULT_INLINE_FORMAT),
      statusBarFormat: parseFormat(get('statusBar.format'), DEFAULT_STATUS_BAR_FORMAT),
      dateStyle: parseDateStyle(get('blame.dateStyle')),
    },
    options: {
      ignoreWhitespace: bool(get, 'blame.ignoreWhitespace', false),
      moves: moves === 'withinFile' || moves === 'acrossFiles' ? moves : 'off',
      ignoreRevs: bool(get, 'blame.useIgnoreRevsFile', true),
    },
  };
}

/**
 * Whether the GitGlasses status bar item shows. In `auto` it steps aside
 * while VS Code's own Git blame item is on, so the same line is never
 * described twice; `show` keeps both.
 */
export function statusBarVisible(mode: StatusBarMode, builtinBlameEnabled: unknown): boolean {
  if (mode === 'show') return true;
  if (mode === 'hide') return false;
  return builtinBlameEnabled !== true;
}
