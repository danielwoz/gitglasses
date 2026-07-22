import { describe, expect, it } from 'vitest';
import {
  FeatureStates,
  INITIAL_MODE_STATE,
  isMode,
  statusBarText,
  switchMode,
} from '../src/modes/modeLogic';

const allOn: FeatureStates = { lineBlame: true, fileAnnotations: true, codeLens: true };
const allOff: FeatureStates = { lineBlame: false, fileAnnotations: false, codeLens: false };
const mixed: FeatureStates = { lineBlame: true, fileAnnotations: false, codeLens: true };

describe('switchMode', () => {
  it('enters zen from normal: captures current states and disables everything', () => {
    const { state, effects } = switchMode(INITIAL_MODE_STATE, 'zen', mixed);
    expect(state.mode).toBe('zen');
    expect(state.saved).toEqual(mixed);
    expect(effects.apply).toEqual(allOff);
    expect(effects.forceGutterBlame).toBe(false);
  });

  it('exits zen to normal: restores captured states and clears the capture', () => {
    const zen = switchMode(INITIAL_MODE_STATE, 'zen', mixed).state;
    const { state, effects } = switchMode(zen, 'normal', allOff);
    expect(state.mode).toBe('normal');
    expect(state.saved).toBeUndefined();
    expect(effects.apply).toEqual(mixed);
    expect(effects.forceGutterBlame).toBe(false);
  });

  it('enters review from normal: captures, enables everything, forces gutter blame', () => {
    const { state, effects } = switchMode(INITIAL_MODE_STATE, 'review', mixed);
    expect(state.mode).toBe('review');
    expect(state.saved).toEqual(mixed);
    expect(effects.apply).toEqual(allOn);
    expect(effects.forceGutterBlame).toBe(true);
  });

  it('exits review to normal: restores captured states', () => {
    const review = switchMode(INITIAL_MODE_STATE, 'review', mixed).state;
    const { state, effects } = switchMode(review, 'normal', allOn);
    expect(state.mode).toBe('normal');
    expect(effects.apply).toEqual(mixed);
    expect(effects.forceGutterBlame).toBe(false);
  });

  it('zen -> review keeps the original capture (no re-capture mid-mode)', () => {
    const zen = switchMode(INITIAL_MODE_STATE, 'zen', mixed).state;
    const { state, effects } = switchMode(zen, 'review', allOff);
    expect(state.mode).toBe('review');
    expect(state.saved).toEqual(mixed);
    expect(effects.apply).toEqual(allOn);
    expect(effects.forceGutterBlame).toBe(true);
  });

  it('review -> zen keeps the capture and stops forcing gutter blame', () => {
    const review = switchMode(INITIAL_MODE_STATE, 'review', mixed).state;
    const { state, effects } = switchMode(review, 'zen', allOn);
    expect(state.mode).toBe('zen');
    expect(state.saved).toEqual(mixed);
    expect(effects.apply).toEqual(allOff);
    expect(effects.forceGutterBlame).toBe(false);
  });

  it('zen -> review -> normal restores the pre-zen states', () => {
    let state = switchMode(INITIAL_MODE_STATE, 'zen', mixed).state;
    state = switchMode(state, 'review', allOff).state;
    const { state: final, effects } = switchMode(state, 'normal', allOn);
    expect(final.mode).toBe('normal');
    expect(effects.apply).toEqual(mixed);
  });

  it('switching to the current mode is a no-op (state identity, nothing applied)', () => {
    const zen = switchMode(INITIAL_MODE_STATE, 'zen', mixed).state;
    const { state, effects } = switchMode(zen, 'zen', allOff);
    expect(state).toBe(zen);
    expect(effects.apply).toBeUndefined();
  });

  it('re-selecting review keeps forcing gutter blame for the active editor', () => {
    const review = switchMode(INITIAL_MODE_STATE, 'review', mixed).state;
    const { effects } = switchMode(review, 'review', allOn);
    expect(effects.apply).toBeUndefined();
    expect(effects.forceGutterBlame).toBe(true);
  });

  it('normal -> normal applies nothing', () => {
    const { state, effects } = switchMode(INITIAL_MODE_STATE, 'normal', mixed);
    expect(state).toBe(INITIAL_MODE_STATE);
    expect(effects.apply).toBeUndefined();
    expect(effects.forceGutterBlame).toBe(false);
  });

  it('capture is a snapshot, not a live reference', () => {
    const current = { ...mixed };
    const { state } = switchMode(INITIAL_MODE_STATE, 'zen', current);
    current.lineBlame = false;
    expect(state.saved?.lineBlame).toBe(true);
  });
});

describe('statusBarText / isMode', () => {
  it('labels zen and review, hides in normal', () => {
    expect(statusBarText('zen')).toBe('$(eye) Zen');
    expect(statusBarText('review')).toBe('$(checklist) Review');
    expect(statusBarText('normal')).toBeUndefined();
  });

  it('isMode validates setting values', () => {
    expect(isMode('normal')).toBe(true);
    expect(isMode('zen')).toBe(true);
    expect(isMode('review')).toBe(true);
    expect(isMode('focus')).toBe(false);
    expect(isMode(undefined)).toBe(false);
  });
});
