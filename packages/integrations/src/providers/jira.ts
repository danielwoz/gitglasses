import { AuthError } from '../errors.js';
import { defaultFetch, type FetchLike } from '../http.js';
import type { AuthContext, IssueProvider, IssueQueryOptions } from '../hostingProvider.js';
import type { Account, AutolinkPattern, Issue } from '../models.js';
import { base64Encode, slugify, throwForStatus } from './shared.js';

export interface JiraProviderOptions {
  /** Cloud site name, e.g. "acme" for https://acme.atlassian.net. */
  site?: string;
  /** Full base URL; overrides `site` when both are given. */
  baseUrl?: string;
  /** Provider id. Default "jira". */
  id?: string;
  /** HTTP transport; defaults to the global fetch. Tests inject a stub here. */
  fetchFn?: FetchLike;
}

interface JiraUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

interface JiraIssuePayload {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    assignee?: JiraUser | null;
    updated?: string;
    issuetype?: { name?: string };
  };
}

const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'updated', 'issuetype'];

/** Matches Jira issue keys like "PROJ-42" in plain text. */
export const JIRA_ISSUE_KEY_REGEX = '([A-Z][A-Z0-9]+-\\d+)';

function mapAssignee(user: JiraUser | null | undefined): Account | undefined {
  if (!user) {
    return undefined;
  }
  return {
    id: user.accountId ?? user.displayName ?? 'unknown',
    username: user.emailAddress ?? user.displayName ?? 'unknown',
    name: user.displayName,
    avatarUrl: user.avatarUrls?.['48x48'],
  };
}

/**
 * Jira Cloud issue provider (REST v3). Authenticates with basic auth using
 * the account email (AuthContext.username) plus an API token.
 */
export class JiraProvider implements IssueProvider {
  readonly id: string;
  readonly baseUrl: string;
  /** Pattern turning "PROJ-42" style references into links on this site. */
  readonly autolinkPattern: AutolinkPattern;

  private readonly fetchFn: FetchLike;

  constructor(options: JiraProviderOptions = {}) {
    this.id = options.id ?? 'jira';
    const baseUrl = options.baseUrl ?? (options.site ? `https://${options.site}.atlassian.net` : undefined);
    if (!baseUrl) {
      throw new Error('JiraProvider requires either a site name or a baseUrl');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.autolinkPattern = {
      regex: JIRA_ISSUE_KEY_REGEX,
      urlTemplate: `${this.baseUrl}/browse/$1`,
      title: 'Jira issue',
    };
    this.fetchFn = options.fetchFn ?? defaultFetch;
  }

  async getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]> {
    const json = (await this.request(auth, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        fields: ISSUE_FIELDS,
        maxResults: opts?.limit ?? 50,
      }),
    })) as { issues?: JiraIssuePayload[] } | undefined;
    return (json?.issues ?? []).map((issue) => this.mapIssue(issue));
  }

  async getIssue(auth: AuthContext, key: string): Promise<Issue | undefined> {
    const json = (await this.request(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`
    )) as JiraIssuePayload | undefined;
    return json ? this.mapIssue(json) : undefined;
  }

  /**
   * Branch name of the form "<type>/<KEY>-<slug>": type is "fix" for bugs and
   * "feat" otherwise; the slug is the lowercased summary trimmed to 40 chars.
   */
  suggestBranchName(issue: Issue): string {
    const type = issue.type?.toLowerCase() === 'bug' ? 'fix' : 'feat';
    const slug = slugify(issue.title, 40);
    return slug ? `${type}/${issue.key}-${slug}` : `${type}/${issue.key}`;
  }

  private mapIssue(payload: JiraIssuePayload): Issue {
    const fields = payload.fields ?? {};
    return {
      id: payload.id,
      key: payload.key,
      title: fields.summary ?? '',
      url: `${this.baseUrl}/browse/${payload.key}`,
      state: fields.status?.name ?? '',
      assignee: mapAssignee(fields.assignee),
      updatedAt: fields.updated ?? '',
      type: fields.issuetype?.name,
    };
  }

  /** HTTP request; returns undefined on 404. */
  private async request(
    auth: AuthContext,
    path: string,
    init?: { method?: string; body?: string }
  ): Promise<unknown | undefined> {
    if (!auth.username) {
      throw new AuthError('Jira requires the account email in AuthContext.username');
    }
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Basic ${base64Encode(`${auth.username}:${auth.token}`)}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'gitglasses',
      },
      body: init?.body,
    });
    if (response.status === 404) {
      return undefined;
    }
    throwForStatus('Jira', response);
    return response.json();
  }
}
