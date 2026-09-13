import { governedFetch } from '../rateLimiter.js';
import type { FetchLike } from '../http.js';
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
import { CachedIdentity, mergeByRole, p, Path, ProviderClient, segments } from './client.js';
import { assertPlainHost, base64Encode } from './shared.js';

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
  private readonly client: ProviderClient;
  private readonly profile = new CachedIdentity<string>();

  constructor(options: AzureDevOpsProviderOptions) {
    this.id = options.id ?? 'azuredevops';
    // The organization is the first path segment of every credentialed
    // request, so it is restricted to the same bare-label form a hostname has.
    this.organization = assertPlainHost(options.organization, 'Azure DevOps organization');
    this.project = options.project;
    this.client = new ProviderClient({
      name: 'Azure DevOps',
      baseUrl: options.baseUrl ?? 'https://dev.azure.com',
      baseUrlLabel: 'Azure DevOps baseUrl',
      headers: { accept: 'application/json' },
      // The PAT goes in as basic auth with an empty username.
      authorize: (auth) => `Basic ${base64Encode(`:${auth.token}`)}`,
      fetchFn: options.fetchFn ?? governedFetch,
    });
    this.host = this.client.host;
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
      ? p`/${this.organization}/${this.project}`
      : p`/${this.organization}`;
    const criteria = p`searchCriteria.status=active&$top=${limit}`;
    const base = p`${scope}/_apis/git/pullrequests?${criteria}&api-version=${API_VERSION}`;
    const [authored, reviewing] = await Promise.all([
      this.pullRequests(auth, p`${base}&searchCriteria.creatorId=${me}`),
      this.pullRequests(auth, p`${base}&searchCriteria.reviewerId=${me}`),
    ]);
    return mergeByRole(
      authored.map((pr) => this.mapPullRequest(pr, 'author')),
      reviewing.map((pr) => this.mapPullRequest(pr, 'reviewer')),
      (pr) => pr.number,
      limit
    );
  }

  private async pullRequests(auth: AuthContext, path: Path): Promise<AdoPullRequest[]> {
    const json = await this.client.getJson<{ value?: AdoPullRequest[] }>(auth, path);
    return json?.value ?? [];
  }

  async getPullRequestForBranch(
    auth: AuthContext,
    repo: RepoDescriptor,
    branch: string
  ): Promise<PullRequest | undefined> {
    // repo.owner is "organization/project", so it spans two path segments.
    const repoPath = p`/${segments(repo.owner)}/_apis/git/repositories/${repo.name}`;
    const ref = `refs/heads/${branch}`;
    const criteria = p`searchCriteria.status=active&searchCriteria.sourceRefName=${ref}`;
    const prs = await this.pullRequests(
      auth,
      p`${repoPath}/pullrequests?${criteria}&api-version=${API_VERSION}`
    );
    const pr = prs[0];
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
    const json = await this.client.getJson<{ id?: number; fields?: Record<string, unknown> }>(
      auth,
      p`/${this.organization}/_apis/wit/workitems/${number}?api-version=${API_VERSION}`
    );
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
      url: `${this.client.baseUrl}/${this.organization}/${encodeURIComponent(
        project
      )}/_workitems/edit/${json.id ?? number}`,
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
        `${this.client.baseUrl}/${this.organization}/${encodeURIComponent(projectName)}` +
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
    return this.profile.get(auth.token, async () => {
      const json = await this.client.getJson<{ authenticatedUser?: { id?: string } }>(
        auth,
        p`/${this.organization}/_apis/connectionData`
      );
      const id = json?.authenticatedUser?.id;
      if (!id) {
        throw new Error('Azure DevOps connectionData returned no authenticated user');
      }
      return id;
    });
  }
}
