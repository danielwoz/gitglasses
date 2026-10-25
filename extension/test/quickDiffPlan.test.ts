import { describe, expect, it } from 'vitest';
import { planQuickDiffSources } from '../src/scm/quickDiffPlan';

const key = (root: string): string => root.toLowerCase();

describe('planQuickDiffSources', () => {
  it('adds a source control for each new repository and removes those that are gone', () => {
    expect(planQuickDiffSources(['/w/a', '/w/b'], ['/w/b', '/w/c'], key)).toEqual({
      add: ['/w/c'],
      remove: ['/w/a'],
    });
  });

  it('adds one source control for two spellings of one root', () => {
    expect(planQuickDiffSources([], ['/W/Repo', '/w/repo'], key)).toEqual({
      add: ['/W/Repo'],
      remove: [],
    });
  });

  it('changes nothing when the repositories are the same', () => {
    expect(planQuickDiffSources(['/w/a'], ['/w/a'], key)).toEqual({ add: [], remove: [] });
  });
});
