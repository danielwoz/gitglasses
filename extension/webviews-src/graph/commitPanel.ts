// Commit Details panel: one commit, rendered by the same details view as the
// graph's pane. gitglasses.showCommitDetails opens it from anywhere (blame
// hovers, history views, terminal links), so commit inspection looks the same
// everywhere.

import './commitPanel.css';
import type {
  CommitPanelState,
  DetailsView,
  HostToCommitPanelMessage,
  DetailsToHostMessage,
} from './ipc';
import { renderDetails } from './details';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: DetailsToHostMessage | { type: 'ready' }): void =>
  vscode.postMessage(message);

const root = document.createElement('main');
root.id = 'commit-details';
root.setAttribute('aria-label', 'Commit details');
document.body.append(root);

function show(view: DetailsView | undefined): void {
  renderDetails(root, view, { post, canMutate: false });
}

window.addEventListener('message', (event: MessageEvent<HostToCommitPanelMessage>) => {
  const message = event.data;
  if (message.type === 'show') {
    // The panel serializer reopens the same commit after a reload.
    vscode.setState(message.state satisfies CommitPanelState);
    show(message.view);
  } else if (message.type === 'loading') {
    show(undefined);
  }
});

show(undefined);
post({ type: 'ready' });
