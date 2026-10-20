// Visual File History names each author lane on the left. A name too long for
// the column is cut short with an ellipsis, and hovering it shows it whole.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineRenderer, type ThemeColors } from '../webviews-src/timeline/renderer';
import {
  assignAuthorLanes,
  fitText,
  hitTestLabels,
  timeDomain,
} from '../webviews-src/timeline/timelineLogic';
import type { FileHistoryEntry } from '../webviews-src/timeline/ipc';

/** Every character 7px wide, about what a 13px UI font averages. */
const measure = (text: string): number => Array.from(text).length * 7;

describe('fitText', () => {
  it('keeps text that fits', () => {
    expect(fitText('Ada Lovelace', 104, measure)).toBe('Ada Lovelace');
    expect(fitText('', 104, measure)).toBe('');
  });

  it('cuts text that does not with an ellipsis, within the width', () => {
    const fitted = fitText('Patrick Steinhardt', 104, measure);
    expect(fitted).toBe('Patrick Stein…');
    expect(measure(fitted)).toBeLessThanOrEqual(104);
    // The cut never leaves a space before the ellipsis.
    expect(fitText('Patrick Steinhardt', 63, measure)).toBe('Patrick…');
  });

  it('never splits a character made of two code units', () => {
    expect(fitText('😀😀😀😀😀', 21, measure)).toBe('😀😀…');
  });

  it('never splits a character drawn from several code points', () => {
    // Measured per code point, the longest prefix that fits ends inside each
    // of these characters; the cut falls before them instead.
    // A combining accent stays with its letter.
    expect(fitText('Rene\u0301 Descartes', 35, measure)).toBe('Ren…');
    // A Devanagari vowel sign stays with its consonant.
    expect(fitText('प्रशांत कुमार', 35, measure)).toBe('प्र…');
    // A family emoji joined with zero-width joiners stays whole, or goes.
    expect(fitText('👩\u200d👩\u200d👧 Family', 42, measure)).toBe('👩\u200d👩\u200d👧…');
    expect(fitText('👩\u200d👩\u200d👧 Family', 35, measure)).toBe('…');
  });

  it('keeps the ellipsis at the cut of right-to-left text', () => {
    // A direction mark takes no width.
    const drawn = (text: string): number => measure(text.replace(/\p{Cf}/gu, ''));
    // After Hebrew or Arabic, a right-to-left mark draws the ellipsis on the
    // left of the cut text, next to the cut.
    expect(fitText('שלום עליכם', 56, drawn)).toBe('שלום על…\u200f');
    expect(fitText('Noa כהן לוי', 49, drawn)).toBe('Noa כה…\u200f');
    // After Latin, it already is.
    expect(fitText('محمد Smith', 56, drawn)).toBe('محمد Sm…');
  });

  it('gives up on a width too narrow for the ellipsis', () => {
    expect(fitText('Ada', 10, measure)).toBe('…');
    expect(fitText('Ada', 5, measure)).toBe('');
  });
});

describe('hitTestLabels', () => {
  const labels = [
    { top: 10, bottom: 50, right: 120, text: 'Patrick Steinhardt', truncated: true },
    { top: 50, bottom: 90, right: 120, text: 'Ada', truncated: false },
  ];

  it('finds the label column of the lane under the pointer', () => {
    expect(hitTestLabels(labels, 30, 20)).toBe(0);
    expect(hitTestLabels(labels, 119, 50)).toBe(1);
    expect(hitTestLabels(labels, 120, 20)).toBeUndefined();
    expect(hitTestLabels(labels, 30, 95)).toBeUndefined();
  });
});

describe('TimelineRenderer lane labels', () => {
  const drawn: string[] = [];

  /** A 2D context that measures every character as 7px and records text. */
  function canvas(): HTMLCanvasElement {
    const ctx = new Proxy(
      {
        measureText: (text: string) => ({ width: measure(text) }),
        fillText: (text: string) => drawn.push(text),
      } as Record<string, unknown>,
      {
        get: (target, name: string) => target[name] ?? (() => undefined),
        set: () => true,
      },
    );
    return {
      width: 0,
      height: 0,
      style: {},
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
  }

  const theme: ThemeColors = {
    foreground: '#cccccc',
    mutedForeground: '#8b8b8b',
    grid: '#5a5a5a',
    addColor: { r: 0, g: 255, b: 0 },
    deleteColor: { r: 255, g: 0, b: 0 },
    fontFamily: 'sans-serif',
    fontSize: '13px',
  };

  function entry(name: string, email: string, time: number): FileHistoryEntry {
    return {
      sha: `${time}`.padStart(40, '0'),
      author: { name, email, time },
      summary: 'change',
      path: 'a.txt',
      additions: name.length,
      deletions: 0,
    };
  }

  beforeEach(() => {
    drawn.length = 0;
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws a long name cut short and keeps it whole for the tooltip', () => {
    const entries = [
      entry('Patrick Steinhardt', 'ps@example.com', 1_700_000_000),
      entry('Ada', 'ada@example.com', 1_700_100_000),
    ];
    const renderer = new TimelineRenderer(canvas());
    renderer.render({
      entries,
      assignment: assignAuthorLanes(entries),
      domain: timeDomain(
        entries.map((e) => e.author.time * 1000),
        0,
      ),
      viewportW: 800,
      viewportH: 200,
      theme,
    });
    expect(drawn.slice(0, 2)).toEqual(['Patrick Stein…', 'Ada']);
    expect(renderer.labels.map(({ text, truncated }) => ({ text, truncated }))).toEqual([
      { text: 'Patrick Steinhardt', truncated: true },
      { text: 'Ada', truncated: false },
    ]);
    const first = renderer.labels[0];
    const under = hitTestLabels(renderer.labels, 20, (first.top + first.bottom) / 2);
    expect(under === undefined ? undefined : renderer.labels[under].text).toBe(
      'Patrick Steinhardt',
    );
  });
});
