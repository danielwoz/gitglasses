// Commit graph webview bootstrap: DOM wiring, scrolling, selection,
// keyboard navigation, context menu, and host messaging.

import './graph.css';
import type { GraphActionId, HostToWebviewMessage, WebviewToHostMessage } from './ipc';
import { reduceSelection, rowAtY, visibleRange } from './graphLogic';
import { GraphRenderer, OVERSCAN_ROWS, ROW_HEIGHT, readThemeColors } from './renderer';
import { GraphStore } from './store';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHostMessage): void => vscode.postMessage(message);

document.body.innerHTML = `
  <canvas id="canvas"></canvas>
  <div id="scroller" tabindex="0"><div id="spacer"></div></div>
  <div id="error"></div>
  <div id="context-menu">
    <button data-action="createBranch">Create Branch Here…</button>
    <button data-action="switchDetached">Switch to Commit (Detached)</button>
    <button data-action="cherryPick">Cherry-pick Commit(s)</button>
    <button data-action="revert">Revert Commit(s)</button>
    <button data-action="reset">Reset Current Branch to Here…</button>
    <button data-action="merge">Merge Commit into Current…</button>
    <button data-action="rebase">Rebase Current onto Here…</button>
    <button data-action="copySha">Copy SHA</button>
    <button data-action="openCommit">Open Commit</button>
  </div>
`;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scroller = document.getElementById('scroller') as HTMLDivElement;
const spacer = document.getElementById('spacer') as HTMLDivElement;
const contextMenu = document.getElementById('context-menu') as HTMLDivElement;
const errorBox = document.getElementById('error') as HTMLDivElement;

const store = new GraphStore();
const renderer = new GraphRenderer(canvas);
let theme = readThemeColors(getComputedStyle(document.body));
let contextSha: string | undefined;

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
    selection: store.selection,
    scrollTop: scroller.scrollTop,
    viewportW: scroller.clientWidth,
    viewportH: scroller.clientHeight,
    theme,
  });
  maybeLoadMore();
}

function maybeLoadMore(): void {
  const range = visibleRange(
    scroller.scrollTop,
    scroller.clientHeight,
    ROW_HEIGHT,
    store.rows.length,
    OVERSCAN_ROWS,
  );
  const cursor = store.beginLoadMore(range.end);
  if (cursor !== undefined) post({ type: 'loadMore', cursor });
}

/** Shows the host's explanation over the canvas, or clears it. */
function showError(message: string | undefined): void {
  errorBox.textContent = message ?? '';
  errorBox.style.display = message === undefined ? 'none' : 'flex';
}

function rowIndexFromEvent(event: MouseEvent): number | undefined {
  return rowAtY(event.clientY, scroller.scrollTop, ROW_HEIGHT, store.rows.length);
}

function postSelection(): void {
  post({ type: 'select', shas: [...store.selection.selected] });
}

function hideContextMenu(): void {
  contextMenu.style.display = 'none';
  contextSha = undefined;
}

function scrollRowIntoView(index: number): void {
  const top = index * ROW_HEIGHT;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
  }
}

scroller.addEventListener('scroll', () => {
  hideContextMenu();
  render();
});

window.addEventListener('resize', render);

scroller.addEventListener('click', (event) => {
  hideContextMenu();
  const index = rowIndexFromEvent(event);
  if (index === undefined) return;
  store.selection = reduceSelection(
    store.selection,
    index,
    { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
    store.shas(),
  );
  postSelection();
  render();
});

scroller.addEventListener('dblclick', (event) => {
  const index = rowIndexFromEvent(event);
  if (index === undefined) return;
  post({ type: 'openCommit', sha: store.rows[index].sha });
});

scroller.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const index = rowIndexFromEvent(event);
  if (index === undefined) {
    hideContextMenu();
    return;
  }
  if (!store.selection.selected.has(store.rows[index].sha)) {
    store.selection = reduceSelection(store.selection, index, { ctrl: false, shift: false }, store.shas());
    postSelection();
    render();
  }
  contextSha = store.rows[index].sha;
  contextMenu.style.display = 'block';
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - 4)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - 4)}px`;
});

// Cherry-pick/revert act on the whole selection; everything else acts on the
// right-clicked commit.
const MULTI_SHA_ACTIONS = new Set<GraphActionId>(['cherryPick', 'revert']);

/** Selected shas in row order (newest first); falls back to the context sha. */
function selectedShasInRowOrder(contextTarget: string): string[] {
  const selected = store.selection.selected;
  const shas = store.rows.filter((row) => selected.has(row.sha)).map((row) => row.sha);
  return shas.length > 0 ? shas : [contextTarget];
}

contextMenu.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).dataset.action;
  const sha = contextSha;
  hideContextMenu();
  if (sha === undefined || action === undefined) return;
  if (action === 'copySha') post({ type: 'copySha', sha });
  else if (action === 'openCommit') post({ type: 'openCommit', sha });
  else {
    const actionId = action as GraphActionId;
    const shas = MULTI_SHA_ACTIONS.has(actionId) ? selectedShasInRowOrder(sha) : [sha];
    post({ type: 'action', action: actionId, shas });
  }
});

scroller.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (store.rows.length === 0) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const current = store.selection.anchor;
    const next =
      current < 0 ? 0 : Math.min(store.rows.length - 1, Math.max(0, current + delta));
    store.selection = reduceSelection(
      store.selection,
      next,
      { ctrl: false, shift: event.shiftKey },
      store.shas(),
    );
    scrollRowIntoView(next);
    postSelection();
    render();
  } else if (event.key === 'Enter') {
    const anchor = store.selection.anchor;
    if (anchor >= 0 && anchor < store.rows.length) {
      post({ type: 'openCommit', sha: store.rows[anchor].sha });
    }
  } else if (event.key === 'Escape') {
    hideContextMenu();
  }
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'reset':
      store.reset();
      scroller.scrollTop = 0;
      showError(undefined);
      render();
      break;
    case 'rows':
      store.appendPage(message.rows, message.nextCursor);
      showError(undefined);
      render();
      break;
    case 'error':
      showError(message.message);
      break;
    case 'theme':
      theme = readThemeColors(getComputedStyle(document.body));
      render();
      break;
  }
});

// Theme swaps update body CSS variables without a reload; re-read on both the
// host's notification (above) and OS-level scheme flips.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  theme = readThemeColors(getComputedStyle(document.body));
  render();
});

scroller.focus();
post({ type: 'ready' });
render();
