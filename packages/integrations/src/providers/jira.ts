import { governedFetch } from '../rateLimiter.js';
import { AuthError, NotSupportedError } from '../errors.js';
import type { FetchLike } from '../http.js';
import type { AuthContext, IssueProvider, IssueQueryOptions } from '../hostingProvider.js';
import type { Account, AutolinkPattern, Issue } from '../models.js';
import { p, ProviderClient } from './client.js';
import { assertPlainHost, base64Encode, slugify } from './shared.js';

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

  private readonly client: ProviderClient;

  constructor(options: JiraProviderOptions = {}) {
    this.id = options.id ?? 'jira';
    // `site` is documented as a bare site name and is interpolated into the
    // base URL, so a value like "evil.example/x" would redirect credentialed
    // requests. baseUrl stays free-form for self-hosted instances.
    const site = options.site ? assertPlainHost(options.site, 'Jira site') : undefined;
    const baseUrl = options.baseUrl ?? (site ? `https://${site}.atlassian.net` : undefined);
    if (!baseUrl) {
      throw new Error('JiraProvider requires either a site name or a baseUrl');
    }
    // Basic auth sends a reversible credential, so the transport must be
    // encrypted.
    this.client = new ProviderClient({
      name: 'Jira',
      baseUrl,
      baseUrlLabel: 'Jira baseUrl',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      authorize: (auth) => {
        if (!auth.username) {
          throw new AuthError('Jira requires the account email in AuthContext.username');
        }
        return `Basic ${base64Encode(`${auth.username}:${auth.token}`)}`;
      },
      fetchFn: options.fetchFn ?? governedFetch,
    });
    this.baseUrl = this.client.baseUrl;
    this.autolinkPattern = {
      regex: JIRA_ISSUE_KEY_REGEX,
      urlTemplate: `${this.baseUrl}/browse/$1`,
      title: 'Jira issue',
    };
  }

  async getMyIssues(auth: AuthContext, opts?: IssueQueryOptions): Promise<Issue[]> {
    const json = await this.client.postJsonOptional<{ issues?: JiraIssuePayload[] }>(
      auth,
      p`/rest/api/3/search/jql`,
      {
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        fields: ISSUE_FIELDS,
        maxResults: opts?.limit ?? 50,
      }
    );
    return (json?.issues ?? []).map((issue) => this.mapIssue(issue));
  }

  async getIssue(auth: AuthContext, key: string): Promise<Issue | undefined> {
    const json = await this.client.getJson<JiraIssuePayload>(
      auth,
      p`/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`
    );
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

  /**
   * Attaches the branch to the issue as a remote link (POST
   * /rest/api/3/issue/{key}/remotelink) titled "branch: <name>", making the
   * branch visible on the issue even when the Jira dev panel has no
   * repository integration. Remote links require a valid URL, so when
   * `branch.url` is absent the call is skipped and a NotSupportedError is
   * thrown for the caller to handle.
   */
  async createBranchLink(
    auth: AuthContext,
    issue: Issue,
    branch: { name: string; url?: string }
  ): Promise<void> {
    if (!branch.url) {
      throw new NotSupportedError('branch URL required');
    }
    await this.client.postJsonOptional(auth, p`/rest/api/3/issue/${issue.key}/remotelink`, {
      object: { url: branch.url, title: `branch: ${branch.name}` },
    });
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
}
