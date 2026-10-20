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
  /** Milliseconds the cursor rests on a line before its blame shows. */
  currentLineDelay: number;
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
/** VS Code's own Git extension does nothing at all while this is off. */
export const BUILTIN_GIT_ENABLED = 'git.enabled';
/** The id of VS Code's own Git extension. */
export const BUILTIN_GIT_EXTENSION = 'vscode.git';

/** Default and bounds of gitglasses.currentLine.delay. */
export const DEFAULT_CURRENT_LINE_DELAY_MS = 75;
export const MAX_CURRENT_LINE_DELAY_MS = 5000;

type Getter = (key: string) => unknown;

function bool(get: Getter, key: string, fallback: boolean): boolean {
  const value = get(key);
  return typeof value === 'boolean' ? value : fallback;
}

function delayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CURRENT_LINE_DELAY_MS;
  return Math.min(Math.max(Math.round(value), 0), MAX_CURRENT_LINE_DELAY_MS);
}

export function parseBlameSettings(get: Getter): BlameSettings {
  const statusBar = get('statusBar.blame');
  const moves = get('blame.detectMovedLines');
  return {
    currentLineEnabled: bool(get, 'currentLine.enabled', true),
    currentLineDelay: delayMs(get('currentLine.delay')),
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

/** What decides whether VS Code's own Git extension shows status bar blame. */
export interface BuiltinGitState {
  /** The vscode.git extension is installed and enabled. */
  extensionPresent: boolean;
  /** The git.enabled setting. */
  gitEnabled: unknown;
  /** The git.blame.statusBarItem.enabled setting. */
  statusBarItem: unknown;
}

/** Whether VS Code's own Git status bar blame is showing. Its setting keeps
 *  its default (on) while the extension is disabled or git.enabled is off,
 *  and then nothing shows. */
export function builtinStatusBarBlameOn(state: BuiltinGitState): boolean {
  return state.extensionPresent && state.gitEnabled !== false && state.statusBarItem === true;
}

/**
 * Whether the GitGlasses status bar item shows. In `auto` it steps aside
 * while VS Code's own Git blame item is on, so the same line is never
 * described twice; `show` keeps both.
 */
export function statusBarVisible(mode: StatusBarMode, builtinBlameOn: boolean): boolean {
  if (mode === 'show') return true;
  if (mode === 'hide') return false;
  return !builtinBlameOn;
}

/** Where current-line blame shows. */
export interface LineBlameSurfaces {
  /** After the end of the line (gitglasses.currentLine.enabled). */
  inline: boolean;
  /** In the status bar (gitglasses.statusBar.blame). */
  statusBar: boolean;
}

/** The two settings are independent, so the status bar alone can carry
 *  blame; a mode that suppresses current-line blame hides both. */
export function lineBlameSurfaces(
  currentLineEnabled: boolean,
  statusBarShown: boolean,
  suppressed: boolean,
): LineBlameSurfaces {
  return {
    inline: currentLineEnabled && !suppressed,
    statusBar: statusBarShown && !suppressed,
  };
}
