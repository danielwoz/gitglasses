// Pure mode state machine (no vscode imports). The controller captures the
// annotation feature states before leaving normal mode and restores them when
// returning; zen/review switches in between keep the original capture.

export type Mode = 'normal' | 'zen' | 'review';

export const MODES: readonly Mode[] = ['normal', 'zen', 'review'];

export function isMode(value: unknown): value is Mode {
  return value === 'normal' || value === 'zen' || value === 'review';
}

/** Controller-level enablement of each annotation feature. Inline line blame
 *  and the status-bar blame item share one controller, hence one flag. */
export interface FeatureStates {
  lineBlame: boolean;
  fileAnnotations: boolean;
  codeLens: boolean;
}

export interface ModeState {
  mode: Mode;
  /** Feature states captured on leaving normal mode; restored on return. */
  saved?: FeatureStates;
}

export interface ModeEffects {
  /** Feature enablement to apply; undefined for a same-mode no-op switch. */
  apply?: FeatureStates;
  /** Gutter blame should be forced on for active/subsequent editors. */
  forceGutterBlame: boolean;
}

export const INITIAL_MODE_STATE: ModeState = { mode: 'normal' };

const ALL_OFF: FeatureStates = { lineBlame: false, fileAnnotations: false, codeLens: false };
const ALL_ON: FeatureStates = { lineBlame: true, fileAnnotations: true, codeLens: true };

/**
 * Computes the next state and side effects for switching to `next`.
 * `current` is the live feature enablement at the moment of the switch; it is
 * captured only when leaving normal mode, so zen↔review round trips restore
 * the user's original configuration.
 */
export function switchMode(
  state: ModeState,
  next: Mode,
  current: FeatureStates,
): { state: ModeState; effects: ModeEffects } {
  if (next === state.mode) {
    return { state, effects: { forceGutterBlame: state.mode === 'review' } };
  }

  if (next === 'normal') {
    const restore = state.saved ?? current;
    return { state: { mode: 'normal' }, effects: { apply: restore, forceGutterBlame: false } };
  }

  const saved = state.mode === 'normal' ? { ...current } : (state.saved ?? { ...current });
  if (next === 'zen') {
    return {
      state: { mode: 'zen', saved },
      effects: { apply: { ...ALL_OFF }, forceGutterBlame: false },
    };
  }
  return {
    state: { mode: 'review', saved },
    effects: { apply: { ...ALL_ON }, forceGutterBlame: true },
  };
}

/** Status bar label; undefined hides the item (normal mode). */
export function statusBarText(mode: Mode): string | undefined {
  if (mode === 'zen') return '$(eye) Zen';
  if (mode === 'review') return '$(checklist) Review';
  return undefined;
}
