// Interactive rebase editor webview: commit rows with an action selector and
// optional message, drag-drop reordering with an insertion indicator, and
// Start/Cancel wired to the extension host. All plan state lives in the pure
// functions of rebaseLogic.ts.

import './rebase.css';
import type { HostToWebviewMessage, WebviewToHostMessage } from './ipc';
import {
  PLAN_ACTIONS,
  PlanAction,
  PlanEntry,
  move,
  planFromPreview,
  setAction,
  setMessage,
  sha7,
  toRebaseEntries,
  validate,
} from './rebaseLogic';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHostMessage): void => vscode.postMessage(message);

document.body.innerHTML = `
  <div id="app">
    <header>
      <h1>Interactive Rebase</h1>
      <div id="upstream"></div>
    </header>
    <div id="hint">Drag rows to reorder. Older commits apply first (top to bottom).</div>
    <div id="list"></div>
    <div id="validation"></div>
    <footer>
      <button id="start" class="primary">Start Rebase</button>
      <button id="cancel">Cancel</button>
    </footer>
  </div>
`;

const upstreamEl = document.getElementById('upstream') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const validationEl = document.getElementById('validation') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;

let plan: PlanEntry[] = [];
let busy = false;
let dragIndex: number | undefined;

function renderValidation(): void {
  const errors = plan.length > 0 ? validate(plan) : [];
  validationEl.textContent = errors.join(' ');
  startBtn.disabled = busy || plan.length === 0 || errors.length > 0;
  cancelBtn.disabled = busy;
}

function rowElements(): HTMLElement[] {
  return [...listEl.children] as HTMLElement[];
}

function clearIndicator(): void {
  listEl.classList.remove('insert-end');
  for (const row of rowElements()) row.classList.remove('insert-above');
}

/** Insertion slot (0..plan.length) for a drag at viewport `y`. */
function insertionIndexFromY(y: number): number {
  const rows = rowElements();
  for (let i = 0; i < rows.length; i++) {
    const rect = rows[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return i;
  }
  return rows.length;
}

function showIndicatorAt(slot: number): void {
  clearIndicator();
  const rows = rowElements();
  if (slot >= rows.length) listEl.classList.add('insert-end');
  else rows[slot].classList.add('insert-above');
}

function renderRow(entry: PlanEntry, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  if (entry.action === 'drop') row.classList.add('dropped');

  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  // Dragging starts from the handle only, so text/textarea selection inside
  // the row keeps working.
  handle.addEventListener('mousedown', () => {
    if (!busy) row.draggable = true;
  });

  const shaEl = document.createElement('code');
  shaEl.className = 'sha';
  shaEl.textContent = sha7(entry.sha);
  shaEl.title = entry.sha;

  const select = document.createElement('select');
  for (const action of PLAN_ACTIONS) {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = action;
    select.append(option);
  }
  select.value = entry.action;
  select.disabled = busy;
  select.addEventListener('change', () => {
    plan = setAction(plan, index, select.value as PlanAction);
    render();
  });

  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = entry.summary;
  summary.title = entry.summary;

  row.append(handle, shaEl, select, summary);

  if (entry.action === 'reword' || entry.action === 'squash') {
    const textarea = document.createElement('textarea');
    textarea.placeholder =
      entry.action === 'reword' ? 'New commit message' : 'Message for the squashed commit';
    textarea.value = entry.message;
    textarea.disabled = busy;
    textarea.addEventListener('input', () => {
      plan = setMessage(plan, index, textarea.value);
      renderValidation();
    });
    row.append(textarea);
  }

  row.addEventListener('dragstart', (event) => {
    dragIndex = index;
    row.classList.add('dragging');
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    clearIndicator();
    dragIndex = undefined;
  });

  return row;
}

function render(): void {
  const scrollTop = listEl.scrollTop;
  listEl.replaceChildren(...plan.map((entry, index) => renderRow(entry, index)));
  listEl.scrollTop = scrollTop;
  renderValidation();
}

listEl.addEventListener('dragover', (event) => {
  if (dragIndex === undefined) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  showIndicatorAt(insertionIndexFromY(event.clientY));
});

listEl.addEventListener('dragleave', (event) => {
  if (event.target === listEl) clearIndicator();
});

listEl.addEventListener('drop', (event) => {
  if (dragIndex === undefined) return;
  event.preventDefault();
  const slot = insertionIndexFromY(event.clientY);
  const to = slot > dragIndex ? slot - 1 : slot;
  plan = move(plan, dragIndex, to);
  dragIndex = undefined;
  render();
});

startBtn.addEventListener('click', () => {
  if (validate(plan).length > 0 || plan.length === 0) return;
  post({ type: 'start', plan: toRebaseEntries(plan) });
});

cancelBtn.addEventListener('click', () => post({ type: 'cancel' }));

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      upstreamEl.innerHTML = '';
      upstreamEl.append('Rebasing onto ');
      const code = document.createElement('code');
      code.textContent = message.upstream;
      upstreamEl.append(code);
      plan = planFromPreview(message.entries);
      render();
      break;
    }
    case 'busy':
      busy = message.busy;
      render();
      break;
  }
});

renderValidation();
post({ type: 'ready' });
