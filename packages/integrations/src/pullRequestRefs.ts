/**
 * Pull request references in commit messages: what each forge writes into
 * the commits its pull requests produce, and the web URL of a pull request.
 * Offline string work, so it serves surfaces that must not touch the network.
 */

import type { RepoDescriptor } from './models.js';

type MessagePart = 'subject' | 'body';

const GITHUB_PULL_REQUESTS: [RegExp, MessagePart][] = [
  // Merge commits: "Merge pull request #12 from owner/branch".
  [/^Merge pull request #(\d+) from /, 'subject'],
  // Squash merges: "Subject (#12)".
  [/\(#(\d+)\)\s*$/, 'subject'],
];

/** What each forge writes into the commits its pull requests produce. A
 *  pattern applies only to its own forge: "#12" names an issue on GitLab,
 *  for one. */
const PULL_REQUEST_MESSAGES: Record<string, [RegExp, MessagePart][]> = {
  github: GITHUB_PULL_REQUESTS,
  'github-enterprise': GITHUB_PULL_REQUESTS,
  // "See merge request group/project!12" closes a merge commit's message.
  gitlab: [[/^See merge request \S+!(\d+)\s*$/m, 'body']],
  // "Merged in branch (pull request #12)".
  bitbucket: [[/\(pull request #(\d+)\)/, 'subject']],
  // "Pull request #12: Title", or "Merge pull request #12 in PROJ/repo from …".
  bitbucketDC: [
    [/^Pull request #(\d+): /, 'subject'],
    [/^Merge pull request #(\d+) in /, 'subject'],
  ],
  // "Merged PR 12: Title".
  azuredevops: [[/^Merged PR (\d+):/, 'subject']],
};

/** Where a commit message names a pull request in its forge's own words. */
export interface PullRequestMention {
  number: number;
  /** The part of the message holding the words. */
  part: MessagePart;
  /** Offsets of the words in that part, e.g. of "(pull request #12)". */
  start: number;
  end: number;
}

/** The pull request a commit message names, and where, in the words the
 *  forge hosting the repository (`providerId`) writes itself. */
export function pullRequestMention(
  providerId: string,
  subject: string,
  body: string,
): PullRequestMention | undefined {
  for (const [pattern, part] of PULL_REQUEST_MESSAGES[providerId] ?? []) {
    const match = pattern.exec(part === 'subject' ? subject : body);
    if (match) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value > 0) {
        return { number: value, part, start: match.index, end: match.index + match[0].length };
      }
    }
  }
  return undefined;
}

/** The pull request number a commit message names, in the words the forge
 *  hosting the repository (`providerId`) writes itself. */
export function pullRequestNumber(
  providerId: string,
  subject: string,
  body: string,
): number | undefined {
  return pullRequestMention(providerId, subject, body)?.number;
}

/**
 * True when the forge numbers pull requests and issues in one sequence, so
 * "#12" may name a pull request. On GitLab, Bitbucket and Azure DevOps it
 * names an issue (or work item) whatever the pull requests are numbered.
 */
export function issuesSharePullRequestNumbers(providerId: string): boolean {
  return providerId === 'github' || providerId === 'github-enterprise';
}

function encodePath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment !== '')
    .map(encodeURIComponent)
    .join('/');
}

/** Web URL of pull request `number` on the forge hosting `repo`. */
export function pullRequestUrl(
  providerId: string,
  repo: RepoDescriptor,
  number: number,
): string | undefined {
  const owner = encodePath(repo.owner);
  const name = encodePath(repo.name);
  switch (providerId) {
    case 'github':
    case 'github-enterprise':
      return `https://${repo.host}/${owner}/${name}/pull/${number}`;
    case 'gitlab':
      return `https://${repo.host}/${owner}/${name}/-/merge_requests/${number}`;
    case 'bitbucket':
      return `https://${repo.host}/${owner}/${name}/pull-requests/${number}`;
    case 'bitbucketDC':
      return `https://${repo.host}/projects/${owner}/repos/${name}/pull-requests/${number}`;
    case 'azuredevops':
      return `https://${repo.host}/${owner}/_git/${name}/pullrequest/${number}`;
    default:
      return undefined;
  }
}
