// Line Story panel: why one line is the way it is. gitglasses.showLineStory
// opens it from the blame hover, the editor's context menu and the command
// palette; the host sends the story again as each part of it arrives.

import './lineStory.css';
import type { HostToLineStoryMessage, LineStoryPanelState, LineStoryToHostMessage } from './ipc';
import { renderError, renderLoading, renderStory } from './render';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const post = (message: LineStoryToHostMessage): void => vscode.postMessage(message);

const root = document.createElement('main');
root.id = 'line-story';
root.setAttribute('aria-label', 'Line story');
root.setAttribute('aria-busy', 'true');
document.body.append(root);

window.addEventListener('message', (event: MessageEvent<HostToLineStoryMessage>) => {
  const message = event.data;
  // The panel serializer reopens the same line after a reload.
  vscode.setState(message.state satisfies LineStoryPanelState);
  switch (message.type) {
    case 'loading':
      root.setAttribute('aria-busy', 'true');
      renderLoading(root, message.file);
      break;
    case 'story': {
      const { story } = message.view;
      const busy = [story.commit, story.pullRequests, story.issues, story.history].some(
        (part) => part.state === 'loading',
      );
      root.setAttribute('aria-busy', String(busy));
      renderStory(root, message.view, post);
      break;
    }
    case 'error':
      root.setAttribute('aria-busy', 'false');
      renderError(root, message.message, post);
      break;
  }
});

renderLoading(root, 'this line');
post({ type: 'ready' });
