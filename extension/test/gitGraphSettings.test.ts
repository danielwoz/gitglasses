import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GIT_GRAPH_SETTINGS,
  planGitGraphMigration,
  renderMigrationReport,
} from '../src/onboarding/gitGraphSettings';

const ours = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
        contributes: { configuration: { properties: Record<string, unknown> } };
      }
    ).contributes.configuration.properties,
  ),
);

describe('Git Graph settings table', () => {
  it('maps only onto settings GitGlasses contributes', () => {
    for (const [key, mapping] of Object.entries(GIT_GRAPH_SETTINGS)) {
      if (mapping.kind === 'setting') expect(ours.has(mapping.target), key).toBe(true);
    }
  });

  it('covers the settings people change most', () => {
    for (const key of [
      'date.format',
      'defaultColumnVisibility',
      'graph.style',
      'graph.colours',
      'repository.commits.initialLoad',
      'showStatusBarItem',
    ]) {
      expect(GIT_GRAPH_SETTINGS[key], key).toBeDefined();
    }
  });
});

describe('planGitGraphMigration', () => {
  it('copies a value with an equivalent, converted, at the level it was set', () => {
    const plan = planGitGraphMigration(
      [
        { key: 'repository.commits.initialLoad', level: 'user', value: 500 },
        { key: 'repository.commits.initialLoad', level: 'workspace', value: 10 },
      ],
      ours,
    );
    expect(plan.apply).toEqual([
      {
        from: 'git-graph.repository.commits.initialLoad',
        to: 'gitglasses.graph.pageSize',
        level: 'user',
        value: 500,
      },
      {
        from: 'git-graph.repository.commits.initialLoad',
        to: 'gitglasses.graph.pageSize',
        level: 'workspace',
        value: 50,
      },
    ]);
    expect(plan.unmapped).toEqual([]);
  });

  it('prefers the current spelling of a setting over the deprecated one', () => {
    const plan = planGitGraphMigration(
      [
        { key: 'initialLoadCommits', level: 'user', value: 900 },
        { key: 'repository.commits.initialLoad', level: 'user', value: 400 },
      ],
      ours,
    );
    expect(plan.apply.map((entry) => entry.value)).toEqual([400]);
    expect(plan.unmapped).toEqual([]);
  });

  it('reports values without an equivalent, with what GitGlasses does instead where it says', () => {
    const plan = planGitGraphMigration(
      [
        { key: 'date.format', level: 'user', value: 'Relative' },
        { key: 'repository.sign.commits', level: 'user', value: true },
      ],
      ours,
    );
    expect(plan.apply).toEqual([]);
    expect(plan.unmapped[0]).toEqual({
      from: 'git-graph.date.format',
      level: 'user',
      value: 'Relative',
      note: undefined,
    });
    expect(plan.unmapped[1].note).toMatch(/commit\.gpgSign/);
  });

  it('does not copy onto a setting this build does not contribute', () => {
    const plan = planGitGraphMigration(
      [{ key: 'repository.commits.initialLoad', level: 'user', value: 500 }],
      new Set(),
    );
    expect(plan.apply).toEqual([]);
    expect(plan.unmapped.map((entry) => entry.from)).toEqual([
      'git-graph.repository.commits.initialLoad',
    ]);
  });
});

describe('renderMigrationReport', () => {
  it('lists what was copied and what has no equivalent', () => {
    const plan = planGitGraphMigration(
      [
        { key: 'repository.commits.initialLoad', level: 'user', value: 500 },
        { key: 'graph.style', level: 'user', value: 'angular' },
      ],
      ours,
    );
    const report = renderMigrationReport(plan, true);
    expect(report).toContain('## Copied to GitGlasses');
    expect(report).toContain(
      '`git-graph.repository.commits.initialLoad` → `gitglasses.graph.pageSize` = `500` (user settings)',
    );
    expect(report).toContain('## No GitGlasses setting');
    expect(report).toContain('`git-graph.graph.style` = `"angular"`');
  });

  it('says so when no Git Graph setting is set', () => {
    expect(renderMigrationReport({ apply: [], unmapped: [] }, false)).toContain(
      'nothing to carry over',
    );
  });

  it('says the copy was cancelled when it was', () => {
    const plan = planGitGraphMigration(
      [{ key: 'repository.commits.initialLoad', level: 'user', value: 500 }],
      ours,
    );
    expect(renderMigrationReport(plan, false)).toContain('Not copied (cancelled)');
  });
});
