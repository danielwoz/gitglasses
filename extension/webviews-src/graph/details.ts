// Commit details view: the full message, trailers, author and committer,
// parents, refs and changed files of one commit, the files between two
// commits, or the uncommitted changes. The graph's details pane and the
// Commit Details panel both render through here. Repository text only ever
// reaches the DOM through textContent, never as markup.

import './details.css';
import { shortSha } from '@gitglasses/protocol/sha';
import type {
  CommitFileChange,
  DetailsToHostMessage,
  DetailsView,
  FileChange,
  ProvenanceMark,
} from './ipc';
import { relativeTime } from './graphLogic';
import { bodyWithoutTrailers } from '../../src/system/trailers';
import {
  ChangeSummary,
  FileEntry,
  changeSummary,
  commitFileEntries,
  compareFileEntries,
  signatureLine,
  splitPath,
  statusLabel,
  wipFileEntries,
} from './detailsLogic';

/** Buttons the details view offers besides opening files, wired by the
 *  graph (stash and working-tree actions); the Commit Details panel leaves
 *  them out. */
export type DetailsAction = 'openScm' | 'stashChanges' | 'stashApply' | 'stashPop' | 'stashDrop';

export interface DetailsOptions {
  post(message: DetailsToHostMessage): void;
  /** Runs a graph action; absent where the view stands alone. */
  onAction?(action: DetailsAction, sha?: string): void;
  /** False in Restricted Mode: no buttons that change the repository. */
  canMutate: boolean;
  /** Closes the view (the graph's pane); absent where it cannot close. */
  onClose?(): void;
}

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

function absoluteDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Renders `view` into `container`, replacing what was there. */
export function renderDetails(
  container: HTMLElement,
  view: DetailsView | undefined,
  options: DetailsOptions,
): void {
  container.replaceChildren();
  if (!view) {
    container.append(el('div', 'details-empty', 'Loading…'));
    return;
  }
  switch (view.kind) {
    case 'commit':
      renderCommit(container, view, options);
      break;
    case 'compare':
      renderCompare(container, view, options);
      break;
    case 'wip':
      renderWip(container, view, options);
      break;
    case 'error':
      container.append(header(view.message, options), el('div', 'details-empty', view.message));
      container.querySelector('.details-subject')?.classList.add('details-error');
      break;
  }
}

function header(subject: string, options: DetailsOptions, ...actions: HTMLElement[]): HTMLElement {
  const bar = el('div', 'details-header');
  const title = el('div', 'details-subject', subject);
  title.title = subject;
  title.setAttribute('role', 'heading');
  title.setAttribute('aria-level', '2');
  const tools = el('div', 'details-tools');
  tools.append(...actions);
  if (options.onClose) {
    tools.append(button('✕', 'details-icon', options.onClose, 'Close Details (Escape)'));
  }
  bar.append(title, tools);
  return bar;
}

/** The declared provenance: its label, what declared it and, when the commit
 *  names one, a link to the agent session for the user to open. */
function provenanceValue(mark: ProvenanceMark): Node[] {
  const label = el('strong', undefined, mark.label);
  const via = el('span', 'details-muted', ` (declared via ${mark.via})`);
  const value = el('span', 'details-provenance');
  value.title = mark.lines.join('\n');
  value.append(label, via);
  if (mark.sessionUrl && /^https?:\/\//i.test(mark.sessionUrl)) {
    const link = el('a', 'details-link', 'session link');
    link.href = mark.sessionUrl;
    link.title = mark.sessionUrl;
    value.append(' · ', link);
  }
  return [value];
}

function copyButton(text: string, label: string, options: DetailsOptions): HTMLButtonElement {
  return button(
    label,
    'details-link',
    () => options.post({ type: 'copy', text, label }),
    `Copy ${text}`,
  );
}

function renderCommit(
  container: HTMLElement,
  view: Extract<DetailsView, { kind: 'commit' }>,
  options: DetailsOptions,
): void {
  const d = view.details;
  const actions: HTMLElement[] = [];
  if (view.stash && options.onAction && options.canMutate) {
    actions.push(
      button('Apply', 'details-button', () => options.onAction?.('stashApply', d.sha)),
      button('Pop', 'details-button', () => options.onAction?.('stashPop', d.sha)),
      button('Drop…', 'details-button', () => options.onAction?.('stashDrop', d.sha)),
    );
  }
  if (d.files.length > 0) {
    actions.push(
      button('Open All Changes', 'details-button', () =>
        options.post({ type: 'openChanges', target: { kind: 'commit', sha: d.sha } }),
      ),
    );
  }
  container.append(header(d.subject || '(no message)', options, ...actions));

  const body = el('div', 'details-body');
  const info = el('div', 'details-info');

  if (d.refs.length > 0 || view.stash) {
    const refs = el('div', 'details-refs');
    if (view.stash)
      refs.append(el('span', 'details-chip chip-stash', `stash@{${view.stash.index}}`));
    for (const ref of d.refs) refs.append(el('span', `details-chip chip-${ref.kind}`, ref.name));
    info.append(refs);
  }

  const meta = el('dl', 'details-meta');
  const row = (label: string, ...values: (string | Node)[]): void => {
    const dd = el('dd');
    dd.append(...values);
    meta.append(el('dt', undefined, label), dd);
  };
  const commitValue = el('span', 'details-mono', d.sha);
  row('Commit', commitValue, ' ', copyButton(d.sha, 'Copy', options));
  if (d.parents.length > 0) {
    const parents: Node[] = [];
    d.parents.forEach((parent, i) => {
      if (i > 0) parents.push(document.createTextNode(' '));
      const link = button(shortSha(parent), 'details-link details-mono', () =>
        options.post({ type: 'showCommit', sha: parent }),
      );
      link.title = `Show ${parent}`;
      parents.push(link);
    });
    row(d.parents.length > 1 ? 'Parents' : 'Parent', ...parents);
  }
  const author = el('span', undefined, signatureLine(d.author));
  const authored = el('span', 'details-muted', ` · ${relativeTime(d.author.time)}`);
  authored.title = absoluteDate(d.author.time);
  row('Author', author, authored);
  if (d.committer.name !== d.author.name || d.committer.email !== d.author.email) {
    row('Committer', signatureLine(d.committer));
  }
  if (d.committer.time !== d.author.time) {
    const committed = el('span', undefined, relativeTime(d.committer.time));
    committed.title = absoluteDate(d.committer.time);
    row('Committed', committed);
  }
  if (view.provenance) row('Provenance', ...provenanceValue(view.provenance));
  info.append(meta);

  // The trailers are listed below, so the message leaves them out.
  const message = bodyWithoutTrailers(d.body, d.trailers);
  if (message) info.append(el('div', 'details-message', message));
  if (d.trailers.length > 0) {
    const trailers = el('dl', 'details-trailers');
    for (const trailer of d.trailers) {
      trailers.append(el('dt', undefined, trailer.key), el('dd', undefined, trailer.value));
    }
    info.append(trailers);
  }

  const files = fileList(commitFileEntries(d.files), (entry) =>
    options.post({
      type: 'openFile',
      target: { kind: 'commit', sha: d.sha, file: entry.file as CommitFileChange },
    }),
  );
  const summary = changeSummary(d.files, d.stats.files);
  const filesPane = el('div', 'details-files');
  filesPane.append(
    filesHeading(summary, d.parents.length > 1 ? 'against the first parent' : undefined),
  );
  if (d.truncated) {
    filesPane.append(
      el(
        'div',
        'details-muted details-note',
        `Showing the first ${d.files.length} of ${d.stats.files} files.`,
      ),
    );
  }
  filesPane.append(files);
  body.append(info, filesPane);
  container.append(body);
}

function renderCompare(
  container: HTMLElement,
  view: Extract<DetailsView, { kind: 'compare' }>,
  options: DetailsOptions,
): void {
  const actions: HTMLElement[] = [];
  if (view.files.length > 0) {
    actions.push(
      button('Open All Changes', 'details-button', () =>
        options.post({
          type: 'openChanges',
          target: { kind: 'compare', base: view.base.sha, head: view.head.sha },
        }),
      ),
    );
  }
  container.append(
    header(
      `Comparing ${shortSha(view.base.sha)} … ${shortSha(view.head.sha)}`,
      options,
      ...actions,
    ),
  );
  const body = el('div', 'details-body');
  const info = el('div', 'details-info');
  const meta = el('dl', 'details-meta');
  for (const [label, side] of [
    ['From', view.base],
    ['To', view.head],
  ] as const) {
    const dd = el('dd');
    const link = button(shortSha(side.sha), 'details-link details-mono', () =>
      options.post({ type: 'showCommit', sha: side.sha }),
    );
    dd.append(link, ' ', el('span', undefined, side.subject));
    meta.append(el('dt', undefined, label), dd);
  }
  info.append(meta);
  const filesPane = el('div', 'details-files');
  filesPane.append(filesHeading(changeSummary(view.files, view.files.length)));
  filesPane.append(
    fileList(compareFileEntries(view.files), (entry) =>
      options.post({
        type: 'openFile',
        target: {
          kind: 'compare',
          base: view.base.sha,
          head: view.head.sha,
          file: entry.file as FileChange,
        },
      }),
    ),
  );
  body.append(info, filesPane);
  container.append(body);
}

function renderWip(
  container: HTMLElement,
  view: Extract<DetailsView, { kind: 'wip' }>,
  options: DetailsOptions,
): void {
  const actions: HTMLElement[] = [];
  if (options.onAction) {
    actions.push(
      button('Open Source Control', 'details-button', () => options.onAction?.('openScm')),
    );
    if (options.canMutate) {
      actions.push(button('Stash…', 'details-button', () => options.onAction?.('stashChanges')));
    }
  }
  container.append(header('Uncommitted Changes', options, ...actions));
  const body = el('div', 'details-body details-body-single');
  const filesPane = el('div', 'details-files');
  const groups = wipFileEntries(view);
  if (groups.length === 0) {
    filesPane.append(el('div', 'details-empty', 'No changes.'));
  }
  for (const group of groups) {
    filesPane.append(
      el('div', 'details-files-heading', `${group.title} (${group.entries.length})`),
    );
    filesPane.append(
      fileList(group.entries, (entry) => {
        const file = entry.file as FileChange;
        options.post({
          type: 'openFile',
          target: {
            kind: 'wip',
            path: file.path,
            origPath: file.origPath,
            status: file.status,
            untracked: group.untracked,
          },
        });
      }),
    );
  }
  body.append(filesPane);
  container.append(body);
}

function filesHeading(summary: ChangeSummary, note?: string): HTMLElement {
  const heading = el('div', 'details-files-heading');
  heading.append(
    el('span', undefined, summary.text),
    ...(summary.additions + summary.deletions > 0
      ? [
          el('span', 'stat-add', ` +${summary.additions}`),
          el('span', 'stat-del', ` −${summary.deletions}`),
        ]
      : []),
  );
  if (note) heading.append(el('span', 'details-muted', ` (${note})`));
  return heading;
}

function fileList(entries: FileEntry[], open: (entry: FileEntry) => void): HTMLElement {
  const list = el('ul', 'details-file-list');
  list.setAttribute('role', 'list');
  for (const entry of entries) {
    const item = el('li');
    const { name, dir } = splitPath(entry.path);
    const row = el('button', 'details-file');
    row.type = 'button';
    row.title = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path;
    row.setAttribute(
      'aria-label',
      `${statusLabel(entry.status)} ${entry.path}${entry.stats ? `, ${entry.stats}` : ''}`,
    );
    const status = el('span', `file-status status-${entry.status.toLowerCase()}`, entry.status);
    const label = el('span', 'file-name', name);
    const where = el('span', 'file-dir', entry.origPath ? `${entry.origPath} →` : dir);
    const stats = el('span', 'file-stats');
    if (entry.binary) stats.append(el('span', 'details-muted', 'binary'));
    else if (entry.additions !== undefined) {
      stats.append(
        el('span', 'stat-add', `+${entry.additions}`),
        ' ',
        el('span', 'stat-del', `−${entry.deletions}`),
      );
    }
    row.append(status, label, where, stats);
    row.addEventListener('click', () => open(entry));
    item.append(row);
    list.append(item);
  }
  return list;
}
