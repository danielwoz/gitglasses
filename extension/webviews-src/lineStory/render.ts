// Line Story panel rendering: the line, its blame, the commit (drawn by the
// commit details view the graph and the Commit Details panel use), the pull
// requests, the linked issues and the earlier versions with their diffs.
// Repository and forge text only ever reaches the DOM through textContent,
// never as markup; links are buttons the host opens after checking them.

import { shortSha } from '@gitglasses/protocol/sha';
import type {
  StoryIssue,
  StoryPullRequest,
  StoryPullRequests,
  StoryVersion,
} from '@gitglasses/integrations';
import { renderDetails } from '../graph/details';
import { relativeTime } from '../graph/graphLogic';
import type { LineStoryToHostMessage, LineStoryView } from './ipc';
import {
  blameFacts,
  diffRows,
  historyNotice,
  type Notice,
  previousPathOf,
  pullRequestFacts,
  pullRequestNotice,
  pullRequestStateLabel,
  sectionNotice,
} from './lineStoryLogic';

type Post = (message: LineStoryToHostMessage) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  label: string,
  className: string,
  onClick: () => void,
  title?: string,
): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  if (title) node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

function link(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  return button(label, 'story-link', onClick, title);
}

function absoluteDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function section(id: string, heading: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'story-section');
  root.setAttribute('aria-labelledby', id);
  const title = el('h2', 'story-heading', heading);
  title.id = id;
  const body = el('div', 'story-body');
  root.append(title, body);
  return { root, body };
}

function notice(container: HTMLElement, note: Notice | undefined, post: Post): void {
  if (!note) return;
  const box = el('p', 'story-notice', note.text);
  if (note.action) {
    const { label, message } = note.action;
    box.append(
      ' ',
      button(label, 'story-button', () => post({ type: message })),
    );
  }
  container.append(box);
}

/** Renders the loading state of a story about `file`. */
export function renderLoading(container: HTMLElement, file: string): void {
  container.replaceChildren(el('p', 'story-notice', `Reading the story of ${file}…`));
}

/** Renders why no story can be told. */
export function renderError(container: HTMLElement, message: string, post: Post): void {
  const box = el('div', 'story-error');
  box.append(
    el('p', undefined, message),
    button('Try Again', 'story-button', () => post({ type: 'refresh' })),
  );
  container.replaceChildren(box);
}

/** Renders `view` into `container`, replacing what was there. */
export function renderStory(container: HTMLElement, view: LineStoryView, post: Post): void {
  const { story } = view;
  const blame = story.blame;
  container.replaceChildren();

  const header = el('header', 'story-header');
  const title = el('h1', 'story-title');
  title.append(
    'Why ',
    link(`${view.file}:${story.line}`, () => post({ type: 'openLine' }), 'Go to the line'),
    '?',
  );
  header.append(
    title,
    button('Refresh', 'story-button', () => post({ type: 'refresh' }), 'Read the story again'),
  );
  container.append(header);
  if (story.lineText !== undefined) {
    const line = el('pre', 'story-line');
    line.append(
      el('span', 'story-line-number', String(story.line)),
      el('code', undefined, story.lineText),
    );
    container.append(line);
  }

  if (story.commit.state === 'unavailable' && story.commit.reason === 'uncommitted') {
    const part = section('story-blame', 'Not committed yet');
    notice(
      part.body,
      {
        text: 'This line has changes that are not committed yet, so it has no story to tell.',
        action: { label: 'Open Changes', message: 'openWorkingChanges' },
      },
      post,
    );
    container.append(part.root);
    return;
  }

  // Blame: who last changed the line, and when.
  const who = section('story-blame', 'Last changed');
  const facts = el('p', 'story-facts');
  const author = el('strong', undefined, blame.author.name);
  author.title = blame.author.email;
  const date = el('span', undefined, blameFacts(blame, view.file).join(' · '));
  date.title = absoluteDate(blame.author.time);
  facts.append(
    author,
    ' in ',
    link(
      shortSha(blame.sha),
      () => post({ type: 'showCommit', sha: blame.sha }),
      'Show Commit Details',
    ),
    ' · ',
    date,
  );
  who.body.append(facts);
  container.append(who.root);

  // The commit, by the shared commit details view.
  const commitPart = section('story-commit', 'Commit');
  if (story.commit.state === 'ready') {
    const details = el('div', 'story-commit');
    renderDetails(
      details,
      { kind: 'commit', details: story.commit.value },
      {
        post,
        canMutate: false,
      },
    );
    commitPart.body.append(details);
  } else {
    notice(commitPart.body, { text: sectionNotice(story.commit, 'the commit') ?? '' }, post);
  }
  container.append(commitPart.root);

  container.append(renderPullRequests(story.pullRequests, post));
  container.append(renderIssues(story.issues, post));
  container.append(renderHistory(story.history, story.blame.path, post));
}

function renderPullRequests(prs: StoryPullRequests, post: Post): HTMLElement {
  const listed = prs.state === 'found' ? prs.pullRequests : [];
  const part = section('story-prs', listed.length > 1 ? 'Pull requests' : 'Pull request');
  for (const pr of listed) part.body.append(pullRequestCard(pr, post));
  notice(part.body, pullRequestNotice(prs), post);
  const named = 'named' in prs ? prs.named : undefined;
  if (named) {
    const line = el('p', 'story-notice');
    line.append(
      'The commit message names ',
      link(
        `pull request #${named.number}`,
        () => post({ type: 'openUrl', url: named.url }),
        named.url,
      ),
      '.',
    );
    part.body.append(line);
  }
  return part.root;
}

function pullRequestCard(pr: StoryPullRequest, post: Post): HTMLElement {
  const card = el('article', 'story-pr');
  const head = el('div', 'story-pr-head');
  const state = pullRequestStateLabel(pr);
  head.append(
    el('span', `story-chip story-chip-${state.toLowerCase()}`, state),
    link(`#${pr.number} ${pr.title}`, () => post({ type: 'openUrl', url: pr.url }), pr.url),
  );
  card.append(head, el('div', 'story-muted', pullRequestFacts(pr).join(' · ')));
  if (pr.excerpt) {
    const excerpt = el('blockquote', 'story-excerpt', pr.excerpt);
    excerpt.setAttribute('aria-label', 'Start of the description');
    card.append(excerpt);
    if (pr.excerptTruncated) {
      card.append(
        link('Read the full description', () => post({ type: 'openUrl', url: pr.url }), pr.url),
      );
    }
  }
  return card;
}

function renderIssues(issues: LineStoryView['story']['issues'], post: Post): HTMLElement {
  const part = section('story-issues', 'Linked issues');
  if (issues.state !== 'ready') {
    notice(part.body, { text: sectionNotice(issues, 'the linked issues') ?? '' }, post);
    return part.root;
  }
  if (issues.value.length === 0) {
    notice(
      part.body,
      { text: 'The commit message and its pull request name no issue GitGlasses links.' },
      post,
    );
    return part.root;
  }
  const list = el('ul', 'story-issues');
  for (const issue of issues.value) list.append(issueItem(issue, post));
  part.body.append(list);
  return part.root;
}

function issueItem(issue: StoryIssue, post: Post): HTMLElement {
  const item = el('li');
  item.append(link(issue.ref, () => post({ type: 'openUrl', url: issue.url }), issue.url));
  if (issue.title) item.append(' ', el('span', undefined, issue.title));
  if (issue.state) {
    item.append(' ', el('span', `story-chip story-chip-${issue.state.toLowerCase()}`, issue.state));
  }
  if (issue.pullRequest) item.append(' ', el('span', 'story-muted', '(pull request)'));
  if (issue.source === 'pullRequest')
    item.append(' ', el('span', 'story-muted', 'named in the pull request'));
  return item;
}

function renderHistory(
  history: LineStoryView['story']['history'],
  blamedPath: string,
  post: Post,
): HTMLElement {
  const part = section('story-history', 'Earlier versions');
  const text = historyNotice(history);
  if (text) notice(part.body, { text }, post);
  if (history.state !== 'ready') return part.root;
  const list = el('ol', 'story-versions');
  for (const version of history.value.versions) list.append(versionItem(version, blamedPath, post));
  part.body.append(list);
  if (history.value.more) {
    part.body.append(
      el(
        'p',
        'story-muted',
        `Showing the ${history.value.versions.length} most recent versions of the line.`,
      ),
    );
  }
  return part.root;
}

function versionItem(version: StoryVersion, blamedPath: string, post: Post): HTMLElement {
  const item = el('li', 'story-version');
  const head = el('div', 'story-version-head');
  const when = el(
    'span',
    'story-muted',
    `${version.author.name}, ${relativeTime(version.author.time)}`,
  );
  when.title = absoluteDate(version.author.time);
  head.append(
    link(
      shortSha(version.sha),
      () => post({ type: 'showCommit', sha: version.sha }),
      'Show Commit Details',
    ),
    ' ',
    el('span', 'story-version-summary', version.summary),
    ' ',
    when,
  );
  if (version.path !== blamedPath)
    head.append(' ', el('span', 'story-muted', `in ${version.path}`));
  const previousPath = previousPathOf(version.patch, version.path);
  head.append(
    ' ',
    button(
      'Open Changes',
      'story-button story-button-small',
      () =>
        post({
          type: 'openVersion',
          target: { sha: version.sha, path: version.path, previousPath },
        }),
      `Open ${version.path} as ${shortSha(version.sha)} changed it`,
    ),
  );
  item.append(head);
  if (version.patch) {
    const diff = el('pre', 'story-diff');
    diff.setAttribute('aria-label', `Change to the line in ${shortSha(version.sha)}`);
    for (const row of diffRows(version.patch)) {
      diff.append(el('span', `story-diff-${row.kind}`, row.text), '\n');
    }
    if (version.patchTruncated) diff.append(el('span', 'story-diff-note', '…'));
    item.append(diff);
  }
  return item;
}
