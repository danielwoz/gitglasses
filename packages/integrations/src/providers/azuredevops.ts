import { governedFetch } from '../rateLimiter.js';
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
  Mergeability,
  PullRequest,
  PullRequestState,
  RepoDescriptor,
  ReviewDecision,
  ViewerRole,
} from '../models.js';
import { parseRemoteUrl } from '../remoteMatcher.js';
import {
  assertPlainHost,
  assertSecureBaseUrl,
  base64Encode,
  hostOfUrl,
  throwForStatus,
  tokenFingerprint,
} from './shared.js';

const API_VERSION = '7.1';

export interface AzureDevOpsProviderOptions {
  /** Organization name (the first path segment on dev.azure.com). Required. */
  organization: string;
  /** Restrict queries to one project; account-wide queries otherwise. */
  project?: string;
  /** Service base URL. Default "https://dev.azure.com"; Server installs pass their own. */
  baseUrl?: string;
  /** Provider id used in RepoDescriptors. Default "azuredevops". */
  id?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface AdoIdentity {
  id: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
}

interface AdoReviewer extends AdoIdentity {
  vote?: number;
  isRequired?: boolean;
  isContainer?: boolean;
}

interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  isDraft?: boolean;
  createdBy?: AdoIdentity;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit?: { commitId?: string };
  mergeStatus?: string;
  reviewers?: AdoReviewer[];
  repository?: { name?: string; project?: { name?: string } };
  creationDate: string;
  closedDate?: string;
}

function mapState(status: AdoPullRequest['status']): PullRequestState {
  switch (status) {
    case 'active':
      return 'open';
    case 'completed':
      return 'merged';
    default:
      return 'closed';
  }
}

function mapMergeable(mergeStatus: string | undefined): Mergeability {
  switch (mergeStatus) {
    case 'succeeded':
      return 'mergeable';
    case 'conflicts':
      return 'conflicts';
    default:
      return 'unknown';
  }
}

/**
 * Review decision from reviewer votes: any rejection or wait-for-author vote
 * wins as changes_requested; approved when every required reviewer (or every
 * reviewer, when none is marked required) has voted +5 or better; otherwise
 * review is still required. Group (container) reviewers are ignored.
 */
function mapReviewDecision(reviewers: AdoReviewer[]): ReviewDecision | undefined {
  const people = reviewers.filter((r) => r.isContainer !== true);
  if (people.length === 0) {
    return undefined;
  }
  if (people.some((r) => (r.vote ?? 0) < 0)) {
    return 'changes_requested';
  }
  const required = people.filter((r) => r.isRequired === true);
  const pool = required.length > 0 ? required : people;
  if (pool.every((r) => (r.vote ?? 0) >= 5)) {
    return 'approved';
  }
  return 'review_required';
}

function mapAccount(identity: AdoIdentity | undefined): Account {
  if (!identity) {
    return { id: 'unknown', username: 'unknown' };
  }
  return {
    id: identity.id,
    username: identity.uniqueName ?? identity.displayName ?? identity.id,
    name: identity.displayName,
    avatarUrl: identity.imageUrl,
  };
}

function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Azure DevOps hosting provider (dev.azure.com or Azure DevOps Server via
 * baseUrl) backed by the Git REST API 7.x. The caller's identity is resolved
 * once through connectionData and cached per token. Auth is a PAT sent as
 * basic auth with an empty username. Repo owners are "org/project" as
 * produced by remoteMatcher for Azure remotes.
 */
export class AzureDevOpsProvider implements HostingProvider {
  readonly id: string;
  readonly host: string;
  readonly capabilities: ReadonlySet<HostingCapability> = new Set<HostingCapability>([
    'prs',
    'prForBranch',
    'reviews',
    'mergeability',
  ]);

  private readonly organization: string;
  private readonly project?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private cachedProfileId?: string;
  private cachedProfileToken?: string;

  constructor(options: AzureDevOpsProviderOptions) {
    this.id = options.id ?? 'azuredevops';
    // The organization is the first path segment of every credentialed
    // request, so it is restricted to the same bare-label form a hostname has.
    this.organization = assertPlainHost(options.organization, 'Azure DevOps organization');
    this.project = options.project;
    this.baseUrl = assertSecureBaseUrl(
      (options.baseUrl ?? 'https://dev.azure.com').replace(/\/+$/, ''),
      'Azure DevOps baseUrl'
    );
    this.host = hostOfUrl(this.baseUrl);
    this.fetchFn = options.fetchFn ?? governedFetch;
  }

  matchesRemote(remoteUrl: string): RepoDescriptor | undefined {
    const parsed = parseRemoteUrl(remoteUrl);
    if (!parsed || parsed.host !== this.host) {
      return undefined;
    }
    return { provider: this.id, ...parsed };
  }

  async getMyPullRequests(
    auth: AuthContext,
    opts?: PullRequestQueryOptions
  ): Promise<PullRequest[]> {
    const me = await this.profileId(auth);
    const limit = opts?.limit ?? 50;
    const scope = this.project
      ? `${this.organization}/${encodeURIComponent(this.project)}`
      : this.organization;
    const base =
      `/${scope}/_apis/git/pullrequests?searchCriteria.status=active` +
      `&$top=${limit}&api-version=${API_VERSION}`;
    const [authored, reviewing] = await Promise.all([
      this.get(auth, `${base}&searchCriteria.creatorId=${me}`),
      this.get(auth, `${base}&searchCriteria.reviewerId=${me}`),
    ]);
    const results = new Map<number, PullRequest>();
    for (const pr of ((authored as { value?: AdoPullRequest[] } | undefined)?.value ?? [])) {
      results.set(pr.pullRequestId, this.mapPullRequest(pr, 'author'));
    }
    for (const pr of ((reviewing as { value?: AdoPullRequest[] } | undefined)?.value ?? [])) {
      if (!results.has(pr.pullRequestId)) {
        results.set(pr.pullRequestId, this.mapPullRequest(pr, 'reviewer'));
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
      `/${repo.owner}/_apis/git/repositories/${encodeURIComponent(repo.name)}/pullrequests` +
        `?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(
          `refs/heads/${branch}`
        )}&api-version=${API_VERSION}`
    )) as { value?: AdoPullRequest[] } | undefined;
    const pr = json?.value?.[0];
    return pr ? this.mapPullRequest(pr, 'none') : undefined;
  }

  /** Numeric refs resolve to Azure Boards work items. */
  async getIssueOrPr(
    auth: AuthContext,
    repo: RepoDescriptor,
    ref: string
  ): Promise<Issue | PullRequest | undefined> {
    const number = Number(ref.replace(/^#/, ''));
    if (!Number.isInteger(number) || number <= 0) {
      return undefined;
    }
    const json = (await this.get(
      auth,
      `/${this.organization}/_apis/wit/workitems/${number}?api-version=${API_VERSION}`
    )) as { id?: number; fields?: Record<string, unknown> } | undefined;
    if (json === undefined) {
      return undefined;
    }
    const fields = json.fields ?? {};
    const project = String(fields['System.TeamProject'] ?? this.project ?? '');
    const assignedTo = fields['System.AssignedTo'] as AdoIdentity | undefined;
    return {
      id: String(json.id ?? number),
      key: `AB#${json.id ?? number}`,
      title: String(fields['System.Title'] ?? ''),
      url: `${this.baseUrl}/${this.organization}/${encodeURIComponent(project)}/_workitems/edit/${
        json.id ?? number
      }`,
      state: String(fields['System.State'] ?? ''),
      assignee: assignedTo ? mapAccount(assignedTo) : undefined,
      updatedAt: String(fields['System.ChangedDate'] ?? ''),
      type: fields['System.WorkItemType'] ? String(fields['System.WorkItemType']) : undefined,
    };
  }

  private mapPullRequest(pr: AdoPullRequest, viewerRole: ViewerRole): PullRequest {
    const projectName = pr.repository?.project?.name ?? this.project ?? '';
    const repoName = pr.repository?.name ?? '';
    return {
      id: String(pr.pullRequestId),
      number: pr.pullRequestId,
      title: pr.title,
      url:
        `${this.baseUrl}/${this.organization}/${encodeURIComponent(projectName)}` +
        `/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`,
      state: mapState(pr.status),
      draft: pr.isDraft ?? false,
      author: mapAccount(pr.createdBy),
      baseRef: stripRefPrefix(pr.targetRefName),
      headRef: stripRefPrefix(pr.sourceRefName),
      headSha: pr.lastMergeSourceCommit?.commitId ?? '',
      repo: {
        provider: this.id,
        host: this.host,
        owner: `${this.organization}/${projectName}`,
        name: repoName,
      },
      createdAt: pr.creationDate,
      // The list payload carries no updated timestamp; closedDate is the best signal.
      updatedAt: pr.closedDate ?? pr.creationDate,
      reviewDecision: mapReviewDecision(pr.reviewers ?? []),
      mergeable: mapMergeable(pr.mergeStatus),
      viewerRole,
      reviewRequestedFromViewer: viewerRole === 'reviewer',
    };
  }

  private async profileId(auth: AuthContext): Promise<string> {
    if (this.cachedProfileId !== undefined && this.cachedProfileToken === tokenFingerprint(auth.token)) {
      return this.cachedProfileId;
    }
    const json = (await this.get(
      auth,
      `/${this.organization}/_apis/connectionData`
    )) as { authenticatedUser?: { id?: string } } | undefined;
    const id = json?.authenticatedUser?.id;
    if (!id) {
      throw new Error('Azure DevOps connectionData returned no authenticated user');
    }
    this.cachedProfileId = id;
    this.cachedProfileToken = tokenFingerprint(auth.token);
    return id;
  }

  /** REST GET; returns undefined on 404. */
  private async get(auth: AuthContext, path: string): Promise<unknown | undefined> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Basic ${base64Encode(`:${auth.token}`)}`,
        accept: 'application/json',
        'user-agent': 'gitglasses',
      },
    });
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus('Azure DevOps', response);
    return response.json();
  }
}
