/**
 * A line's story: the blame of one line, the commit that last changed it,
 * the pull requests that carried that commit, the issues they name, and the
 * line's earlier versions. The extension's Line Story panel and the MCP
 * server's git_line_story tool both assemble it here from their own sources
 * (engine requests, a hosting provider and its credentials), so the two say
 * the same thing. No vscode or engine dependency.
 *
 * Text from the forge (pull request titles and descriptions, issue titles) is
 * kept as plain data with bounded length; renderers must show it as text,
 * never as markup or instructions.
 */

import { matchAutolinks } from './autolinks.js';
import { AuthError, RateLimitError } from './errors.js';
import {
  supportsCommitPullRequests,
  type AuthContext,
  type HostingProvider,
} from './hostingProvider.js';
import type { AutolinkPattern, PullRequest, PullRequestState, RepoDescriptor } from './models.js';
import {
  issuesSharePullRequestNumbers,
  pullRequestMention,
  pullRequestNumber,
  pullRequestUrl,
} from './pullRequestRefs.js';

/** The sha blame reports for lines that are not committed yet. */
export const UNCOMMITTED = '0000000000000000000000000000000000000000';

/** Earlier versions a story lists unless the caller asks for another number. */
export const DEFAULT_STORY_VERSIONS = 10;

/** Characters of a pull request description a story keeps. */
export const DESCRIPTION_EXCERPT_CHARS = 600;

/** Characters of a forge-provided title a story keeps. */
export const TITLE_CHARS = 200;

/** Issue references a story lists. */
export const MAX_STORY_ISSUES = 10;

/** Issue references a story looks up on the forge for their title and state. */
export const MAX_RESOLVED_ISSUES = 5;

export interface StorySignature {
  name: string;
  email: string;
  /** Seconds since the Unix epoch. */
  time: number;
}

/** The blame of the line a story is about. */
export interface StoryBlame {
  /** The commit that last changed the line; UNCOMMITTED when it is not
   *  committed yet. */
  sha: string;
  /** 1-based line the story is about, in the file as it stands. */
  line: number;
  /** 1-based first line, and length, of the run of lines around `line` the
   *  same commit last changed. */
  hunkStart: number;
  hunkLines: number;
  /** The file's path in `sha`, which differs from today's after a rename. */
  path: string;
  /** The line's 1-based number in `path` at `sha`. */
  originalLine: number;
  /** Where the lines were before `sha`, when the file existed there. */
  previous?: { sha: string; path: string };
  author: StorySignature;
  committer: StorySignature;
  summary: string;
  /** The commit is at the edge of a shallow clone's history. */
  boundary: boolean;
}

/** The commit as a story needs it; the engine's commit details fit it. */
export interface StoryCommit {
  sha: string;
  parents: string[];
  author: StorySignature;
  committer: StorySignature;
  subject: string;
  body: string;
  trailers: { key: string; value: string }[];
}

/** One earlier version of the line: a commit that changed it, newest first. */
export interface StoryVersion {
  sha: string;
  author: StorySignature;
  summary: string;
  /** The file's path at that commit. */
  path: string;
  additions: number;
  deletions: number;
  /** That commit's diff of the line, as `git log -L` prints it. */
  patch?: string;
  patchTruncated?: boolean;
}

/** A pull request as a story shows it: bounded, with forge text as data. */
export interface StoryPullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: string;
  createdAt: string;
  mergedAt?: string;
  baseRef: string;
  headRef: string;
  /** The start of the description, HTML comments left out. */
  excerpt: string;
  /** The description goes on past the excerpt. */
  excerptTruncated: boolean;
  reviewCommentCount?: number;
  commentCount?: number;
}

/** A pull request the commit message names, found without the network. */
export interface NamedPullRequest {
  number: number;
  url: string;
}

/** Why a part of a story is left out. */
export type StoryUnavailable =
  /** The line has no commit yet. */
  | 'uncommitted'
  /** The workspace or repository is not trusted: no git runs and the forge is
   *  not asked. */
  | 'restricted'
  /** The engine has no git CLI, which line history needs. */
  | 'noGit';

/** One part of a story, filled in as its source answers. */
export type StorySection<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'unavailable'; reason: StoryUnavailable }
  | { state: 'failed'; message: string };

/** The forge hosting the repository, as a story names it. */
export interface StoryForgeLabel {
  providerId: string;
  host: string;
  /** Display name, e.g. "GitHub". */
  name: string;
  owner: string;
  repo: string;
}

/** The pull requests part of a story. */
export type StoryPullRequests =
  | { state: 'loading' }
  /** Not asked. `named` still comes from the message, offline. */
  | { state: 'unavailable'; reason: StoryUnavailable; named?: NamedPullRequest }
  /** No remote of the repository is on a forge GitGlasses knows. */
  | { state: 'noForge' }
  /** The forge is known but not connected: no credential to ask it with. */
  | { state: 'notConnected'; forge: StoryForgeLabel; named?: NamedPullRequest }
  /** The forge cannot look pull requests up by commit. */
  | { state: 'unsupported'; forge: StoryForgeLabel; named?: NamedPullRequest }
  /** The forge answered; `pullRequests` may be empty. `named` is set when
   *  the message names a pull request the answer does not list. */
  | {
      state: 'found';
      forge: StoryForgeLabel;
      pullRequests: StoryPullRequest[];
      named?: NamedPullRequest;
    }
  | {
      state: 'failed';
      forge: StoryForgeLabel;
      reason: 'auth' | 'rateLimit' | 'other';
      message: string;
      named?: NamedPullRequest;
    };

/** An issue reference found in the commit message or a pull request. */
export interface StoryIssue {
  /** The reference as written, e.g. "#12" or "PROJ-7". */
  ref: string;
  url: string;
  /** Where it was found. */
  source: 'commit' | 'pullRequest';
  /** From the forge, when it was asked: bounded, plain text. */
  title?: string;
  state?: string;
  /** The reference turned out to name a pull request. */
  pullRequest?: boolean;
}

export interface LineStory<C extends StoryCommit = StoryCommit> {
  /** Repo-relative path of the file, as it stands. */
  file: string;
  /** 1-based line. */
  line: number;
  /** The line's text, when the caller knows it. */
  lineText?: string;
  blame: StoryBlame;
  commit: StorySection<C>;
  pullRequests: StoryPullRequests;
  issues: StorySection<StoryIssue[]>;
  history: StorySection<{ versions: StoryVersion[]; more: boolean }>;
}

/** The forge a story asks for pull requests and issue titles. */
export type StoryForge =
  | { kind: 'none' }
  | {
      kind: 'hosted';
      label: StoryForgeLabel;
      provider: HostingProvider;
      repo: RepoDescriptor;
      /** Absent when the forge is not connected. */
      auth?: AuthContext;
    };

export interface LineStorySources<C extends StoryCommit> {
  /** The commit's details. */
  commit(sha: string): Promise<C>;
  /** The line's history from `rev`, newest first, at most `limit` entries,
   *  each with its diff; 'noGit' when the engine cannot list it. */
  history:
    | ((request: {
        path: string;
        rev: string;
        line: number;
        limit: number;
      }) => Promise<StoryVersion[]>)
    | 'noGit';
  /** Where pull requests and issue titles come from. */
  forge: StoryForge;
  /** Restricted Mode: the story is the blame and the commit. Neither git nor
   *  the forge is asked anything; offline links (autolinks, a pull request
   *  the message names) still show. */
  restricted?: boolean;
  /** Patterns linking issue references (autolinks). */
  issuePatterns: readonly AutolinkPattern[];
  /** Earlier versions to list; default DEFAULT_STORY_VERSIONS. */
  versions?: number;
  /** Logs failures the story reports only in passing. */
  log?(line: string): void;
}

export interface LineStoryInput {
  file: string;
  line: number;
  lineText?: string;
  blame: StoryBlame;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `text` cut to at most `max` characters at a word boundary, with "…". */
export function boundText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  const head = space > max / 2 ? cut.slice(0, space) : cut;
  return { text: `${head.trimEnd()}…`, truncated: true };
}

/** A one-line title: line breaks folded, bounded. */
export function storyTitle(text: string): string {
  return boundText(text.replace(/\s*[\r\n]+\s*/g, ' ').trim(), TITLE_CHARS).text;
}

/**
 * The start of a pull request description: HTML comments (where templates
 * keep their instructions) removed, trailing spaces and runs of blank lines
 * collapsed, then cut to `max` characters.
 */
export function descriptionExcerpt(
  body: string,
  max: number = DESCRIPTION_EXCERPT_CHARS,
): { text: string; truncated: boolean } {
  const cleaned = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return boundText(cleaned, max);
}

function storyPullRequest(pr: PullRequest): StoryPullRequest {
  const excerpt = descriptionExcerpt(pr.body ?? '');
  return {
    number: pr.number,
    title: storyTitle(pr.title),
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    author: pr.author.username,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
    reviewCommentCount: pr.reviewCommentCount,
    commentCount: pr.commentCount,
  };
}

/** The pull request the commit message names, by the forge's own wording. */
export function namedPullRequest(
  forge: StoryForge,
  commit: Pick<StoryCommit, 'subject' | 'body'> | undefined,
): NamedPullRequest | undefined {
  if (forge.kind !== 'hosted' || !commit) return undefined;
  const number = pullRequestNumber(forge.label.providerId, commit.subject, commit.body);
  if (number === undefined) return undefined;
  const url = pullRequestUrl(forge.label.providerId, forge.repo, number);
  return url === undefined ? undefined : { number, url };
}

/** The issue references in `texts`, deduplicated by URL, in order. */
export function issueReferences(
  texts: readonly { text: string; source: StoryIssue['source'] }[],
  patterns: readonly AutolinkPattern[],
  exclude: (match: { text: string; url: string }) => boolean = () => false,
): StoryIssue[] {
  const seen = new Set<string>();
  const issues: StoryIssue[] = [];
  for (const { text, source } of texts) {
    for (const match of matchAutolinks(text, patterns)) {
      if (seen.has(match.url) || exclude(match)) continue;
      seen.add(match.url);
      issues.push({ ref: match.text, url: match.url, source });
      if (issues.length >= MAX_STORY_ISSUES) return issues;
    }
  }
  return issues;
}

/** The number of `issue` when it is the forge repository's own "#N". */
function repoIssueNumber(issue: StoryIssue, repo: RepoDescriptor): number | undefined {
  const match = /^#(\d+)$/.exec(issue.ref);
  if (!match) return undefined;
  const expected = `https://${repo.host}/${repo.owner}/${repo.name}/issues/${match[1]}`;
  return issue.url === expected ? Number(match[1]) : undefined;
}

function failureReason(error: unknown): 'auth' | 'rateLimit' | 'other' {
  if (error instanceof AuthError) return 'auth';
  if (error instanceof RateLimitError) return 'rateLimit';
  return 'other';
}

/** `text` with the span `start`..`end` blanked out. */
function without(text: string, start: number, end: number): string {
  return `${text.slice(0, start)} ${text.slice(end)}`;
}

/**
 * Assembles the story of `input.blame`'s line from `sources`. Each part is
 * asked for at once; `onUpdate` sees the story every time a part arrives (the
 * extension renders progressively), and the promise resolves with it whole.
 * A part whose source fails is reported in that part, never as a rejection.
 */
export async function buildLineStory<C extends StoryCommit>(
  input: LineStoryInput,
  sources: LineStorySources<C>,
  onUpdate?: (story: LineStory<C>) => void,
): Promise<LineStory<C>> {
  const story: LineStory<C> = {
    file: input.file,
    line: input.line,
    lineText: input.lineText,
    blame: input.blame,
    commit: { state: 'loading' },
    pullRequests: { state: 'loading' },
    issues: { state: 'loading' },
    history: { state: 'loading' },
  };
  const publish = (): void => onUpdate?.({ ...story });

  if (input.blame.sha === UNCOMMITTED) {
    const uncommitted = { state: 'unavailable', reason: 'uncommitted' } as const;
    story.commit = uncommitted;
    story.pullRequests = uncommitted;
    story.issues = uncommitted;
    story.history = uncommitted;
    publish();
    return story;
  }
  publish();

  const { sha } = input.blame;
  const forge = sources.forge;

  const commit = sources
    .commit(sha)
    .then((details) => {
      story.commit = { state: 'ready', value: details };
      return details;
    })
    .catch((error: unknown) => {
      story.commit = { state: 'failed', message: errorText(error) };
      return undefined;
    })
    .finally(publish);

  const history = (async () => {
    if (sources.restricted || typeof sources.history === 'string') {
      story.history = { state: 'unavailable', reason: sources.restricted ? 'restricted' : 'noGit' };
      return;
    }
    const wanted = Math.max(sources.versions ?? DEFAULT_STORY_VERSIONS, 1);
    try {
      // One more than shown says whether there are more.
      const versions = await sources.history({
        path: input.blame.path,
        rev: sha,
        line: input.blame.originalLine,
        limit: wanted + 1,
      });
      story.history = {
        state: 'ready',
        value: { versions: versions.slice(0, wanted), more: versions.length > wanted },
      };
    } catch (error) {
      story.history = { state: 'failed', message: errorText(error) };
    }
  })().finally(publish);

  // The full descriptions, for the issue references in them; the story
  // itself keeps excerpts only.
  let pullRequests: PullRequest[] = [];
  const pulls = (async () => {
    if (forge.kind === 'none') {
      story.pullRequests = { state: 'noForge' };
      return;
    }
    const named = (): NamedPullRequest | undefined =>
      namedPullRequest(forge, story.commit.state === 'ready' ? story.commit.value : undefined);
    if (sources.restricted) {
      await commit;
      story.pullRequests = { state: 'unavailable', reason: 'restricted', named: named() };
      return;
    }
    if (!forge.auth) {
      await commit;
      story.pullRequests = { state: 'notConnected', forge: forge.label, named: named() };
      return;
    }
    if (!supportsCommitPullRequests(forge.provider)) {
      await commit;
      story.pullRequests = { state: 'unsupported', forge: forge.label, named: named() };
      return;
    }
    try {
      pullRequests = await forge.provider.getPullRequestsForCommit(forge.auth, forge.repo, sha);
      await commit;
      const fromMessage = named();
      const listed =
        fromMessage !== undefined && pullRequests.some((pr) => pr.number === fromMessage.number);
      story.pullRequests = {
        state: 'found',
        forge: forge.label,
        pullRequests: pullRequests.map(storyPullRequest),
        named: listed ? undefined : fromMessage,
      };
    } catch (error) {
      sources.log?.(`line story: pull requests for ${sha} failed: ${errorText(error)}`);
      await commit;
      story.pullRequests = {
        state: 'failed',
        forge: forge.label,
        reason: failureReason(error),
        message: errorText(error),
        named: named(),
      };
    }
  })().finally(publish);

  const issues = (async () => {
    const [details] = await Promise.all([commit, pulls]);
    if (!details) {
      story.issues = { state: 'ready', value: [] };
      return;
    }
    let { subject, body } = details;
    const prNumbers = new Set<number>();
    if (forge.kind === 'hosted') {
      // The words the forge writes for its own pull request ("(#12)",
      // "(pull request #12)") name no issue.
      const mention = pullRequestMention(forge.label.providerId, subject, body);
      if (mention?.part === 'subject') subject = without(subject, mention.start, mention.end);
      if (mention?.part === 'body') body = without(body, mention.start, mention.end);
      // Where pull requests and issues share their numbers (GitHub), a "#N"
      // naming one of the pull requests above is that pull request. Elsewhere
      // "#N" is an issue, whatever number the pull requests have.
      if (issuesSharePullRequestNumbers(forge.label.providerId)) {
        for (const pr of pullRequests) prNumbers.add(pr.number);
        if (mention) prNumbers.add(mention.number);
      }
    }
    const texts: { text: string; source: StoryIssue['source'] }[] = [
      { text: subject, source: 'commit' },
      { text: body, source: 'commit' },
    ];
    for (const pr of pullRequests) {
      texts.push({ text: pr.title, source: 'pullRequest' });
      texts.push({ text: descriptionExcerpt(pr.body ?? '', Infinity).text, source: 'pullRequest' });
    }
    const found = issueReferences(texts, sources.issuePatterns, (match) => {
      const number = /^#(\d+)$/.exec(match.text)?.[1];
      return number !== undefined && prNumbers.has(Number(number));
    });
    if (!sources.restricted && forge.kind === 'hosted' && forge.auth) {
      const { auth, provider, repo } = forge;
      const lookups = found
        .map((issue) => ({ issue, number: repoIssueNumber(issue, repo) }))
        .filter(
          (entry): entry is { issue: StoryIssue; number: number } => entry.number !== undefined,
        )
        .slice(0, MAX_RESOLVED_ISSUES);
      await Promise.all(
        lookups.map(async ({ issue, number }) => {
          try {
            const resolved = await provider.getIssueOrPr(auth, repo, String(number));
            if (!resolved) return;
            issue.title = storyTitle(resolved.title);
            issue.state = resolved.state;
            if ('headSha' in resolved) issue.pullRequest = true;
          } catch (error) {
            sources.log?.(`line story: looking up ${issue.ref} failed: ${errorText(error)}`);
          }
        }),
      );
    }
    story.issues = { state: 'ready', value: found };
  })()
    .catch((error: unknown) => {
      story.issues = { state: 'failed', message: errorText(error) };
    })
    .finally(publish);

  await Promise.all([commit, history, pulls, issues]);
  return { ...story };
}
