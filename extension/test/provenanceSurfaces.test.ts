// Declared provenance where commits are shown: what the extension asks the
// engine (nothing while the setting is off, batches and a cache otherwise),
// the graph's marks and setting flag, the details view's row, the history
// views' rows and the hover line.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => import('./support/fakeWebviewVscode'));

import type { CommitProvenance, GraphRow } from '@gitglasses/protocol';
import type { EngineClient } from '@gitglasses/rpc';
import {
  EventEmitter,
  FakeWebviewPanel,
  TreeItem,
  Uri,
  controls,
  recorded,
} from './support/fakeWebviewVscode';
import { ProvenanceService } from '../src/provenance/provenanceService';
import { decorateCommitItem } from '../src/provenance/provenanceView';
import { loadCommitView } from '../src/commitDetails/commitViews';
import { GraphWebviewHost } from '../src/webviews/graphHost';
import { setActiveRepoResolver } from '../src/views/viewBase';
import type { RepositoryService } from '../src/model/repositoryService';
import { renderCommitHover } from '../src/annotations/blameHoverLogic';

const AGENT = 'a'.repeat(40);
const PLAIN = 'b'.repeat(40);
/** A commit whose git-ai note the clone has not fetched the content of. */
const MISSING = 'c'.repeat(40);

const DECLARED: CommitProvenance = {
  declared: 'agent',
  declarations: [
    {
      source: 'trailer',
      kind: 'agent',
      name: 'Claude',
      via: 'Co-authored-by',
      value: 'Claude <noreply@anthropic.com>',
      url: 'https://example.com/session/1',
    },
  ],
};

/** An engine whose commit/provenance declares an agent for AGENT, nothing
 *  for PLAIN, and leaves out any other sha. */
function provenanceEngine(caps: Record<string, unknown> = { gitCli: true, watch: true }) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const notifications = new EventEmitter<{ repoId: string; changed: string[] }>();
  let failing = false;
  const row = (sha: string): GraphRow => ({
    sha,
    parents: [],
    lane: 0,
    laneEdges: [],
    kind: 'commit',
    author: { name: 'A', email: 'a@example.com', time: 1 },
    time: 1,
    summary: sha.slice(0, 4),
    refs: [],
  });
  const engine = {
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params });
      switch (method) {
        case 'commit/provenance': {
          if (failing) throw new Error('engine gone');
          const commits: Record<string, CommitProvenance> = {};
          for (const sha of params.shas as string[]) {
            if (sha === AGENT) commits[sha] = DECLARED;
            if (sha === PLAIN) commits[sha] = { declared: 'unknown', declarations: [] };
            if (sha === MISSING) {
              commits[sha] = {
                declared: 'unknown',
                declarations: [],
                note: { read: false, ref: 'refs/notes/ai', missing: true },
              };
            }
          }
          return { commits };
        }
        case 'commit/details':
          return { sha: params.sha, subject: 's', files: [] };
        case 'graph/rows':
          return { rows: [row(AGENT), row(PLAIN)], refsFingerprint: 1 };
        case 'refs/list':
          return { branches: [], remotes: [], tags: [] };
        default:
          return {};
      }
    },
    capabilities: () => caps,
    onNotification: (_method: string, listener: (params: unknown) => void) =>
      notifications.event(listener as never),
    onDidChangeCapabilities: () => ({ dispose: () => undefined }),
  };
  return {
    engine: engine as unknown as EngineClient,
    requests,
    asked: () => requests.filter((r) => r.method === 'commit/provenance'),
    notify: (repoId: string, changed: string[]) => notifications.fire({ repoId, changed }),
    fail: () => {
      failing = true;
    },
  };
}

beforeEach(() => recorded.reset());
afterEach(() => {
  setActiveRepoResolver(undefined);
  controls.settings.clear();
});

const setEnabled = (enabled: boolean): void => {
  controls.settings.set('gitglasses.provenance.enabled', enabled);
  controls.configurationChanged.fire({
    affectsConfiguration: (section: string) => section === 'gitglasses.provenance.enabled',
  });
};

describe('ProvenanceService', () => {
  it('asks nothing while provenance is turned off', async () => {
    const fake = provenanceEngine();
    const service = new ProvenanceService(fake.engine, () => undefined);
    setEnabled(false);
    expect(await service.lookup('r1', [AGENT])).toEqual(new Map());
    expect(fake.asked()).toEqual([]);
  });

  it('asks in batches, once per commit, and asks again after the refs move', async () => {
    const fake = provenanceEngine();
    const service = new ProvenanceService(fake.engine, () => undefined);
    const many = Array.from({ length: 700 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    await service.lookup('r1', [...many, AGENT]);
    expect(fake.asked().map((r) => (r.params.shas as string[]).length)).toEqual([500, 201]);

    const found = await service.lookup('r1', [AGENT, PLAIN, 'not-a-sha']);
    expect(found.get(AGENT)).toEqual(DECLARED);
    // AGENT was kept; only PLAIN is new.
    expect(fake.asked().at(-1)?.params.shas).toEqual([PLAIN]);

    fake.notify('r1', ['refs']);
    await service.get('r1', AGENT);
    expect(fake.asked().at(-1)?.params.shas).toEqual([AGENT]);
  });

  it('asks again about a commit whose note content is missing', async () => {
    const fake = provenanceEngine();
    const service = new ProvenanceService(fake.engine, () => undefined);
    expect((await service.get('r1', MISSING))?.note?.missing).toBe(true);
    await service.lookup('r1', [MISSING, PLAIN]);
    expect(fake.asked().map((r) => r.params.shas)).toEqual([[MISSING], [MISSING, PLAIN]]);
    await service.lookup('r1', [PLAIN]);
    expect(fake.asked()).toHaveLength(2);
  });

  it('logs a failure once and answers with nothing', async () => {
    const fake = provenanceEngine();
    const log = vi.fn();
    const service = new ProvenanceService(fake.engine, log);
    fake.fail();
    expect(await service.get('r1', AGENT)).toBeUndefined();
    expect(await service.get('r1', PLAIN)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/provenance: .*engine gone/);
  });

  it('fires when the setting changes', () => {
    const service = new ProvenanceService(provenanceEngine().engine, () => undefined);
    const fired = vi.fn();
    service.onDidChangeEnabled(fired);
    setEnabled(false);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(service.enabled()).toBe(false);
  });
});

describe('the graph', () => {
  function setup() {
    const fake = provenanceEngine();
    setActiveRepoResolver(async () => ({ repoId: 'r1', rootPath: '/repos/one' }));
    const provenance = new ProvenanceService(fake.engine, () => undefined);
    const host = new GraphWebviewHost({
      context: { extensionUri: Uri.file('/ext') } as unknown as vscode.ExtensionContext,
      engine: fake.engine,
      repos: { isRootOf: () => true, locate: () => undefined } as unknown as RepositoryService,
      onDidChangeActiveRepo: new EventEmitter<void>().event,
      onDidReload: new EventEmitter<void>().event,
      openRebase: vi.fn(),
      log: () => undefined,
      provenance,
    });
    const panel = new FakeWebviewPanel();
    host.adopt(panel as unknown as vscode.WebviewPanel);
    return { ...fake, host, panel };
  }

  it('marks the commits that declare an agent, after their rows', async () => {
    const { panel } = setup();
    await panel.deliver({ type: 'ready' });
    await vi.waitFor(() => expect(panel.postedOfType('provenance')).toHaveLength(1));
    expect(panel.postedOfType<{ type: 'reset'; provenance: boolean }>('reset')[0].provenance).toBe(
      true,
    );
    const types = panel.posted.map((m) => (m as { type: string }).type);
    expect(types.indexOf('rows')).toBeLessThan(types.indexOf('provenance'));
    const { marks } = panel.postedOfType<{
      type: 'provenance';
      marks: Record<string, unknown>;
    }>('provenance')[0];
    expect(marks[PLAIN]).toBeNull();
    expect(marks[AGENT]).toMatchObject({
      agent: true,
      label: 'AI-assisted',
      text: 'AI-assisted (declared via Co-authored-by: Claude)',
      sessionUrl: 'https://example.com/session/1',
    });
  });

  it('tells the webview when provenance is turned off, and asks nothing more', async () => {
    const { panel, asked } = setup();
    await panel.deliver({ type: 'ready' });
    await vi.waitFor(() => expect(panel.postedOfType('provenance')).toHaveLength(1));
    const before = asked().length;
    setEnabled(false);
    await vi.waitFor(() =>
      expect(
        panel.postedOfType<{ type: 'settings'; provenance: boolean }>('settings').at(-1)
          ?.provenance,
      ).toBe(false),
    );
    await panel.deliver({ type: 'refresh' });
    expect(asked().length).toBe(before);
  });
});

describe('the details view', () => {
  it('carries the mark of a commit that declares something, and none otherwise', async () => {
    const fake = provenanceEngine();
    const provenance = new ProvenanceService(fake.engine, () => undefined);
    const declared = await loadCommitView(fake.engine, 'r1', AGENT, undefined, provenance);
    expect(declared).toMatchObject({
      kind: 'commit',
      provenance: {
        agent: true,
        via: 'Co-authored-by: Claude',
        lines: [
          'AI-assisted (declared via Co-authored-by: Claude)',
          'session: https://example.com/session/1',
        ],
      },
    });
    const plain = await loadCommitView(fake.engine, 'r1', PLAIN, undefined, provenance);
    expect(plain).not.toHaveProperty('provenance');
    // A stash entry is no authored commit.
    const stash = await loadCommitView(fake.engine, 'r1', AGENT, 0, provenance);
    expect(stash).not.toHaveProperty('provenance');
  });
});

describe('the history views', () => {
  it('marks an agent-declared commit row and lists the declarations in its tooltip', () => {
    const item = new TreeItem('Fix it') as unknown as vscode.TreeItem;
    item.description = 'abc1234 A 2 days ago';
    item.tooltip = 'abc1234…';
    decorateCommitItem(item, DECLARED);
    expect((item.iconPath as { id: string }).id).toBe('sparkle');
    expect(item.description).toBe('abc1234 A 2 days ago · AI-assisted (declared)');
    expect(item.tooltip).toBe(
      'abc1234…\nAI-assisted (declared via Co-authored-by: Claude)\n' +
        'session: https://example.com/session/1',
    );

    const plain = new TreeItem('Fix it') as unknown as vscode.TreeItem;
    plain.description = 'abc1234 A 2 days ago';
    decorateCommitItem(plain, { declared: 'unknown', declarations: [] });
    expect(plain.description).toBe('abc1234 A 2 days ago');
    expect(plain.iconPath).toBeUndefined();
  });
});

describe('the blame hover', () => {
  it('shows the provenance line between the commit facts and the links', () => {
    const markdown = renderCommitHover({
      hunk: { sha: AGENT, resultLine: 1, originalLine: 1, lineCount: 1, path: 'a.txt' },
      commit: {
        author: { name: 'A', email: 'a@example.com', time: 1 },
        committer: { name: 'A', email: 'a@example.com', time: 1 },
        summary: 's',
        boundary: false,
      },
      line: 1,
      target: { repoId: 'r1', repoPath: '/repos/one', path: 'a.txt' },
      subject: 's',
      remote: false,
      provenance: '$(sparkle) **AI\\-assisted** (declared via Co\\-authored\\-by: Claude)',
      nowUnixSeconds: 10,
      locale: 'en-US',
    });
    const [body, links] = markdown.split('\n\n---\n\n');
    expect(
      body.endsWith('$(sparkle) **AI\\-assisted** (declared via Co\\-authored\\-by: Claude)'),
    ).toBe(true);
    expect(links).toContain('Copy SHA');
  });
});
