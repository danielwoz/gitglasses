// Interactive rebase editor webview: commit rows with an action selector and
// optional message, reordering by drag-and-drop or Alt+Up/Down, and
// Start/Cancel wired to the extension host. While a rebase is stopped the
// plan gives way to a paused panel with the conflicted files and
// Continue/Skip/Abort. All plan state lives in the pure functions of
// rebaseLogic.ts.

import './rebase.css';
import type { HostToWebviewMessage, RebasePaused, WebviewToHostMessage } from './ipc';
import {
  ACTION_DESCRIPTIONS,
  PLAN_ACTIONS,
  PlanAction,
  PlanEntry,
  actionForKey,
  autosquash,
  hasAutosquashCandidates,
  isStalePlanRefusal,
  mergePlan,
  move,
  planFromPreview,
  setAction,
  setMessage,
  toRebaseEntries,
  validate,
} from './rebaseLogic';
import { shortSha } from '@gitglasses/protocol/sha';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: WebviewToHostMessage): void => vscode.postMessage(message);

document.body.innerHTML = `
  <div id="app">
    <header>
      <h1>Interactive Rebase</h1>
      <div id="upstream"></div>
    </header>
    <div id="notices"></div>
    <div id="banner"></div>
    <section id="editor">
      <div id="toolbar">
        <span id="hint">Older commits apply first (top to bottom). Drag rows, or focus one and press Alt+↑/↓ to move it; P R E S F D set its action.</span>
        <button id="autosquash" hidden title="Move fixup!/squash! commits under the commits they name">Autosquash</button>
      </div>
      <div id="list" role="list" aria-label="Rebase plan"></div>
      <div id="validation" role="alert"></div>
      <footer>
        <button id="start" class="primary">Start Rebase</button>
        <button id="cancel">Cancel</button>
      </footer>
    </section>
    <section id="paused" hidden></section>
    <div id="live" class="sr-only" aria-live="polite"></div>
  </div>
`;

const upstreamEl = document.getElementById('upstream') as HTMLDivElement;
const noticesEl = document.getElementById('notices') as HTMLDivElement;
const bannerEl = document.getElementById('banner') as HTMLDivElement;
const editorEl = document.getElementById('editor') as HTMLElement;
const pausedEl = document.getElementById('paused') as HTMLElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const validationEl = document.getElementById('validation') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const autosquashBtn = document.getElementById('autosquash') as HTMLButtonElement;
const liveEl = document.getElementById('live') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLSpanElement;

let plan: PlanEntry[] = [];
/** 'todo': the list of a `git rebase -i` waiting for its editor; git asks for
 *  reword and squash messages itself afterwards. */
let mode: 'plan' | 'todo' = 'plan';
let busy = false;
let stale = false;
let paused: RebasePaused | undefined;
let dragIndex: number | undefined;
/** Row to focus after the next render, so keyboard moves keep focus. */
let focusIndex: number | undefined;

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener('click', onClick);
  return element;
}

function announce(text: string): void {
  liveEl.textContent = text;
}

function renderValidation(): void {
  const errors = plan.length > 0 ? validate(plan, { messages: mode === 'plan' }) : [];
  validationEl.textContent = errors.join(' ');
  startBtn.disabled = busy || stale || plan.length === 0 || errors.length > 0;
  cancelBtn.disabled = busy;
  autosquashBtn.hidden = !hasAutosquashCandidates(plan);
  autosquashBtn.disabled = busy;
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

function rowLabel(entry: PlanEntry, index: number): string {
  return `${index + 1} of ${plan.length}: ${entry.action} ${shortSha(entry.sha)} ${entry.summary}`;
}

function changeAction(index: number, action: PlanAction): void {
  plan = setAction(plan, index, action);
  // A reword starts from the commit's current message.
  if (mode === 'plan' && action === 'reword' && plan[index].message === '') {
    post({ type: 'fetchMessage', sha: plan[index].sha });
  }
  render();
}

function moveRow(index: number, to: number): void {
  if (to < 0 || to >= plan.length || to === index) return;
  plan = move(plan, index, to);
  focusIndex = to;
  render();
  announce(`Moved ${plan[to].summary} to position ${to + 1} of ${plan.length}`);
}

function renderRow(entry: PlanEntry, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'listitem');
  row.tabIndex = 0;
  row.setAttribute('aria-label', rowLabel(entry, index));
  row.classList.add(`action-${entry.action}`);

  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  handle.setAttribute('aria-hidden', 'true');
  // Dragging starts from the handle only, so text/textarea selection inside
  // the row keeps working.
  handle.addEventListener('mousedown', () => {
    if (!busy) row.draggable = true;
  });

  const shaEl = document.createElement('code');
  shaEl.className = 'sha';
  shaEl.textContent = shortSha(entry.sha);
  shaEl.title = entry.sha;

  const select = document.createElement('select');
  select.setAttribute('aria-label', `Action for ${shortSha(entry.sha)}`);
  for (const action of PLAN_ACTIONS) {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = action;
    option.title = ACTION_DESCRIPTIONS[action];
    select.append(option);
  }
  select.value = entry.action;
  select.title = ACTION_DESCRIPTIONS[entry.action];
  select.disabled = busy;
  select.addEventListener('change', () => changeAction(index, select.value as PlanAction));

  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = entry.summary;
  summary.title = entry.summary;

  row.append(handle, shaEl, select, summary);

  if (mode === 'plan' && (entry.action === 'reword' || entry.action === 'squash')) {
    const textarea = document.createElement('textarea');
    textarea.placeholder =
      entry.action === 'reword'
        ? 'New commit message'
        : "Message for the combined commit; leave empty to keep git's combined message";
    textarea.setAttribute('aria-label', `Message for ${shortSha(entry.sha)}`);
    textarea.value = entry.message;
    textarea.disabled = busy;
    // Tall enough for the whole message, up to a point.
    const fitRows = (): void => {
      textarea.rows = Math.min(12, Math.max(2, textarea.value.split('\n').length + 1));
    };
    fitRows();
    textarea.addEventListener('input', () => {
      plan = setMessage(plan, index, textarea.value);
      fitRows();
      renderValidation();
    });
    row.append(textarea);
  }

  row.addEventListener('keydown', (event) => {
    // Keys typed into the select or the message belong to them.
    if (event.target !== row || busy) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -1 : 1;
      if (event.altKey) {
        moveRow(index, index + delta);
      } else {
        rowElements()[index + delta]?.focus();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const action = actionForKey(event.key);
    if (action) {
      event.preventDefault();
      focusIndex = index;
      changeAction(index, action);
      announce(`${shortSha(entry.sha)} set to ${action}`);
    }
  });

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
  editorEl.hidden = paused !== undefined;
  pausedEl.hidden = paused === undefined;
  if (paused) {
    renderPaused(paused);
    return;
  }
  const scrollTop = listEl.scrollTop;
  listEl.replaceChildren(...plan.map((entry, index) => renderRow(entry, index)));
  listEl.scrollTop = scrollTop;
  if (focusIndex !== undefined) {
    rowElements()[focusIndex]?.focus();
    focusIndex = undefined;
  }
  renderValidation();
}

function renderPaused(state: RebasePaused): void {
  const heading = document.createElement('h2');
  heading.textContent =
    state.step !== undefined && state.total !== undefined
      ? `Rebase paused at step ${state.step} of ${state.total}`
      : 'Rebase paused';

  const explanation = document.createElement('p');
  const endings = 'Skip leaves this commit out; Abort puts the branch back as it was.';
  if (state.conflicted.length > 0) {
    explanation.textContent = `${state.conflicted.length} file${
      state.conflicted.length === 1 ? ' has' : 's have'
    } conflicts. Open each one, resolve it and mark it resolved, then Continue. ${endings}`;
  } else if (state.error) {
    explanation.textContent = `git stopped with the error below. Fix the cause, then Continue. ${endings}`;
  } else if (state.reason === 'conflicts') {
    explanation.textContent = `All conflicts are resolved. Continue commits the resolution and goes on with the rebase. ${endings}`;
  } else if (state.reason === 'stopped') {
    explanation.textContent =
      'git stopped here as planned. Amend the commit or add commits, then Continue.';
  } else {
    explanation.textContent = `Nothing is blocking the rebase. If git stopped so you could edit this commit, amend it first, then Continue. ${endings}`;
  }

  const parts: HTMLElement[] = [heading, explanation];
  if (state.error) {
    const pre = document.createElement('pre');
    pre.className = 'git-output';
    pre.textContent = state.error;
    parts.push(pre);
  }
  if (state.conflicted.length > 0) {
    const files = document.createElement('ul');
    files.className = 'files';
    for (const path of state.conflicted) {
      const item = document.createElement('li');
      const open = document.createElement('a');
      open.href = '#';
      open.textContent = path;
      open.title = `Open ${path}`;
      open.addEventListener('click', (event) => {
        event.preventDefault();
        post({ type: 'openFile', path });
      });
      const resolved = button('Mark Resolved', () => post({ type: 'markResolved', path }));
      resolved.title = 'Stage the file as resolved (git add)';
      resolved.disabled = busy;
      item.append(open, resolved);
      files.append(item);
    }
    parts.push(files);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const continueBtn = button('Continue', () => post({ type: 'continue' }), 'primary');
  const skipBtn = button('Skip This Commit', () => post({ type: 'skip' }));
  const abortBtn = button('Abort Rebase', () => post({ type: 'abort' }));
  const scmBtn = button('Open Source Control', () => post({ type: 'showChanges' }));
  for (const control of [continueBtn, skipBtn, abortBtn]) control.disabled = busy;
  actions.append(continueBtn, skipBtn, abortBtn, scmBtn);
  parts.push(actions);
  pausedEl.replaceChildren(...parts);
}

function showBanner(
  kind: 'warning' | 'error',
  title: string,
  body: string,
  action?: HTMLElement,
): void {
  const banner = document.createElement('div');
  banner.className = `banner ${kind}`;
  banner.setAttribute('role', 'alert');
  const strong = document.createElement('strong');
  strong.textContent = title;
  banner.append(strong);
  const text = document.createElement(kind === 'error' ? 'pre' : 'span');
  text.textContent = body;
  banner.append(text);
  if (action) banner.append(action);
  bannerEl.replaceChildren(banner);
}

function clearBanner(): void {
  bannerEl.replaceChildren();
}

function renderNotices(mergeCount: number, autoStash: boolean): void {
  const notices: string[] = [];
  if (mergeCount > 0) {
    notices.push(
      `${mergeCount} merge commit${mergeCount === 1 ? ' is' : 's are'} not listed: the rebase flattens merges, so their changes come through the commits they merged.`,
    );
  }
  if (autoStash) {
    notices.push(
      'Your uncommitted changes are stashed before the rebase and restored after it. If they conflict with the rebased branch, they stay in the stash.',
    );
  }
  noticesEl.replaceChildren(
    ...notices.map((text) => {
      const note = document.createElement('div');
      note.className = 'notice';
      note.textContent = text;
      return note;
    }),
  );
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
  if (validate(plan, { messages: mode === 'plan' }).length > 0 || plan.length === 0 || stale) {
    return;
  }
  post({ type: 'start', plan: toRebaseEntries(plan) });
});

cancelBtn.addEventListener('click', () => post({ type: 'cancel' }));

autosquashBtn.addEventListener('click', () => {
  plan = autosquash(plan);
  render();
  announce('Fixup and squash commits moved under the commits they name');
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      mode = message.mode ?? 'plan';
      upstreamEl.replaceChildren();
      const upstream = document.createElement('code');
      upstream.textContent = message.upstream;
      if (mode === 'todo') {
        upstreamEl.append('git rebase -i is waiting for this list: ', upstream);
        startBtn.textContent = 'Save and Continue';
        cancelBtn.textContent = 'Cancel Rebase';
        cancelBtn.title = 'Hand git an empty list: the rebase stops before anything changes';
        hintEl.textContent =
          'Older commits apply first (top to bottom). Drag rows, or focus one and press Alt+↑/↓ to move it; P R E S F D set its action. git asks for reword and squash messages afterwards. Closing this tab runs the list as git wrote it.';
      } else {
        const branch = document.createElement('code');
        branch.textContent = message.branch;
        upstreamEl.append('Rebasing ', branch, ' onto ', upstream);
      }
      renderNotices(message.mergeCount, message.autoStash);
      plan = message.keepPlan ? mergePlan(plan, message.entries) : planFromPreview(message.entries);
      stale = false;
      paused = undefined;
      clearBanner();
      render();
      break;
    }
    case 'busy':
      busy = message.busy;
      render();
      break;
    case 'stale':
      stale = true;
      showBanner(
        'warning',
        'The branch changed. ',
        `${message.reason} Reload the plan so it matches what will be rebased.`,
        button('Reload Plan', () => post({ type: 'reload' })),
      );
      renderValidation();
      break;
    case 'error':
      // An out-of-date plan cannot start, so while it is (or the engine says
      // it is) the banner keeps the way to reload it rather than a Dismiss
      // that would leave Start disabled with nothing to press.
      if (mode === 'plan' && isStalePlanRefusal(message.message)) stale = true;
      showBanner(
        'error',
        'The rebase did not run.',
        message.message,
        stale
          ? button('Reload Plan', () => post({ type: 'reload' }))
          : button('Dismiss', clearBanner),
      );
      renderValidation();
      break;
    case 'paused': {
      const { type: _type, ...state } = message;
      paused = state;
      if (!upstreamEl.textContent) upstreamEl.textContent = 'A rebase is in progress.';
      clearBanner();
      render();
      break;
    }
    case 'message': {
      const index = plan.findIndex((entry) => entry.sha === message.sha);
      if (index >= 0 && plan[index].action === 'reword' && plan[index].message === '') {
        plan = setMessage(plan, index, message.message);
        render();
      }
      break;
    }
  }
});

renderValidation();
post({ type: 'ready' });
