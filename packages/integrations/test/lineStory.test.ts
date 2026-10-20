import { describe, expect, it, vi } from 'vitest';
import { jiraPattern, matchAutolinks, repoIssuePatterns } from '../src/autolinks.js';
import { AuthError } from '../src/errors.js';
import type { AuthContext, HostingProvider } from '../src/hostingProvider.js';
import {
  boundText,
  buildLineStory,
  descriptionExcerpt,
  issueReferences,
  UNCOMMITTED,
  type LineStory,
  type LineStorySources,
  type StoryBlame,
  type StoryCommit,
  type StoryForge,
  type StoryVersion,
} from '../src/lineStory.js';
import type { Issue, PullRequest, RepoDescriptor } from '../src/models.js';
import { makePr } from './helpers.js';

const SHA = 'a'.repeat(40);
const repo: RepoDescriptor = {
  provider: 'github',
  host: 'github.com',
  owner: 'acme',
  name: 'widgets',
};
const label = {
  providerId: 'github',
  host: 'github.com',
  name: 'GitHub',
  owner: 'acme',
  repo: 'widgets',
};
const signature = { name: 'Ada', email: 'ada@example.com', time: 1_700_000_000 };

function blame(overrides: Partial<StoryBlame> = {}): StoryBlame {
  return {
    sha: SHA,
    line: 42,
    hunkStart: 40,
    hunkLines: 5,
    path: 'src/old-name.ts',
    originalLine: 30,
    author: signature,
    committer: signature,
    summary: 'Fix the parser (#7)',
    boundary: false,
    ...overrides,
  };
}

function commit(overrides: Partial<StoryCommit> = {}): StoryCommit {
  return {
    sha: SHA,
    parents: ['b'.repeat(40)],
    author: signature,
    committer: signature,
    subject: 'Fix the parser (#7)',
    body: 'The tokenizer dropped escapes.\n\nRefs PROJ-3 and #12.',
    trailers: [{ key: 'Reviewed-by', value: 'Grace <grace@example.com>' }],
    ...overrides,
  };
}

function version(n: number): StoryVersion {
  return {
    sha: String(n).repeat(40).slice(0, 40),
    author: signature,
    summary: `change ${n}`,
    path: 'src/old-name.ts',
    additions: 1,
    deletions: 1,
    patch: '@@ -30 +30 @@\n-a\n+b\n',
  };
}

interface FakeProvider extends HostingProvider {
  getPullRequestsForCommit: ReturnType<typeof vi.fn>;
  getIssueOrPr: ReturnType<typeof vi.fn>;
}

function provider(
  prs: PullRequest[] | Error = [],
  issues: Record<string, Issue | PullRequest> = {},
): FakeProvider {
  return {
    id: 'github',
    capabilities: new Set(),
    matchesRemote: () => undefined,
    getMyPullRequests: async () => [],
    getPullRequestForBranch: async () => undefined,
    getIssueOrPr: vi.fn(
      async (_auth: AuthContext, _repo: RepoDescriptor, ref: string) => issues[ref],
    ),
    getPullRequestsForCommit: vi.fn(async () => {
      if (prs instanceof Error) throw prs;
      return prs;
    }),
  };
}

function hosted(fake: HostingProvider, connected = true): StoryForge {
  return {
    kind: 'hosted',
    label,
    provider: fake,
    repo,
    auth: connected ? { token: 't' } : undefined,
  };
}

function sources(
  overrides: Partial<LineStorySources<StoryCommit>> = {},
): LineStorySources<StoryCommit> {
  return {
    commit: async () => commit(),
    history: async () => [version(1), version(2)],
    forge: hosted(provider()),
    issuePatterns: [...repoIssuePatterns(repo), jiraPattern('acme.atlassian.net')],
    ...overrides,
  };
}

const input = { file: 'src/new-name.ts', line: 42, lineText: '  return parse(x);', blame: blame() };

describe('buildLineStory', () => {
  it('tells the whole story of a committed line', async () => {
    const pr = makePr({
      number: 7,
      title: 'Fix the parser',
      state: 'merged',
      mergedAt: '2026-01-02T00:00:00Z',
      body: '<!-- Link issues with "Fixes #999" -->\nFixes #12.\n\n\n\nThe tokenizer dropped escapes.',
      reviewCommentCount: 4,
      commentCount: 2,
    });
    const fake = provider([pr], {
      '12': {
        id: 'I_12',
        key: 'acme/widgets#12',
        title: 'Escapes are lost',
        url: 'https://github.com/acme/widgets/issues/12',
        state: 'closed',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    });
    const history = vi.fn(async () => [version(1), version(2)]);

    const story = await buildLineStory(input, sources({ history, forge: hosted(fake) }));

    expect(story.commit).toEqual({ state: 'ready', value: commit() });
    // The history starts at the blamed commit, at the line's number there.
    expect(history).toHaveBeenCalledWith({
      path: 'src/old-name.ts',
      rev: SHA,
      line: 30,
      limit: 11,
    });
    expect(story.history).toEqual({
      state: 'ready',
      value: { versions: [version(1), version(2)], more: false },
    });
    expect(fake.getPullRequestsForCommit).toHaveBeenCalledWith({ token: 't' }, repo, SHA);
    expect(story.pullRequests).toMatchObject({
      state: 'found',
      forge: label,
      pullRequests: [
        {
          number: 7,
          title: 'Fix the parser',
          state: 'merged',
          mergedAt: '2026-01-02T00:00:00Z',
          excerpt: 'Fixes #12.\n\nThe tokenizer dropped escapes.',
          excerptTruncated: false,
          reviewCommentCount: 4,
          commentCount: 2,
        },
      ],
    });
    // The message names the pull request listed above, so it is not repeated.
    expect(story.pullRequests).not.toHaveProperty('named', expect.anything());
    // #7 is the pull request and #999 sits in a template comment.
    expect(story.issues).toEqual({
      state: 'ready',
      value: [
        { ref: 'PROJ-3', url: 'https://acme.atlassian.net/browse/PROJ-3', source: 'commit' },
        {
          ref: '#12',
          url: 'https://github.com/acme/widgets/issues/12',
          source: 'commit',
          title: 'Escapes are lost',
          state: 'closed',
        },
      ],
    });
    expect(fake.getIssueOrPr).toHaveBeenCalledTimes(1);
  });

  it('reports each part as it arrives', async () => {
    const snapshots: LineStory[] = [];
    let release: (value: StoryCommit) => void = () => undefined;
    const pending = new Promise<StoryCommit>((resolve) => (release = resolve));

    const done = buildLineStory(input, sources({ commit: () => pending }), (story) =>
      snapshots.push(story),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshots[0].commit.state).toBe('loading');
    expect(snapshots.at(-1)?.history.state).toBe('ready');
    release(commit());
    const story = await done;
    expect(story.commit.state).toBe('ready');
    expect(snapshots.at(-1)?.issues.state).toBe('ready');
  });

  it('says how many more earlier versions there are', async () => {
    const story = await buildLineStory(
      input,
      sources({ versions: 2, history: async () => [version(1), version(2), version(3)] }),
    );
    expect(story.history).toEqual({
      state: 'ready',
      value: { versions: [version(1), version(2)], more: true },
    });
  });

  it('offers the pull request the message names when the forge is not connected', async () => {
    const fake = provider();
    const story = await buildLineStory(input, sources({ forge: hosted(fake, false) }));

    expect(story.pullRequests).toEqual({
      state: 'notConnected',
      forge: label,
      named: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    });
    expect(fake.getPullRequestsForCommit).not.toHaveBeenCalled();
    expect(fake.getIssueOrPr).not.toHaveBeenCalled();
    // Still linked, offline.
    expect(story.issues.state === 'ready' && story.issues.value.map((i) => i.ref)).toEqual([
      'PROJ-3',
      '#12',
    ]);
  });

  it('asks neither git nor the forge in Restricted Mode', async () => {
    const fake = provider([makePr()]);
    const history = vi.fn(async () => [version(1)]);

    const story = await buildLineStory(
      input,
      sources({ restricted: true, history, forge: hosted(fake) }),
    );

    expect(history).not.toHaveBeenCalled();
    expect(fake.getPullRequestsForCommit).not.toHaveBeenCalled();
    expect(fake.getIssueOrPr).not.toHaveBeenCalled();
    expect(story.commit.state).toBe('ready');
    expect(story.history).toEqual({ state: 'unavailable', reason: 'restricted' });
    expect(story.pullRequests).toEqual({
      state: 'unavailable',
      reason: 'restricted',
      named: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    });
  });

  it('keeps the rest of the story when the forge refuses', async () => {
    const log = vi.fn();
    const story = await buildLineStory(
      input,
      sources({ forge: hosted(provider(new AuthError('bad token'))), log }),
    );

    expect(story.pullRequests).toMatchObject({
      state: 'failed',
      reason: 'auth',
      message: 'bad token',
      named: { number: 7 },
    });
    expect(story.history.state).toBe('ready');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad token'));
  });

  it('does not offer to connect a forge that cannot look pull requests up', async () => {
    const { getPullRequestsForCommit: _omit, ...withoutLookup } = provider();
    const story = await buildLineStory(
      input,
      sources({ forge: hosted(withoutLookup as HostingProvider, false) }),
    );
    expect(story.pullRequests).toMatchObject({ state: 'unsupported', named: { number: 7 } });
  });

  it('reports a forge without commit lookups, a missing forge, and no git', async () => {
    const { getPullRequestsForCommit: _omit, ...withoutLookup } = provider();
    const unsupported = await buildLineStory(
      input,
      sources({ forge: hosted(withoutLookup as HostingProvider), history: 'noGit' }),
    );
    expect(unsupported.pullRequests).toMatchObject({ state: 'unsupported', named: { number: 7 } });
    expect(unsupported.history).toEqual({ state: 'unavailable', reason: 'noGit' });

    const noForge = await buildLineStory(input, sources({ forge: { kind: 'none' } }));
    expect(noForge.pullRequests).toEqual({ state: 'noForge' });
  });

  it('fails only the part whose source failed', async () => {
    const story = await buildLineStory(
      input,
      sources({
        commit: async () => {
          throw new Error('bad object');
        },
        history: async () => {
          throw new Error('git log failed');
        },
      }),
    );
    expect(story.commit).toEqual({ state: 'failed', message: 'bad object' });
    expect(story.history).toEqual({ state: 'failed', message: 'git log failed' });
    expect(story.issues).toEqual({ state: 'ready', value: [] });
  });

  it('has nothing to look up for a line that is not committed', async () => {
    const fake = provider();
    const commitSource = vi.fn(async () => commit());
    const story = await buildLineStory(
      { ...input, blame: blame({ sha: UNCOMMITTED }) },
      sources({ commit: commitSource, forge: hosted(fake) }),
    );
    expect(commitSource).not.toHaveBeenCalled();
    for (const part of [story.commit, story.pullRequests, story.issues, story.history]) {
      expect(part).toEqual({ state: 'unavailable', reason: 'uncommitted' });
    }
  });

  it('bounds what the forge says', async () => {
    const pr = makePr({ title: `A ${'very '.repeat(80)}long title`, body: 'word '.repeat(400) });
    const story = await buildLineStory(input, sources({ forge: hosted(provider([pr])) }));
    if (story.pullRequests.state !== 'found') throw new Error('expected pull requests');
    const shown = story.pullRequests.pullRequests[0];
    expect(shown.title.length).toBeLessThanOrEqual(201);
    expect(shown.excerpt.length).toBeLessThanOrEqual(601);
    expect(shown.excerpt.endsWith('…')).toBe(true);
    expect(shown.excerptTruncated).toBe(true);
    expect(shown).not.toHaveProperty('body');
  });
});

describe('buildLineStory issues on forges with their own pull request numbers', () => {
  function forgeOf(providerId: string, host: string, fake: HostingProvider): StoryForge {
    const where: RepoDescriptor = { provider: providerId, host, owner: 'g', name: 'p' };
    return {
      kind: 'hosted',
      label: { providerId, host, name: providerId, owner: 'g', repo: 'p' },
      provider: fake,
      repo: where,
      auth: { token: 't' },
    };
  }

  it('keeps a GitLab issue that has the number of the merge request', async () => {
    const mr = makePr({ number: 12, state: 'merged', body: 'Closes #12' });
    const forge = forgeOf('gitlab', 'gitlab.com', provider([mr]));
    const story = await buildLineStory(
      input,
      sources({
        forge,
        issuePatterns: repoIssuePatterns({ host: 'gitlab.com', owner: 'g', name: 'p' }),
        commit: async () =>
          commit({ subject: 'Fix the parser', body: 'Closes #12\n\nSee merge request g/p!12' }),
      }),
    );
    expect(story.issues).toMatchObject({
      state: 'ready',
      value: [{ ref: '#12', url: 'https://gitlab.com/g/p/issues/12', source: 'commit' }],
    });
  });

  it("drops the forge's own pull request wording but keeps a Bitbucket issue of that number", async () => {
    const { getPullRequestsForCommit: _omit, ...bitbucket } = provider();
    const forge = forgeOf('bitbucket', 'bitbucket.org', bitbucket as HostingProvider);
    const patterns = repoIssuePatterns({ host: 'bitbucket.org', owner: 'g', name: 'p' });
    const refs = async (message: Pick<StoryCommit, 'subject' | 'body'>) => {
      const story = await buildLineStory(
        input,
        sources({ forge, issuePatterns: patterns, commit: async () => commit(message) }),
      );
      return story.issues.state === 'ready' ? story.issues.value.map((issue) => issue.ref) : [];
    };
    expect(await refs({ subject: 'Merged in fix (pull request #12)', body: 'Fixes #3.' })).toEqual([
      '#3',
    ]);
    expect(await refs({ subject: 'Merged in fix (pull request #12)', body: 'Fixes #12.' })).toEqual(
      ['#12'],
    );
  });

  it('still treats a GitHub "#N" naming the pull request as that pull request', async () => {
    const pr = makePr({ number: 12, state: 'merged', body: 'Follow-up to #12, fixes #3' });
    const story = await buildLineStory(
      input,
      sources({
        forge: hosted(provider([pr])),
        commit: async () => commit({ subject: 'Fix the parser (#12)', body: 'See #12.' }),
      }),
    );
    expect(story.issues.state === 'ready' && story.issues.value.map((i) => i.ref)).toEqual(['#3']);
  });
});

describe('descriptionExcerpt', () => {
  it('drops template comments, including an unclosed one', () => {
    expect(descriptionExcerpt('Intro\n<!-- hidden -->\nMore\n<!-- never closed\nsecret')).toEqual({
      text: 'Intro\n\nMore',
      truncated: false,
    });
  });

  it('folds CRLF and runs of blank lines', () => {
    expect(descriptionExcerpt('a  \r\n\r\n\r\n\r\nb\r\n').text).toBe('a\n\nb');
  });
});

describe('boundText', () => {
  it('cuts at a word boundary', () => {
    expect(boundText('alpha beta gamma', 12)).toEqual({ text: 'alpha beta…', truncated: true });
    expect(boundText('short', 12)).toEqual({ text: 'short', truncated: false });
  });
});

describe('issueReferences', () => {
  it('lists each link once, in order, skipping excluded ones', () => {
    const issues = issueReferences(
      [
        { text: 'Fixes #1, #2 and #1 again', source: 'commit' },
        { text: 'See #3', source: 'pullRequest' },
      ],
      repoIssuePatterns(repo),
      (match) => match.text === '#2',
    );
    expect(issues.map((issue) => [issue.ref, issue.source])).toEqual([
      ['#1', 'commit'],
      ['#3', 'pullRequest'],
    ]);
  });
});

describe('matchAutolinks', () => {
  it('lets the earlier pattern win an overlap and skips invalid patterns', () => {
    const matches = matchAutolinks('PROJ-12 and #4', [
      { regex: '(', urlTemplate: 'https://x/$1' },
      jiraPattern('acme.atlassian.net'),
      { regex: 'PROJ-(\\d+)', urlTemplate: 'https://other/$1' },
      ...repoIssuePatterns(repo),
    ]);
    expect(matches.map((match) => [match.text, match.url])).toEqual([
      ['PROJ-12', 'https://acme.atlassian.net/browse/PROJ-12'],
      ['#4', 'https://github.com/acme/widgets/issues/4'],
    ]);
  });
});
