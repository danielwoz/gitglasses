// Commit graph webview bootstrap: DOM wiring, scrolling, selection, keyboard
// navigation, context menus, find, branch filter, the details pane and host
// messaging.

import './graph.css';
import { shortSha } from '@gitglasses/protocol/sha';
import type {
  BranchOption,
  DetailsTarget,
  DetailsView,
  GraphActionId,
  GraphRef,
  GraphRow,
  GraphViewState,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './ipc';
import {
  MenuItem,
  RefMenuAction,
  RowMenuAction,
  anchoredScrollTop,
  filterLabel,
  navigateIndex,
  nextMatch,
  reduceSelection,
  refChipAtPoint,
  refMenu,
  rowDate,
  rowAtY,
  rowMatchesQuery,
  rowMenu,
  visibleRange,
} from './graphLogic';
import { DetailsAction, renderDetails } from './details';
import {
  GraphRenderer,
  LANE_PADDING,
  OVERSCAN_ROWS,
  ROW_HEIGHT,
  readThemeColors,
} from './renderer';
import { GraphStore } from './store';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHostMessage): void => vscode.postMessage(message);

document.body.innerHTML = `
  <div id="toolbar" role="toolbar" aria-label="Commit graph">
    <button id="repo-name" class="toolbar-button" title="Select Repository"></button>
    <button id="filter-button" class="toolbar-button" aria-haspopup="true" aria-expanded="false"
      title="Show only some branches">All Branches ▾</button>
    <div id="find-box" role="search">
      <input id="find-input" type="text" spellcheck="false" aria-label="Find commits"
        placeholder="Find by message, author, SHA or ref (Ctrl+F)">
      <span id="find-count" aria-live="polite"></span>
      <button id="find-prev" class="toolbar-button" title="Previous Match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button id="find-next" class="toolbar-button" title="Next Match (Enter)" aria-label="Next match">↓</button>
    </div>
    <button id="head-button" class="toolbar-button" title="Go to the checked-out commit">HEAD</button>
    <button id="refresh-button" class="toolbar-button" title="Refresh" aria-label="Refresh">⟳</button>
    <button id="details-button" class="toolbar-button" title="Toggle Details (Enter)" aria-pressed="false">Details</button>
  </div>
  <div id="header" aria-hidden="true">
    <span id="h-graph">Graph</span><span id="h-desc">Description</span><span id="h-author">Author</span><span id="h-sha">Commit</span><span id="h-date">Date</span>
  </div>
  <div id="list">
    <canvas id="canvas" aria-hidden="true"></canvas>
    <div id="scroller" tabindex="0" role="listbox" aria-label="Commits" aria-multiselectable="true">
      <div id="spacer"></div>
      <div id="a11y"></div>
    </div>
    <div id="loading" role="status">Loading commits…</div>
    <div id="error" role="alert"></div>
  </div>
  <div id="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize details"></div>
  <div id="details" role="region" aria-label="Commit details"></div>
  <div id="context-menu" class="menu" role="menu"></div>
  <div id="filter-popover" role="dialog" aria-label="Branches to show">
    <input id="filter-search" type="text" placeholder="Filter branches" aria-label="Filter branches" spellcheck="false">
    <button id="filter-all" class="toolbar-button">Show All Branches</button>
    <div id="filter-list"></div>
  </div>
`;

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = byId<HTMLCanvasElement>('canvas');
const scroller = byId<HTMLDivElement>('scroller');
const spacer = byId<HTMLDivElement>('spacer');
const a11yLayer = byId<HTMLDivElement>('a11y');
const contextMenu = byId<HTMLDivElement>('context-menu');
const errorBox = byId<HTMLDivElement>('error');
const loading = byId<HTMLDivElement>('loading');
const repoNameEl = byId<HTMLButtonElement>('repo-name');
const headButton = byId<HTMLButtonElement>('head-button');
const filterButton = byId<HTMLButtonElement>('filter-button');
const filterPopover = byId<HTMLDivElement>('filter-popover');
const filterSearch = byId<HTMLInputElement>('filter-search');
const filterList = byId<HTMLDivElement>('filter-list');
const filterAll = byId<HTMLButtonElement>('filter-all');
const findInput = byId<HTMLInputElement>('find-input');
const findCount = byId<HTMLSpanElement>('find-count');
const findPrev = byId<HTMLButtonElement>('find-prev');
const findNext = byId<HTMLButtonElement>('find-next');
const refreshButton = byId<HTMLButtonElement>('refresh-button');
const detailsButton = byId<HTMLButtonElement>('details-button');
const splitter = byId<HTMLDivElement>('splitter');
const detailsPane = byId<HTMLDivElement>('details');
const header = {
  graph: byId<HTMLSpanElement>('h-graph'),
  desc: byId<HTMLSpanElement>('h-desc'),
  author: byId<HTMLSpanElement>('h-author'),
  sha: byId<HTMLSpanElement>('h-sha'),
  date: byId<HTMLSpanElement>('h-date'),
};

const store = new GraphStore();
const renderer = new GraphRenderer(canvas);
let theme = readThemeColors(getComputedStyle(document.body));

/** Everything that came with the latest reset. */
const view = {
  repoRoot: '',
  repoName: '',
  canMutate: false,
  maxLanes: 24,
  filter: undefined as string[] | undefined,
  branches: [] as BranchOption[],
  /** False until the first page of the current generation arrives. */
  loaded: false,
};

let hoverIndex = -1;
let headSha: string | undefined;

// --- persisted state ---------------------------------------------------------

const saved = (vscode.getState() ?? undefined) as GraphViewState | undefined;
/** State to re-apply once the repository it belongs to has loaded. */
let pendingRestore: GraphViewState | undefined = saved;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

function topSha(): string | undefined {
  return store.rows[Math.floor(scroller.scrollTop / ROW_HEIGHT)]?.sha;
}

function saveState(): void {
  if (stateTimer !== undefined) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    const state: GraphViewState = {
      repoRoot: view.repoRoot || undefined,
      topSha: topSha(),
      selected: [...store.selection.selected].slice(0, 50),
      filter: view.filter,
      detailsOpen: details.open,
      detailsShare: details.share,
      query: find.query || undefined,
    };
    vscode.setState(state);
  }, 300);
}

// --- painting ------------------------------------------------------------------

let frameHandle: number | undefined;

/** Coalesces render requests onto the next animation frame; scroll, resize and
 *  key repeat all fire faster than the display paints. */
function render(): void {
  if (frameHandle !== undefined) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = undefined;
    paint();
  });
}

function paint(): void {
  spacer.style.height = `${store.rows.length * ROW_HEIGHT}px`;
  renderer.render({
    rows: store.rows,
    maxLane: store.maxLane,
    maxLanes: view.maxLanes,
    selection: store.selection,
    scrollTop: scroller.scrollTop,
    viewportW: scroller.clientWidth,
    viewportH: scroller.clientHeight,
    theme,
    hoverIndex,
    focused: document.activeElement === scroller,
    matches: find.matchSet,
    currentMatch: find.current,
    headSha,
  });
  paintHeader();
  paintA11y();
  maybeLoadMore();
}

function paintHeader(): void {
  const layout = renderer.layout;
  if (!layout) return;
  const place = (span: HTMLSpanElement, x: number, width: number): void => {
    span.style.display = width > 0 ? 'block' : 'none';
    span.style.left = `${x}px`;
    span.style.width = `${Math.max(0, width)}px`;
  };
  place(header.graph, LANE_PADDING / 2, layout.graphW - LANE_PADDING / 2);
  header.graph.textContent = layout.cap.overflow ? `Graph (+${layout.cap.hidden})` : 'Graph';
  header.graph.title = layout.cap.overflow
    ? `${layout.cap.hidden} lanes are folded into the last column (setting: gitglasses.graph.maxLanes)`
    : '';
  place(header.desc, layout.descriptionX, layout.descriptionW);
  place(header.author, layout.authorX, layout.authorW);
  place(header.sha, layout.shaX, layout.shaW);
  place(header.date, layout.dateX, layout.dateW);
}

/** What a screen reader announces for a row. */
function rowLabel(row: GraphRow): string {
  if (row.kind === 'wip') return 'Uncommitted changes';
  const refs = row.refs.map((ref) => ref.name).join(', ');
  const parts = [row.summary, row.author.name, rowDate(row), shortSha(row.sha)];
  if (refs) parts.push(refs);
  if (row.kind === 'stash') parts.unshift('Stash');
  return parts.join(', ');
}

const a11yPool: HTMLDivElement[] = [];

/** Keeps one option element per drawn row (plus the anchor), so the listbox
 *  exposes the rows and aria-activedescendant can point at the anchor. */
function paintA11y(): void {
  const range = visibleRange(
    scroller.scrollTop,
    scroller.clientHeight,
    ROW_HEIGHT,
    store.rows.length,
    0,
  );
  const indices: number[] = [];
  for (let i = range.start; i < range.end; i++) indices.push(i);
  const anchor = store.selection.anchor;
  if (anchor >= 0 && anchor < store.rows.length && !indices.includes(anchor)) indices.push(anchor);
  while (a11yPool.length < indices.length) {
    const option = document.createElement('div');
    option.className = 'a11y-row';
    option.setAttribute('role', 'option');
    a11yLayer.append(option);
    a11yPool.push(option);
  }
  const setSize = store.nextCursor === undefined ? store.rows.length : -1;
  a11yPool.forEach((option, slot) => {
    const index = indices[slot];
    if (index === undefined) {
      option.hidden = true;
      option.removeAttribute('id');
      return;
    }
    const row = store.rows[index];
    option.hidden = false;
    option.id = `gg-row-${index}`;
    option.style.top = `${index * ROW_HEIGHT}px`;
    option.setAttribute('aria-selected', String(store.selection.selected.has(row.sha)));
    option.setAttribute('aria-posinset', String(index + 1));
    option.setAttribute('aria-setsize', String(setSize));
    const label = rowLabel(row);
    if (option.textContent !== label) option.textContent = label;
  });
  if (anchor >= 0 && anchor < store.rows.length) {
    scroller.setAttribute('aria-activedescendant', `gg-row-${anchor}`);
  } else {
    scroller.removeAttribute('aria-activedescendant');
  }
}

/** Requests the next page once the viewport nears the end of what is loaded,
 *  or right away while a reveal or find is waiting for rows. */
function maybeLoadMore(force = false): void {
  const range = visibleRange(
    scroller.scrollTop,
    scroller.clientHeight,
    ROW_HEIGHT,
    store.rows.length,
    OVERSCAN_ROWS,
  );
  const cursor = store.beginLoadMore(force ? store.rows.length : range.end);
  if (cursor !== undefined) post({ type: 'loadMore', generation: store.generation, cursor });
}

/** Shows the host's explanation over the list, or clears it. */
function showError(message: string | undefined): void {
  errorBox.textContent = message ?? '';
  errorBox.style.display = message === undefined ? 'none' : 'flex';
}

function showLoading(visible: boolean): void {
  loading.classList.toggle('visible', visible);
}

// --- selection -----------------------------------------------------------------

function scrollRowIntoView(index: number, center = false): void {
  const top = index * ROW_HEIGHT;
  const height = scroller.clientHeight;
  if (center && (top < scroller.scrollTop || top + ROW_HEIGHT > scroller.scrollTop + height)) {
    scroller.scrollTop = Math.max(0, top - height / 2 + ROW_HEIGHT / 2);
  } else if (top < scroller.scrollTop) {
    scroller.scrollTop = top;
  } else if (top + ROW_HEIGHT > scroller.scrollTop + height) {
    scroller.scrollTop = top + ROW_HEIGHT - height;
  }
}

function selectionChanged(): void {
  updateDetails();
  saveState();
  render();
}

function selectIndex(index: number, modifiers = { ctrl: false, shift: false }): void {
  store.selection = reduceSelection(store.selection, index, modifiers, store.shas());
  selectionChanged();
}

/** A reveal waiting for its commit to be loaded. */
let pendingReveal: { sha: string; pagesLeft: number; fallback: () => void } | undefined;
const REVEAL_MAX_PAGES = 25;

/** Selects and scrolls to a commit, loading further pages to reach it.
 *  `fallback` runs when it is not found among the pages a reveal may load. */
function revealSha(sha: string, fallback: () => void): void {
  const index = store.indexOf(sha);
  if (index >= 0) {
    pendingReveal = undefined;
    selectIndex(index);
    scrollRowIntoView(index, true);
    return;
  }
  if (store.nextCursor === undefined) {
    pendingReveal = undefined;
    fallback();
    return;
  }
  pendingReveal = { sha, pagesLeft: REVEAL_MAX_PAGES, fallback };
  maybeLoadMore(true);
}

function continueReveal(): void {
  const reveal = pendingReveal;
  if (!reveal) return;
  if (store.indexOf(reveal.sha) >= 0 || store.nextCursor === undefined || reveal.pagesLeft <= 0) {
    pendingReveal = undefined;
    if (store.indexOf(reveal.sha) >= 0) revealSha(reveal.sha, reveal.fallback);
    else reveal.fallback();
    return;
  }
  reveal.pagesLeft--;
  maybeLoadMore(true);
}

// --- details pane --------------------------------------------------------------

const DETAILS_MIN_HEIGHT = 120;
/** Share of the panel height the details pane takes unless resized. */
const DETAILS_DEFAULT_SHARE = 0.4;
const details = {
  open: false,
  /** Share of the panel height the pane takes, kept as a share so it follows
   *  the panel as it is resized. */
  share: DETAILS_DEFAULT_SHARE,
  requestId: 0,
  /** Key of the target the pane shows or waits for. */
  key: '',
  /** A commit shown without selecting a row (a parent not loaded). */
  explicit: undefined as DetailsTarget | undefined,
  cache: new Map<string, DetailsView>(),
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
};

function targetKey(target: DetailsTarget): string {
  switch (target.kind) {
    case 'commit':
      return `commit:${target.sha}`;
    case 'compare':
      return `compare:${target.base}..${target.head}`;
    case 'wip':
      return 'wip';
  }
}

/** What the selection asks the pane to show: two commits compare, one row
 *  shows itself. */
function selectionTarget(): DetailsTarget | undefined {
  const selected = store.selectedRows();
  if (selected.length === 2 && selected.every((row) => row.kind !== 'wip')) {
    // Rows run newest first, so the second is the older: the diff's base.
    return { kind: 'compare', base: selected[1].sha, head: selected[0].sha };
  }
  const row = store.anchorRow();
  if (!row || !store.selection.selected.has(row.sha)) {
    return selected.length === 1 ? targetFor(selected[0]) : undefined;
  }
  return targetFor(row);
}

function targetFor(row: GraphRow): DetailsTarget {
  return row.kind === 'wip' ? { kind: 'wip' } : { kind: 'commit', sha: row.sha };
}

function setDetailsOpen(open: boolean): void {
  details.open = open;
  document.body.classList.toggle('details-open', open);
  detailsButton.setAttribute('aria-pressed', String(open));
  if (open) {
    applyDetailsHeight();
    updateDetails(true);
  }
  saveState();
  render();
}

/** Sizes the pane from the preferred height, leaving the list some room. The
 *  preference itself survives a panel that is briefly tiny or hidden. */
function applyDetailsHeight(): void {
  if (window.innerHeight <= 0) return;
  const max = Math.max(DETAILS_MIN_HEIGHT, window.innerHeight - 160);
  const height = Math.min(
    max,
    Math.max(DETAILS_MIN_HEIGHT, Math.round(window.innerHeight * details.share)),
  );
  detailsPane.style.height = `${height}px`;
}

/** Shows (or requests) the details of the current target. Arrow-key
 *  navigation fires this per row, so requests wait for the selection to rest. */
function updateDetails(immediate = false): void {
  if (!details.open) return;
  const target = details.explicit ?? selectionTarget();
  if (!target) {
    details.key = '';
    renderDetailsView({ kind: 'error', message: 'Select a commit to see its details.' });
    return;
  }
  const key = targetKey(target);
  if (key === details.key && detailsPane.childElementCount > 0 && !immediate) return;
  details.key = key;
  const cached = details.cache.get(key);
  if (cached) {
    renderDetailsView(cached);
    return;
  }
  renderDetailsView(undefined);
  clearTimeout(details.timer);
  const send = (): void => {
    details.requestId++;
    post({ type: 'details', requestId: details.requestId, target });
  };
  if (immediate) send();
  else details.timer = setTimeout(send, 120);
}

/** The details view's messages; parent links are the graph's own business. */
function detailsPost(message: WebviewToHostMessage): void {
  if (message.type === 'showCommit') showCommit(message.sha);
  else post(message);
}

function renderDetailsView(viewModel: DetailsView | undefined): void {
  renderDetails(detailsPane, viewModel, {
    post: detailsPost,
    canMutate: view.canMutate,
    onClose: () => {
      setDetailsOpen(false);
      scroller.focus();
    },
    onAction: (action: DetailsAction, sha?: string) => runAction(action, sha ? [sha] : []),
  });
}

function rememberDetails(key: string, viewModel: DetailsView): void {
  // Working-tree contents change without a new sha; never serve them stale.
  if (key === 'wip' || viewModel.kind === 'error') return;
  details.cache.delete(key);
  details.cache.set(key, viewModel);
  if (details.cache.size > 100) {
    const oldest = details.cache.keys().next().value;
    if (oldest !== undefined) details.cache.delete(oldest);
  }
}

// Resizing the pane by dragging the splitter.
splitter.addEventListener('pointerdown', (event) => {
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
  const startY = event.clientY;
  const startHeight = detailsPane.getBoundingClientRect().height;
  const move = (e: PointerEvent): void => {
    const max = Math.max(DETAILS_MIN_HEIGHT, window.innerHeight - 160);
    const height = Math.min(max, Math.max(DETAILS_MIN_HEIGHT, startHeight + (startY - e.clientY)));
    details.share = height / window.innerHeight;
    applyDetailsHeight();
    render();
  };
  const up = (): void => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    saveState();
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});

detailsButton.addEventListener('click', () => setDetailsOpen(!details.open));

// --- find ----------------------------------------------------------------------

const find = {
  query: '',
  /** Matches the host found across HEAD's history, loaded or not. */
  hostShas: new Set<string>(),
  truncated: false,
  /** Loaded rows that match. */
  matchSet: new Set<string>() as ReadonlySet<string>,
  matchIndices: [] as number[],
  current: undefined as string | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  /** Pages still allowed while looking for the next match. */
  pagesLeft: 0,
  searchingBackwards: false,
};

function recomputeMatches(): void {
  const indices: number[] = [];
  const set = new Set<string>();
  if (find.query) {
    store.rows.forEach((row, i) => {
      if (find.hostShas.has(row.sha) || rowMatchesQuery(row, find.query)) {
        indices.push(i);
        set.add(row.sha);
      }
    });
  }
  find.matchIndices = indices;
  find.matchSet = set;
  updateFindCount();
}

function unloadedHostMatches(): number {
  let count = 0;
  for (const sha of find.hostShas) if (store.indexOf(sha) < 0) count++;
  return count;
}

function updateFindCount(): void {
  if (!find.query) {
    findCount.textContent = '';
    return;
  }
  const total = find.matchIndices.length;
  const more = unloadedHostMatches() > 0 || find.truncated ? '+' : '';
  if (total === 0) {
    findCount.textContent = more ? 'Searching…' : 'No results';
    return;
  }
  const position = find.current ? find.matchIndices.indexOf(store.indexOf(find.current)) + 1 : 0;
  findCount.textContent = position > 0 ? `${position} of ${total}${more}` : `${total}${more} found`;
}

function setQuery(query: string): void {
  find.query = query.trim();
  find.hostShas = new Set();
  find.truncated = false;
  find.current = undefined;
  recomputeMatches();
  clearTimeout(find.timer);
  if (find.query) find.timer = setTimeout(() => post({ type: 'find', query: find.query }), 250);
  saveState();
  render();
}

/** Moves to the next (or previous) match after the selected row, loading
 *  further pages while the host knows of matches that are not loaded yet. */
function gotoMatch(backwards: boolean): void {
  if (!find.query) return;
  const from = store.selection.anchor;
  const forwardEnd =
    find.matchIndices.length > 0 && find.matchIndices[find.matchIndices.length - 1] > from;
  if (!backwards && !forwardEnd && store.nextCursor !== undefined && unloadedHostMatches() > 0) {
    find.pagesLeft = REVEAL_MAX_PAGES;
    find.searchingBackwards = false;
    findCount.textContent = 'Searching…';
    maybeLoadMore(true);
    return;
  }
  const index = nextMatch(find.matchIndices, from, backwards);
  if (index === undefined) {
    updateFindCount();
    return;
  }
  find.current = store.rows[index].sha;
  selectIndex(index);
  scrollRowIntoView(index, true);
  updateFindCount();
}

function continueFind(): void {
  if (find.pagesLeft <= 0) return;
  const from = store.selection.anchor;
  if (find.matchIndices.some((i) => i > from) || store.nextCursor === undefined) {
    find.pagesLeft = 0;
    gotoMatch(find.searchingBackwards);
    return;
  }
  find.pagesLeft--;
  maybeLoadMore(true);
}

findInput.addEventListener('input', () => setQuery(findInput.value));
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    gotoMatch(event.shiftKey);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    findInput.value = '';
    setQuery('');
    scroller.focus();
  }
});
findPrev.addEventListener('click', () => gotoMatch(true));
findNext.addEventListener('click', () => gotoMatch(false));

// --- branch filter ---------------------------------------------------------------

let filterTimer: ReturnType<typeof setTimeout> | undefined;

function setFilter(refs: string[] | undefined): void {
  view.filter = refs && refs.length > 0 ? refs : undefined;
  filterButton.textContent = `${filterLabel(view.filter, view.branches)} ▾`;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => post({ type: 'setFilter', refs: view.filter }), 350);
  saveState();
}

function renderFilterList(): void {
  const query = filterSearch.value.trim().toLowerCase();
  const selected = new Set(view.filter ?? []);
  // A re-render keeps keyboard focus on the same branch.
  const focusedRef = (document.activeElement as HTMLElement | null)?.dataset?.ref;
  filterList.replaceChildren();
  const groups: [string, BranchOption[]][] = [
    ['Local', view.branches.filter((b) => b.kind === 'branch')],
    ['Remote', view.branches.filter((b) => b.kind === 'remote')],
  ];
  for (const [title, options] of groups) {
    const shown = options.filter((option) => !query || option.name.toLowerCase().includes(query));
    if (shown.length === 0) continue;
    const heading = document.createElement('div');
    heading.className = 'filter-group';
    heading.textContent = title;
    filterList.append(heading);
    for (const option of shown) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.ref = option.ref;
      box.checked = selected.has(option.ref);
      box.addEventListener('change', () => {
        const next = new Set(view.filter ?? []);
        if (box.checked) next.add(option.ref);
        else next.delete(option.ref);
        setFilter([...next]);
      });
      const text = document.createElement('span');
      text.textContent = option.current ? `${option.name} (current)` : option.name;
      label.append(box, text);
      label.title = option.ref;
      filterList.append(label);
      if (option.ref === focusedRef) box.focus();
    }
  }
}

function toggleFilterPopover(open: boolean): void {
  filterPopover.classList.toggle('visible', open);
  filterButton.setAttribute('aria-expanded', String(open));
  if (open) {
    const rect = filterButton.getBoundingClientRect();
    filterPopover.style.left = `${Math.min(rect.left, window.innerWidth - 310)}px`;
    filterPopover.style.top = `${rect.bottom + 2}px`;
    filterSearch.value = '';
    renderFilterList();
    filterSearch.focus();
  }
}

filterButton.addEventListener('click', () =>
  toggleFilterPopover(!filterPopover.classList.contains('visible')),
);
filterSearch.addEventListener('input', renderFilterList);
filterAll.addEventListener('click', () => {
  setFilter(undefined);
  renderFilterList();
});
document.addEventListener('mousedown', (event) => {
  const target = event.target as Node;
  if (
    filterPopover.classList.contains('visible') &&
    !filterPopover.contains(target) &&
    target !== filterButton
  ) {
    toggleFilterPopover(false);
  }
  if (contextMenu.classList.contains('visible') && !contextMenu.contains(target))
    hideContextMenu(false);
});

refreshButton.addEventListener('click', () => post({ type: 'refresh' }));
repoNameEl.addEventListener('click', () => post({ type: 'selectRepository' }));
headButton.addEventListener('click', revealHead);

/** Pages a "go to HEAD" may still load while looking for the commit. */
let headPagesLeft = 0;

/** Selects the checked-out commit, loading pages until it shows up. */
function revealHead(): void {
  if (headSha) {
    revealSha(headSha, () => undefined);
    return;
  }
  if (store.nextCursor === undefined) return;
  headPagesLeft = REVEAL_MAX_PAGES;
  maybeLoadMore(true);
}

function continueHead(): void {
  if (headPagesLeft <= 0) return;
  if (headSha) {
    headPagesLeft = 0;
    revealSha(headSha, () => undefined);
  } else if (store.nextCursor !== undefined) {
    headPagesLeft--;
    maybeLoadMore(true);
  } else {
    headPagesLeft = 0;
  }
}

// --- context menus ----------------------------------------------------------------

function hideContextMenu(refocus: boolean): void {
  if (!contextMenu.classList.contains('visible')) return;
  contextMenu.classList.remove('visible');
  if (refocus) scroller.focus();
}

function showMenu<A extends string>(
  items: MenuItem<A>[],
  x: number,
  y: number,
  onPick: (action: A) => void,
): void {
  contextMenu.replaceChildren();
  for (const item of items) {
    if (item.group && contextMenu.childElementCount > 0) {
      const separator = document.createElement('div');
      separator.setAttribute('role', 'separator');
      contextMenu.append(separator);
    }
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    entry.textContent = item.label;
    entry.addEventListener('click', () => {
      hideContextMenu(true);
      onPick(item.action);
    });
    contextMenu.append(entry);
  }
  contextMenu.classList.add('visible');
  const left = Math.max(4, Math.min(x, window.innerWidth - contextMenu.offsetWidth - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 4));
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
  menuItems()[0]?.focus();
}

function menuItems(): HTMLButtonElement[] {
  return [...contextMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

contextMenu.addEventListener('keydown', (event) => {
  const items = menuItems();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const focusAt = (i: number): void => items[(i + items.length) % items.length]?.focus();
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusAt(current + 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusAt(current - 1);
      break;
    case 'Home':
      event.preventDefault();
      focusAt(0);
      break;
    case 'End':
      event.preventDefault();
      focusAt(items.length - 1);
      break;
    case 'Escape':
    case 'Tab':
      event.preventDefault();
      hideContextMenu(true);
      break;
  }
});
contextMenu.addEventListener('focusout', (event) => {
  const next = event.relatedTarget as Node | null;
  if (!next || !contextMenu.contains(next)) hideContextMenu(false);
});

/** Selected commit shas in row order (newest first), or just `fallback`. */
function selectedCommitShas(fallback: GraphRow): string[] {
  const shas = store
    .selectedRows()
    .filter((row) => row.kind === 'commit')
    .map((row) => row.sha);
  return shas.includes(fallback.sha) ? shas : [fallback.sha];
}

function openRowMenu(row: GraphRow, x: number, y: number): void {
  const commits = row.kind === 'commit' ? selectedCommitShas(row).length : 0;
  showMenu(rowMenu(row.kind, commits, view.canMutate), x, y, (action) => onRowMenu(action, row));
}

function onRowMenu(action: RowMenuAction, row: GraphRow): void {
  switch (action) {
    case 'showDetails':
      details.explicit = undefined;
      setDetailsOpen(true);
      break;
    case 'openChanges':
      post({ type: 'openChanges', target: { kind: 'commit', sha: row.sha } });
      break;
    case 'compare':
      details.explicit = undefined;
      setDetailsOpen(true);
      break;
    case 'copySha':
      post({ type: 'copy', text: row.sha, label: `SHA ${shortSha(row.sha)}` });
      break;
    case 'copyMessage':
      post({ type: 'copy', text: row.summary, label: 'message' });
      break;
    case 'cherryPick':
    case 'revert':
      runAction(action, selectedCommitShas(row));
      break;
    default:
      runAction(action, [row.sha]);
  }
}

function runAction(action: GraphActionId | DetailsAction, shas: string[]): void {
  post({ type: 'action', generation: store.generation, action, shas });
}

function openRefMenu(row: GraphRow, ref: GraphRef, x: number, y: number): void {
  const current =
    ref.kind === 'head' ||
    (ref.kind === 'branch' && row.refs.some((r) => r.kind === 'head') && isCurrentBranch(ref.name));
  showMenu(refMenu(ref, current, view.canMutate), x, y, (action: RefMenuAction) => {
    if (action === 'copyName') {
      post({ type: 'copy', text: ref.name, label: `'${ref.name}'` });
      return;
    }
    post({ type: 'refAction', generation: store.generation, action, ref, sha: row.sha });
  });
}

function isCurrentBranch(name: string): boolean {
  return view.branches.some((b) => b.kind === 'branch' && b.current && b.name === name);
}

// --- pointer ------------------------------------------------------------------

function eventPoint(event: MouseEvent): { x: number; y: number } {
  const rect = scroller.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function rowIndexFromEvent(event: MouseEvent): number | undefined {
  return rowAtY(eventPoint(event).y, scroller.scrollTop, ROW_HEIGHT, store.rows.length);
}

function chipFromEvent(event: MouseEvent): { row: GraphRow; ref: GraphRef } | undefined {
  const { x, y } = eventPoint(event);
  const chip = refChipAtPoint(x, y + scroller.scrollTop, renderer.chipBoxes);
  if (!chip || chip.row === undefined || chip.refIndex === undefined) return undefined;
  const row = store.rows[chip.row];
  const ref = row?.refs[chip.refIndex];
  return row && ref ? { row, ref } : undefined;
}

scroller.addEventListener('scroll', () => {
  hideContextMenu(false);
  saveState();
  render();
});

window.addEventListener('resize', () => {
  if (details.open) applyDetailsHeight();
  render();
});

scroller.addEventListener('mousemove', (event) => {
  const index = rowIndexFromEvent(event) ?? -1;
  scroller.style.cursor = chipFromEvent(event) ? 'pointer' : '';
  if (index !== hoverIndex) {
    hoverIndex = index;
    const row = store.rows[index];
    scroller.title =
      row && row.kind !== 'wip'
        ? `${row.summary}\n${row.author.name} · ${rowDate(row)} · ${shortSha(row.sha)}`
        : '';
    render();
  }
});

scroller.addEventListener('mouseleave', () => {
  hoverIndex = -1;
  render();
});

scroller.addEventListener('focus', render);
scroller.addEventListener('blur', render);

scroller.addEventListener('click', (event) => {
  hideContextMenu(false);
  const index = rowIndexFromEvent(event);
  if (index === undefined) return;
  details.explicit = undefined;
  selectIndex(index, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  if (!details.open && !event.ctrlKey && !event.metaKey && !event.shiftKey) setDetailsOpen(true);
});

scroller.addEventListener('dblclick', (event) => {
  const index = rowIndexFromEvent(event);
  if (index === undefined) return;
  const row = store.rows[index];
  if (row.kind === 'wip') runAction('openScm', []);
  else post({ type: 'openChanges', target: { kind: 'commit', sha: row.sha } });
});

scroller.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  // A keyboard-raised context menu (button -1 in Chromium, or not the right
  // button) targets the selected row, not whatever lies under the pointer.
  if (event.button !== 2) {
    openMenuForAnchor();
    return;
  }
  const chip = chipFromEvent(event);
  const index = chip ? store.indexOf(chip.row.sha) : rowIndexFromEvent(event);
  if (index === undefined || index < 0) {
    hideContextMenu(false);
    return;
  }
  if (!store.selection.selected.has(store.rows[index].sha)) selectIndex(index);
  if (chip) openRefMenu(chip.row, chip.ref, event.clientX, event.clientY);
  else openRowMenu(store.rows[index], event.clientX, event.clientY);
});

/** Opens the row menu for the selected row, next to it. */
function openMenuForAnchor(): void {
  const anchor = store.selection.anchor;
  if (anchor < 0 || anchor >= store.rows.length) return;
  scrollRowIntoView(anchor);
  const rect = scroller.getBoundingClientRect();
  const y = rect.top + (anchor + 1) * ROW_HEIGHT - scroller.scrollTop;
  const x = rect.left + (renderer.layout?.descriptionX ?? 40);
  openRowMenu(store.rows[anchor], x, y);
}

// --- keyboard ----------------------------------------------------------------

scroller.addEventListener('keydown', (event) => {
  const pageRows = Math.floor(scroller.clientHeight / ROW_HEIGHT);
  const next = navigateIndex(event.key, store.selection.anchor, store.rows.length, pageRows);
  if (next !== undefined) {
    event.preventDefault();
    details.explicit = undefined;
    selectIndex(next, { ctrl: false, shift: event.shiftKey });
    scrollRowIntoView(next);
    if (next >= store.rows.length - 1) maybeLoadMore(true);
    return;
  }
  const anchorRow = store.anchorRow();
  if (event.key === 'Enter') {
    event.preventDefault();
    details.explicit = undefined;
    if (!details.open) setDetailsOpen(true);
    else if (anchorRow && anchorRow.kind !== 'wip') {
      post({ type: 'openChanges', target: { kind: 'commit', sha: anchorRow.sha } });
    }
  } else if (event.key === ' ') {
    event.preventDefault();
    const anchor = store.selection.anchor;
    if (anchor >= 0) selectIndex(anchor, { ctrl: true, shift: false });
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    openMenuForAnchor();
  } else if (event.key === 'Escape') {
    if (details.open) setDetailsOpen(false);
  } else if (event.key === 'F3') {
    event.preventDefault();
    gotoMatch(event.shiftKey);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && filterPopover.classList.contains('visible')) {
    event.preventDefault();
    toggleFilterPopover(false);
    filterButton.focus();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    findInput.focus();
    findInput.select();
  }
});

// --- host messages --------------------------------------------------------------

function applyRestore(): void {
  const restore = pendingRestore;
  if (!restore || restore.repoRoot !== view.repoRoot || store.rows.length === 0) return;
  pendingRestore = undefined;
  if (restore.selected?.length) {
    const present = restore.selected.filter((sha) => store.indexOf(sha) >= 0);
    if (present.length > 0) {
      store.selection = { selected: new Set(present), anchor: store.indexOf(present[0]) };
    }
  }
  if (restore.topSha) {
    const index = store.indexOf(restore.topSha);
    if (index >= 0) scroller.scrollTop = index * ROW_HEIGHT;
  }
  if (restore.detailsShare) details.share = restore.detailsShare;
  if (restore.query) {
    findInput.value = restore.query;
    setQuery(restore.query);
  }
  if (restore.detailsOpen) setDetailsOpen(true);
  selectionChanged();
}

function onRows(message: Extract<HostToWebviewMessage, { type: 'rows' }>): void {
  if (!store.acceptRows(message.generation, message.replace)) return;
  showError(undefined);
  if (message.replace) {
    const previous = store.shas();
    const nextShas = message.rows.map((row) => row.sha);
    const scrollTop = anchoredScrollTop(scroller.scrollTop, ROW_HEIGHT, previous, nextShas);
    store.replaceAll(message.rows, message.nextCursor);
    spacer.style.height = `${store.rows.length * ROW_HEIGHT}px`;
    scroller.scrollTop = scrollTop;
    // Refs and stash entries may have moved: details must be asked again.
    details.cache.clear();
    details.key = '';
    updateDetails();
  } else {
    store.appendPage(message.rows, message.nextCursor);
    // Size the content now: a restored or revealed position is set below,
    // before the next paint would grow it.
    spacer.style.height = `${store.rows.length * ROW_HEIGHT}px`;
  }
  headSha = store.rows.find((row) => row.refs.some((ref) => ref.kind === 'head'))?.sha;
  view.loaded = true;
  showLoading(false);
  if (store.rows.length === 0) {
    showError(
      view.filter ? 'No commits on the selected branches.' : 'This repository has no commits yet.',
    );
  }
  recomputeMatches();
  applyRestore();
  continueReveal();
  continueFind();
  continueHead();
  render();
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'reset':
      store.reset();
      store.generation = message.generation;
      view.repoRoot = message.repoRoot;
      view.repoName = message.repoName;
      view.canMutate = message.canMutate;
      view.maxLanes = message.maxLanes;
      view.filter = message.filter;
      view.loaded = false;
      repoNameEl.textContent = message.repoName;
      repoNameEl.title = message.repoRoot;
      filterButton.textContent = `${filterLabel(view.filter, view.branches)} ▾`;
      scroller.scrollTop = 0;
      headSha = undefined;
      pendingReveal = undefined;
      find.pagesLeft = 0;
      headPagesLeft = 0;
      details.cache.clear();
      details.key = '';
      details.explicit = undefined;
      showError(undefined);
      showLoading(true);
      if (details.open) updateDetails();
      saveState();
      render();
      break;
    case 'rows':
      onRows(message);
      break;
    case 'branches':
      view.branches = message.branches;
      filterButton.textContent = `${filterLabel(view.filter, view.branches)} ▾`;
      if (filterPopover.classList.contains('visible')) renderFilterList();
      break;
    case 'details':
      if (message.requestId !== details.requestId) break;
      rememberDetails(details.key, message.view);
      renderDetailsView(message.view);
      break;
    case 'findResults':
      if (message.query !== find.query) break;
      find.hostShas = new Set(message.shas);
      find.truncated = message.truncated;
      recomputeMatches();
      render();
      break;
    case 'wipChanged':
      if (details.key === 'wip') updateDetails(true);
      break;
    case 'settings':
      view.maxLanes = message.maxLanes;
      view.canMutate = message.canMutate;
      render();
      break;
    case 'error':
      showLoading(false);
      store.requestInFlight = false;
      showError(message.message);
      break;
    case 'theme':
      theme = readThemeColors(getComputedStyle(document.body));
      renderer.themeChanged();
      render();
      break;
  }
});

/** Shows a commit the details view links to: selects it in the graph when it
 *  is loaded (or can be), otherwise shows it in the pane on its own. */
function showCommit(sha: string): void {
  revealSha(sha, () => {
    details.explicit = { kind: 'commit', sha };
    setDetailsOpen(true);
    updateDetails(true);
  });
}

// Theme swaps update body CSS variables without a reload; re-read on both the
// host's notification (above) and OS-level scheme flips.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  theme = readThemeColors(getComputedStyle(document.body));
  renderer.themeChanged();
  render();
});

if (saved?.detailsShare) details.share = saved.detailsShare;
showLoading(true);
scroller.focus();
post({ type: 'ready', state: saved });
render();
