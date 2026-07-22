import { defaultFetch, type FetchLike } from '../http.js';
import type {
  AuthContext,
  HostingCapability,
  HostingProvider,
  PullRequestQueryOptions,
} from '../hostingProvider.js';
import type {
  Account,
  Issue,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ReviewDecision,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import { hostOfUrl, throwForStatus } from './shared.js';

export interface BitbucketDCProviderOptions {
  /** Instance base URL, e.g. "https://git.corp.example". Required. */
  baseUrl: string;
  /** Provider id used in RepoDescriptors. Default "bitbucket-dc". */
  id?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface DCUser {
  name: string;
  slug?: string;
  displayName?: string;
  emailAddress?: string;
}

interface DCReviewer {
  user: DCUser;
  approved?: boolean;
  status?: 'APPROVED' | 'UNAPPROVED' | 'NEEDS_WORK';
}

interface DCRef {
  id: string;
  displayId: string;
  latestCommit?: string;
  repository?: { slug: string; project?: { key: string } };
}

interface DCPullRequest {
  id: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  draft?: boolean;
  author?: { user: DCUser };
  reviewers?: DCReviewer[];
  fromRef: DCRef;
  toRef: DCRef;
  createdDate: number;
  updatedDate?: number;
  links?: { self?: Array<{ href?: string }> };
}

function mapState(state: DCPullRequest['state']): PullRequestState {
  switch (state) {
    case 'OPEN':
      return 'open';
    case 'MERGED':
      return 'merged';
    default:
      return 'closed';
  }
}

function mapReviewDecision(reviewers: DCReviewer[]): ReviewDecision {
  if (reviewers.some((r) => r.status === 'NEEDS_WORK')) {
    return 'changes_requested';
  }
  if (reviewers.some((r) => r.status === 'APPROVED' || r.approved === true)) {
    return 'approved';
  }
  return 'review_required';
}

function mapAccount(user: DCUser | undefined): Account {
  if (!user) {
    return { id: 'unknown', username: 'unknown' };
  }
  return {
    id: user.slug ?? user.name,
    username: user.name,
    name: user.displayName,
  };
}

/**
 * Bitbucket Data Center / Server hosting provider (REST API 1.0 style at
 * `{baseUrl}/rest/api/1.0`). Uses the dashboard endpoint to gather PRs the
 * user authors or reviews. The 1.0 API exposes no mergeability signal on PR
 * listings, so mergeable is always "unknown"; build status lives on a
 * separate API and is not fetched (checksStatus is left unset).
 */
export class BitbucketDCProvider implements HostingProvider {
  readonly id: string;
  readonly host: string;
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
    'reviews',
  ]);

  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: BitbucketDCProviderOptions) {
    this.id = options.id ?? 'bitbucket-dc';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.host = hostOfUrl(this.baseUrl);
    this.fetchFn = options.fetchFn ?? defaultFetch;
  }

  matchesRemote(remoteUrl: string): RepoDescriptor | undefined {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed || parsed.host !== this.host) {
      return undefined;
    }
    // HTTPS clone URLs carry an "scm/" path prefix that is not part of the project key.
    const owner = parsed.owner.replace(/^scm\//i, '');
    return { provider: this.id, host: parsed.host, owner, name: parsed.name };
  }

  async getMyPullRequests(
    auth: AuthContext,
    opts?: PullRequestQueryOptions
  ): Promise<PullRequest[]> {
    const limit = opts?.limit ?? 50;
    const [authored, reviewing] = await Promise.all([
      this.get(auth, `/dashboard/pull-requests?state=OPEN&role=AUTHOR&limit=${limit}`),
      this.get(auth, `/dashboard/pull-requests?state=OPEN&role=REVIEWER&limit=${limit}`),
    ]);
    const results = new Map<number, PullRequest>();
    for (const pr of ((authored as { values?: DCPullRequest[] } | undefined)?.values ?? [])) {
      results.set(pr.id, this.mapPullRequest(pr, 'author'));
    }
    for (const pr of ((reviewing as { values?: DCPullRequest[] } | undefined)?.values ?? [])) {
      if (!results.has(pr.id)) {
        results.set(pr.id, this.mapPullRequest(pr, 'reviewer'));
      }
    }
    return [...results.values()].slice(0, limit);
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined> {
    const json = (await this.get(
      auth,
      `/projects/${encodeURIComponent(repo.owner)}/repos/${encodeURIComponent(repo.name)}` +
        `/pull-requests?state=OPEN&direction=OUTGOING&at=${encodeURIComponent(
          `refs/heads/${branch}`
        )}`
    )) as { values?: DCPullRequest[] } | undefined;
    const pr = json?.values?.[0];
    return pr ? this.mapPullRequest(pr, 'none') : undefined;
  }

  /** Data Center has no issue tracker; numeric refs resolve to pull requests. */
  async getIssueOrPr(
    auth: AuthContext,
    repo: RepoDescriptor,
    ref: string
  ): Promise<Issue | PullRequest | undefined> {
    const number = Number(ref.replace(/^#/, ''));
    if (!Number.isInteger(number) || number <= 0) {
      return undefined;
    }
    const pr = (await this.get(
      auth,
      `/projects/${encodeURIComponent(repo.owner)}/repos/${encodeURIComponent(repo.name)}` +
        `/pull-requests/${number}`
    )) as DCPullRequest | undefined;
    return pr ? this.mapPullRequest(pr, 'none') : undefined;
  }

  private mapPullRequest(pr: DCPullRequest, viewerRole: ViewerRole): PullRequest {
    const projectKey = pr.fromRef.repository?.project?.key ?? '';
    const repoSlug = pr.fromRef.repository?.slug ?? '';
    const url =
      pr.links?.self?.[0]?.href ??
      `${this.baseUrl}/projects/${projectKey}/repos/${repoSlug}/pull-requests/${pr.id}`;
    return {
      id: String(pr.id),
      number: pr.id,
      title: pr.title,
      url,
      state: mapState(pr.state),
      draft: pr.draft ?? false,
      author: mapAccount(pr.author?.user),
      baseRef: pr.toRef.displayId,
      headRef: pr.fromRef.displayId,
      headSha: pr.fromRef.latestCommit ?? '',
      repo: {
        provider: this.id,
        host: this.host,
        owner: projectKey,
        name: repoSlug,
      },
      createdAt: new Date(pr.createdDate).toISOString(),
      updatedAt: new Date(pr.updatedDate ?? pr.createdDate).toISOString(),
      reviewDecision: mapReviewDecision(pr.reviewers ?? []),
      mergeable: 'unknown',
      viewerRole,
      reviewRequestedFromViewer: viewerRole === 'reviewer',
    };
  }

  /** REST GET against /rest/api/1.0; returns undefined on 404. */
  private async get(auth: AuthContext, path: string): Promise<unknown | undefined> {
    const response = await this.fetchFn(`${this.baseUrl}/rest/api/1.0${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${auth.token}`,
        accept: 'application/json',
        'user-agent': 'gitglasses',
      },
    });
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus('Bitbucket Data Center', response);
    return response.json();
  }
}
