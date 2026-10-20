// fakeVscode plus what the commit graph host and the commit details views
// use: webview panels whose messages tests deliver and inspect, commands
// whose executions are recorded (and can be made to fail), and the window
// messages they show. Use it with
//   vi.mock('vscode', () => import('./support/fakeWebviewVscode'));

import * as base from './fakeVscode';

export * from './fakeVscode';

type Listener<T> = (value: T) => unknown;

const disposable = { dispose: () => undefined };

/** A webview panel: `deliver` hands it a message from the webview and
 *  resolves once the host has handled it; `posted` holds what the host sent. */
export class FakeWebviewPanel {
  readonly posted: unknown[] = [];
  private receive: Listener<unknown> | undefined;
  private readonly disposed = new base.EventEmitter<void>();
  title = '';
  iconPath: unknown;
  readonly webview = {
    options: {},
    html: '',
    cspSource: 'fake-csp',
    asWebviewUri: (uri: base.FakeUri) => uri,
    postMessage: async (message: unknown) => {
      this.posted.push(message);
      return true;
    },
    onDidReceiveMessage: (listener: Listener<unknown>) => {
      this.receive = listener;
      return disposable;
    },
  };
  readonly onDidDispose = this.disposed.event;

  async deliver(message: unknown): Promise<void> {
    await this.receive?.(message);
  }

  /** Messages the host posted, of one type. */
  postedOfType<T extends { type: string }>(type: string): T[] {
    return this.posted.filter(
      (message): message is T => (message as { type?: string }).type === type,
    );
  }

  reveal(): void {}

  dispose(): void {
    this.disposed.fire();
  }
}

export const recorded = {
  /** Every executeCommand call, in order. */
  commands: [] as { command: string; args: unknown[] }[],
  /** Commands that reject when executed, with the error they reject with. */
  failing: new Map<string, Error>(),
  panels: [] as FakeWebviewPanel[],

  reset(): void {
    this.commands = [];
    this.failing.clear();
    this.panels = [];
    base.controls.reset();
  },
};

export const ViewColumn = { Active: -1, One: 1 };

export const commands = {
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    recorded.commands.push({ command, args });
    const failure = recorded.failing.get(command);
    if (failure) throw failure;
    return undefined;
  },
  registerCommand: () => disposable,
};

export const window = {
  ...base.window,
  async showErrorMessage(message: string): Promise<undefined> {
    base.controls.messages.push(message);
    return undefined;
  },
  async showInputBox(): Promise<undefined> {
    return undefined;
  },
  setStatusBarMessage: () => disposable,
  onDidChangeActiveColorTheme: () => disposable,
  createWebviewPanel(): FakeWebviewPanel {
    const panel = new FakeWebviewPanel();
    recorded.panels.push(panel);
    return panel;
  },
  registerWebviewPanelSerializer: () => disposable,
};

export const workspace = {
  get workspaceFolders() {
    return base.workspace.workspaceFolders;
  },
  get textDocuments() {
    return base.workspace.textDocuments;
  },
  isTrusted: true,
  getConfiguration: base.workspace.getConfiguration,
  onDidChangeConfiguration: base.workspace.onDidChangeConfiguration,
  onDidSaveTextDocument: base.workspace.onDidSaveTextDocument,
  onDidChangeTextDocument: base.workspace.onDidChangeTextDocument,
  onDidCloseTextDocument: base.workspace.onDidCloseTextDocument,
  onDidChangeWorkspaceFolders: base.workspace.onDidChangeWorkspaceFolders,
  createFileSystemWatcher: base.workspace.createFileSystemWatcher,
  registerTextDocumentContentProvider: () => disposable,
  fs: base.workspace.fs,
};
