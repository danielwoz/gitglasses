// Timeline webview bootstrap: DOM wiring, hover tooltip, click-to-diff,
// ctrl+wheel zoom, drag pan, load-more paging, and host messaging.

import './timeline.css';
import type { FileHistoryEntry, HostToWebviewMessage, WebviewToHostMessage } from './ipc';
import {
  TimeDomain,
  assignAuthorLanes,
  hitTestBubbles,
  panDomain,
  timeDomain,
  xToTime,
  zoomDomain,
} from './timelineLogic';
import { TimelineRenderer, plotScale, readThemeColors } from './renderer';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHostMessage): void => vscode.postMessage(message);

document.body.innerHTML = `
  <canvas id="canvas"></canvas>
  <div id="tooltip"></div>
  <button id="load-more">Load older commits…</button>
  <div id="empty">Loading history…</div>
`;

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const loadMoreButton = document.getElementById('load-more') as HTMLButtonElement;
const empty = document.getElementById('empty') as HTMLDivElement;

const renderer = new TimelineRenderer(canvas);
let theme = readThemeColors(getComputedStyle(document.body));

let entries: FileHistoryEntry[] = [];
let nextCursor: string | undefined;
let filePath = '';
let assignment = assignAuthorLanes(entries);
/** Visible window; recomputed from the data until the user zooms or pans. */
let domain: TimeDomain = timeDomain([], Date.now());
let userAdjustedDomain = false;
let loadPending = false;
let hoverIndex: number | undefined;

function entryTimesMs(): number[] {
  return entries.map((entry) => entry.author.time * 1000);
}

function render(): void {
  if (!userAdjustedDomain) domain = timeDomain(entryTimesMs(), Date.now());
  empty.style.display = entries.length === 0 ? 'block' : 'none';
  if (entries.length === 0 && filePath !== '') {
    empty.textContent = loadPending ? 'Loading history…' : `No history for ${filePath}`;
  }
  renderer.render({
    entries,
    assignment,
    domain,
    hoverIndex,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    theme,
  });
  updateLoadMore();
}

/** The load-more affordance appears when the oldest loaded commit's edge is
 *  inside the visible window and the engine has more pages. */
function updateLoadMore(): void {
  let show = false;
  if (nextCursor !== undefined && !loadPending && entries.length > 0) {
    const oldestMs = Math.min(...entryTimesMs());
    show = domain.start <= oldestMs;
  }
  loadMoreButton.style.display = show ? 'block' : 'none';
}

loadMoreButton.addEventListener('click', () => {
  if (nextCursor === undefined || loadPending) return;
  loadPending = true;
  post({ type: 'loadMore', cursor: nextCursor });
  updateLoadMore();
});

// --- Tooltip ----------------------------------------------------------------

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function showTooltip(entry: FileHistoryEntry, clientX: number, clientY: number): void {
  tooltip.replaceChildren();
  const addLine = (className: string, text: string): void => {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    tooltip.appendChild(div);
  };
  addLine('tooltip-summary', entry.summary);
  addLine('tooltip-meta', `${entry.sha.slice(0, 7)}  ${entry.author.name}`);
  addLine('tooltip-meta', formatDate(entry.author.time));
  const churn = document.createElement('div');
  const adds = document.createElement('span');
  adds.className = 'tooltip-adds';
  adds.textContent = `+${entry.additions}`;
  const dels = document.createElement('span');
  dels.className = 'tooltip-dels';
  dels.textContent = `−${entry.deletions}`;
  churn.append(adds, ' ', dels);
  tooltip.appendChild(churn);

  tooltip.style.display = 'block';
  const x = Math.min(clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
  const y = Math.min(clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${Math.max(0, x)}px`;
  tooltip.style.top = `${Math.max(0, y)}px`;
}

function hideTooltip(): void {
  tooltip.style.display = 'none';
}

// --- Pointer interaction ----------------------------------------------------

const DRAG_THRESHOLD_PX = 3;
let dragging = false;
let dragMoved = false;
let dragLastX = 0;

canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  dragMoved = false;
  dragLastX = event.clientX;
});

window.addEventListener('mouseup', (event) => {
  const wasDrag = dragging && dragMoved;
  dragging = false;
  canvas.classList.remove('dragging');
  if (wasDrag || event.button !== 0) return;
  const hit = hitTestBubbles(renderer.bubbles, event.clientX, event.clientY);
  if (hit !== undefined) {
    post({ type: 'openDiff', sha: entries[renderer.bubbles[hit].entryIndex].sha });
  }
});

canvas.addEventListener('mousemove', (event) => {
  if (dragging) {
    const dx = event.clientX - dragLastX;
    if (!dragMoved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    dragMoved = true;
    canvas.classList.add('dragging');
    dragLastX = event.clientX;
    const scale = plotScale(domain, window.innerWidth);
    const msPerPx = (domain.end - domain.start) / Math.max(1, scale.rangeEnd - scale.rangeStart);
    domain = panDomain(domain, -dx * msPerPx);
    userAdjustedDomain = true;
    hideTooltip();
    hoverIndex = undefined;
    render();
    return;
  }
  const hit = hitTestBubbles(renderer.bubbles, event.clientX, event.clientY);
  const index = hit === undefined ? undefined : renderer.bubbles[hit].entryIndex;
  canvas.classList.toggle('hit', index !== undefined);
  if (index !== hoverIndex) {
    hoverIndex = index;
    render();
  }
  if (index !== undefined) showTooltip(entries[index], event.clientX, event.clientY);
  else hideTooltip();
});

canvas.addEventListener('mouseleave', () => {
  hideTooltip();
  if (hoverIndex !== undefined) {
    hoverIndex = undefined;
    render();
  }
});

canvas.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.pow(2, event.deltaY * 0.002);
    const scale = plotScale(domain, window.innerWidth);
    const anchor = xToTime(scale, event.clientX);
    domain = zoomDomain(domain, anchor, factor);
    userAdjustedDomain = true;
    hideTooltip();
    hoverIndex = undefined;
    render();
  },
  { passive: false },
);

window.addEventListener('resize', render);

// --- Host messages ----------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'reset':
      entries = [];
      nextCursor = undefined;
      filePath = message.path;
      assignment = assignAuthorLanes(entries);
      userAdjustedDomain = false;
      loadPending = true;
      hoverIndex = undefined;
      hideTooltip();
      render();
      break;
    case 'entries':
      entries = [...entries, ...message.entries];
      nextCursor = message.nextCursor;
      assignment = assignAuthorLanes(entries);
      loadPending = false;
      render();
      break;
    case 'theme':
      theme = readThemeColors(getComputedStyle(document.body));
      render();
      break;
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  theme = readThemeColors(getComputedStyle(document.body));
  render();
});

post({ type: 'ready' });
render();
