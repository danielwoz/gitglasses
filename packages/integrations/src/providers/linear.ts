import { governedFetch } from '../rateLimiter.js';
import { ProviderError } from '../errors.js';
import type { FetchLike } from '../http.js';
import type { AuthContext, IssueProvider, IssueQueryOptions } from '../hostingProvider.js';
import type { Issue } from '../models.js';
import { ProviderClient } from './client.js';
import { slugify } from './shared.js';

export interface LinearProviderOptions {
  /** GraphQL endpoint. Default "https://api.linear.app/graphql". */
  apiUrl?: string;
  /** Provider id. Default "linear". */
  id?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName?: string | null;
  updatedAt: string;
  state?: { name?: string; type?: string } | null;
  assignee?: { id: string; name?: string; displayName?: string } | null;
}

interface LinearGraphQlData {
  viewer?: { assignedIssues?: { nodes?: LinearIssueNode[] } };
  issue?: LinearIssueNode | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  branchName
  updatedAt
  state { name type }
  assignee { id name displayName }
`;

const MY_ISSUES_QUERY = `
query MyIssues($first: Int!) {
  viewer {
    assignedIssues(
      first: $first
      filter: { state: { type: { nin: ["completed", "canceled"] } } }
      orderBy: updatedAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
}`;

const ISSUE_QUERY = `
query IssueByKey($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
  }
}`;

function mapIssue(node: LinearIssueNode): Issue {
  return {
    id: node.id,
    key: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state?.name ?? '',
    assignee: node.assignee
      ? {
          id: node.assignee.id,
          username: node.assignee.displayName ?? node.assignee.name ?? node.assignee.id,
          name: node.assignee.name,
        }
      : undefined,
    updatedAt: node.updatedAt,
    branchName: node.branchName ?? undefined,
  };
}

/**
 * Linear issue provider backed by the api.linear.app GraphQL endpoint.
 * Personal API keys go in the Authorization header verbatim (no Bearer).
 */
export class LinearProvider implements IssueProvider {
  readonly id: string;

  private readonly client: ProviderClient;

  constructor(options: LinearProviderOptions = {}) {
    this.id = options.id ?? 'linear';
    this.client = new ProviderClient({
      name: 'Linear',
      baseUrl: options.apiUrl ?? 'https://api.linear.app/graphql',
      baseUrlLabel: 'Linear apiUrl',
      authorize: (auth) => auth.token,
      fetchFn: options.fetchFn ?? governedFetch,
    });
  }

  async getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]> {
    const data = await this.client.graphql<LinearGraphQlData>(auth, MY_ISSUES_QUERY, {
      first: opts?.limit ?? 50,
    });
    const nodes = data.viewer?.assignedIssues?.nodes ?? [];
    return nodes.map(mapIssue);
  }

  async getIssue(auth: AuthContext, key: string): Promise<Issue | undefined> {
    let data: LinearGraphQlData;
    try {
      data = await this.client.graphql<LinearGraphQlData>(auth, ISSUE_QUERY, { id: key });
    } catch (error) {
      if (error instanceof ProviderError && /not found/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
    return data.issue ? mapIssue(data.issue) : undefined;
  }

  /**
   * Uses Linear's own branchName suggestion verbatim when present; otherwise
   * falls back to Linear's convention "<username>/<identifier>-<slug>" (the
   * username segment is omitted when there is no assignee to derive it from).
   */
  suggestBranchName(issue: Issue): string {
    if (issue.branchName) {
      return issue.branchName;
    }
    const stem = `${issue.key.toLowerCase()}-${slugify(issue.title, 40)}`.replace(/-+$/, '');
    const username = issue.assignee ? slugify(issue.assignee.username, 30) : '';
    return username ? `${username}/${stem}` : stem;
  }

  /**
   * No-op: Linear attaches branches (and their PRs) to issues automatically
   * when the branch name follows its branchName convention, which
   * suggestBranchName produces. Implemented so callers can invoke
   * createBranchLink uniformly across issue providers.
   */
  async createBranchLink(
    _auth: AuthContext,
    _issue: Issue,
    _branch: { name: string; url?: string }
  ): Promise<void> {
    // Intentionally empty.
  }
}
