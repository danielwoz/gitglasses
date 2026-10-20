// A branch's pull request, found from a real repository's config the way the
// integration service finds it: the layouts git, `gh pr checkout` and the
// GitHub Pull Requests extension leave behind, the providers the extension
// builds, and a stub GitHub that knows which pull requests are open.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike, HttpResponseLike } from '@gitglasses/integrations';
import { findBranchPullRequest } from '../src/integrations/branchPullRequest';
import { parseGitConfig, pullRequestRemotes } from '../src/integrations/gitConfig';
import { buildHostingEntries, hostingForUrl } from '../src/integrations/providerSetup';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'branch.autoSetupMerge=true',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** A repository with one commit and `remotes`, each with the given branches. */
function repository(remotes: Record<string, { url: string; branches: string[] }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-branch-pr-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  for (const [name, remote] of Object.entries(remotes)) {
    git(dir, 'remote', 'add', name, remote.url);
    for (const branch of remote.branches) {
      git(dir, 'update-ref', `refs/remotes/${name}/${branch}`, 'HEAD');
    }
  }
  return dir;
}

interface OpenPull {
  /** "owner/name" of the repository the pull request targets. */
  base: string;
  number: number;
  headOwner: string;
  branch: string;
}

function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** github.com with these open pull requests, answering the calls a lookup makes. */
function fakeGitHub(pulls: OpenPull[]): FetchLike {
  const node = (pull: OpenPull) => ({
    id: `PR_${pull.number}`,
    number: pull.number,
    title: `${pull.headOwner}:${pull.branch}`,
    url: `https://github.com/${pull.base}/pull/${pull.number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: pull.headOwner },
    baseRefName: 'main',
    headRefName: pull.branch,
    headRefOid: 'a'.repeat(40),
    repository: { name: pull.base.split('/')[1], owner: { login: pull.base.split('/')[0] } },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    commits: { nodes: [] },
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    headRepositoryOwner: { login: pull.headOwner },
  });
  const rest = (pull: OpenPull) => ({
    number: pull.number,
    node_id: `PR_${pull.number}`,
    title: `${pull.headOwner}:${pull.branch}`,
    html_url: `https://github.com/${pull.base}/pull/${pull.number}`,
    state: 'open',
    user: { login: pull.headOwner },
    base: { ref: 'main' },
    head: { ref: pull.branch, sha: 'a'.repeat(40), repo: { owner: { login: pull.headOwner } } },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pull_request: {},
  });
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const list = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(pathname);
    if (list) {
      const [owner, branch] = (searchParams.get('head') ?? '').split(/:(.*)/);
      return jsonResponse(
        pulls
          .filter((pull) => pull.base === list[1] && pull.branch === branch)
          .filter((pull) => pull.headOwner.toLowerCase() === owner.toLowerCase())
          .map(rest),
      );
    }
    const one = /^\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/.exec(pathname);
    if (one) {
      const pull = pulls.find((p) => p.base === one[1] && p.number === Number(one[2]));
      return pull ? jsonResponse(rest(pull)) : jsonResponse({ message: 'Not Found' }, 404);
    }
    const { variables } = JSON.parse(init?.body ?? '{}');
    const base = `${variables.owner}/${variables.name}`;
    const pull = pulls.find((p) => p.base === base && p.number === variables.number);
    return jsonResponse({
      data: { viewer: { login: 'me' }, repository: { pullRequest: pull ? node(pull) : null } },
    });
  };
}

/** The pull request the extension finds for `branch` in `repo`, as "owner/name#n". */
async function lookUp(repo: string, branch: string, pulls: OpenPull[]): Promise<string> {
  const config = parseGitConfig(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'));
  const plan = pullRequestRemotes(config, branch);
  if (!plan) return 'no plan';
  const { entries } = buildHostingEntries([], fakeGitHub(pulls));
  const found = await findBranchPullRequest(plan, {
    hostingFor: (remote) => {
      const url = remote.url ?? remote.pushUrl;
      return url === undefined ? undefined : hostingForUrl(entries, url);
    },
    credentialFor: async (_providerId, host) =>
      host === 'github.com' ? { token: 'SECRET' } : undefined,
  });
  return found ? `${found.pr.repo.owner}/${found.pr.repo.name}#${found.pr.number}` : 'none';
}

const ORG = 'https://github.com/org/project.git';
const ALICE = 'git@github.com:alice/project.git';

describe('a maintainer', () => {
  it('finds nothing for a branch started from another branch and not pushed yet', async () => {
    // git checkout -b records origin/develop as the upstream; the open
    // develop -> main release pull request is not this branch's.
    const repo = repository({ origin: { url: ORG, branches: ['main', 'develop'] } });
    git(repo, 'checkout', '-q', '-b', 'my-fix', 'origin/develop');
    const pulls = [{ base: 'org/project', number: 9, headOwner: 'org', branch: 'develop' }];
    expect(await lookUp(repo, 'my-fix', pulls)).toBe('none');
    git(repo, 'checkout', '-q', 'develop');
    expect(await lookUp(repo, 'develop', pulls)).toBe('org/project#9');
  });

  it("never gets a stranger's pull request from a branch of the same name", async () => {
    const repo = repository({ origin: { url: ORG, branches: ['main'] } });
    const pulls = [{ base: 'org/project', number: 3, headOwner: 'mallory', branch: 'main' }];
    expect(await lookUp(repo, 'main', pulls)).toBe('none');
  });
});

describe("a reviewer checking out a contributor's fork", () => {
  const alicesPull = [
    { base: 'org/project', number: 7, headOwner: 'alice', branch: 'feature' },
    { base: 'org/project', number: 8, headOwner: 'org', branch: 'feature' },
  ];

  it('with the GitHub Pull Requests extension finds the pull request it recorded', async () => {
    const repo = repository({
      origin: { url: ORG, branches: ['main'] },
      alice: { url: 'https://github.com/alice/project.git', branches: ['feature'] },
    });
    git(repo, 'checkout', '-q', '-b', 'pr/alice/7', 'alice/feature');
    git(repo, 'config', 'branch.pr/alice/7.github-pr-owner-number', 'org#project#7');
    expect(await lookUp(repo, 'pr/alice/7', alicesPull)).toBe('org/project#7');
  });

  it("with a remote for the fork, asks origin for the fork's branch", async () => {
    const repo = repository({
      origin: { url: ORG, branches: ['main'] },
      alice: { url: 'https://github.com/alice/project.git', branches: ['feature'] },
    });
    git(repo, 'checkout', '-q', '-b', 'feature', 'alice/feature');
    expect(await lookUp(repo, 'feature', alicesPull)).toBe('org/project#7');
  });

  it('with gh pr checkout of a fork it can push to', async () => {
    // gh records the fork by URL, as both the remote and the push remote.
    const repo = repository({ origin: { url: ORG, branches: ['main'] } });
    for (const branch of ['feature', 'alice/main']) {
      git(repo, 'checkout', '-q', '-b', branch);
      git(repo, 'config', `branch.${branch}.remote`, ALICE);
      git(repo, 'config', `branch.${branch}.pushRemote`, ALICE);
      git(repo, 'config', `branch.${branch}.merge`, `refs/heads/${branch.replace('alice/', '')}`);
    }
    expect(await lookUp(repo, 'feature', alicesPull)).toBe('org/project#7');
    // gh names a fork's default branch "<owner>/main" locally.
    const fromMain = [{ base: 'org/project', number: 11, headOwner: 'alice', branch: 'main' }];
    expect(await lookUp(repo, 'alice/main', fromMain)).toBe('org/project#11');
  });

  it('with gh pr checkout of a fork it cannot push to', async () => {
    const repo = repository({ origin: { url: ORG, branches: ['main'] } });
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'config', 'branch.feature.remote', 'origin');
    git(repo, 'config', 'branch.feature.pushRemote', 'origin');
    git(repo, 'config', 'branch.feature.merge', 'refs/pull/7/head');
    // Not #8: that is org's own branch of the same name.
    expect(await lookUp(repo, 'feature', alicesPull)).toBe('org/project#7');
    expect(await lookUp(repo, 'feature', [])).toBe('none');
  });
});

describe('a fork contributor', () => {
  it('finds their pull request in upstream once the branch is pushed', async () => {
    const repo = repository({
      origin: { url: ALICE, branches: ['main'] },
      upstream: { url: ORG, branches: ['main'] },
    });
    const pulls = [
      { base: 'org/project', number: 5, headOwner: 'alice', branch: 'main' },
      { base: 'org/project', number: 6, headOwner: 'alice', branch: 'fix' },
    ];
    // Started from their fork's main, which has a pull request of its own.
    git(repo, 'checkout', '-q', '-b', 'fix', 'origin/main');
    expect(await lookUp(repo, 'fix', pulls.slice(0, 1))).toBe('none');
    // git push -u origin fix
    git(repo, 'update-ref', 'refs/remotes/origin/fix', 'HEAD');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/fix');
    expect(await lookUp(repo, 'fix', pulls)).toBe('org/project#6');
  });
});
