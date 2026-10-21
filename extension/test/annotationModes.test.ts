import { describe, expect, it } from 'vitest';
import { parseStoredModes, serializeModes } from '../src/annotations/annotationLogic';

describe('parseStoredModes', () => {
  it('reads back a stored map', () => {
    const modes = parseStoredModes({ 'file:///a.ts': 'blame', 'file:///b.ts': 'heatmap' });
    expect([...modes]).toEqual([
      ['file:///a.ts', 'blame'],
      ['file:///b.ts', 'heatmap'],
    ]);
  });

  it('drops entries that are not a mode', () => {
    const modes = parseStoredModes({ 'file:///a.ts': 'blame', 'file:///b.ts': 'nonsense' });
    expect([...modes.keys()]).toEqual(['file:///a.ts']);
  });

  it("drops 'off', which is the absence of an entry", () => {
    expect(parseStoredModes({ 'file:///a.ts': 'off' }).size).toBe(0);
  });

  it('tolerates missing or malformed state', () => {
    expect(parseStoredModes(undefined).size).toBe(0);
    expect(parseStoredModes('blame').size).toBe(0);
    expect(parseStoredModes(null).size).toBe(0);
  });
});

describe('serializeModes', () => {
  it('round-trips through parseStoredModes', () => {
    const modes = new Map([['file:///a.ts', 'changes' as const]]);
    expect([...parseStoredModes(serializeModes(modes))]).toEqual([...modes]);
  });

  it('keeps the newest entries when the cap is exceeded', () => {
    const modes = new Map(
      Array.from({ length: 5 }, (_, i) => [`file:///${i}.ts`, 'blame' as const]),
    );
    expect(Object.keys(serializeModes(modes, 2))).toEqual(['file:///3.ts', 'file:///4.ts']);
  });
});
