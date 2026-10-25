// A stand-in for the parts of the vscode API that the repository model and
// the document plumbing use, so they run under vitest. Workspace folders,
// settings and events are driven through `controls`; workspace.fs reads the
// real filesystem.
//
// Use it from a test file with
//   vi.mock('vscode', () => import('./support/fakeVscode'));

import * as fs from 'node:fs';
import * as path from 'node:path';

type Listener<T> = (value: T) => void;

export class EventEmitter<T = void> {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export interface FakeUri {
  scheme: string;
  fsPath: string;
  path: string;
  query: string;
  toString(): string;
}

export const Uri = {
  file(fsPath: string): FakeUri {
    return { scheme: 'file', fsPath, path: fsPath, query: '', toString: () => `file://${fsPath}` };
  },
  from(parts: { scheme: string; path?: string; query?: string }): FakeUri {
    const uriPath = parts.path ?? '';
    const query = parts.query ?? '';
    return {
      scheme: parts.scheme,
      fsPath: uriPath,
      path: uriPath,
      query,
      toString: () => `${parts.scheme}:${uriPath}${query ? `?${query}` : ''}`,
    };
  },
  joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return Uri.file(path.join(base.fsPath, ...segments));
  },
};

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

export interface FakeTextDocument {
  uri: FakeUri;
  isDirty: boolean;
  isClosed: boolean;
  version: number;
  getText(): string;
}

export interface ConfigurationChange {
  affectsConfiguration(section: string): boolean;
}

export const controls = {
  /** Workspace folder paths, in order. */
  folders: [] as string[],
  /** Settings by full key, such as 'git.repositoryScanMaxDepth'. */
  settings: new Map<string, unknown>(),
  workspaceFoldersChanged: new EventEmitter<void>(),
  configurationChanged: new EventEmitter<ConfigurationChange>(),
  /** Events of every file system watcher created. */
  created: new EventEmitter<FakeUri>(),
  deleted: new EventEmitter<FakeUri>(),
  /** Glob patterns file system watchers were created for. */
  watchedPatterns: [] as string[],
  documentChanged: new EventEmitter<{ document: FakeTextDocument }>(),
  documentClosed: new EventEmitter<FakeTextDocument>(),
  documentSaved: new EventEmitter<FakeTextDocument>(),
  messages: [] as string[],
  /** Documents workspace.textDocuments lists. */
  openDocuments: [] as Array<{ uri: FakeUri }>,
  /** Commands run through commands.executeCommand, with their arguments. */
  executed: [] as Array<{ command: string; args: unknown[] }>,

  reset(): void {
    this.folders = [];
    this.settings.clear();
    this.watchedPatterns = [];
    this.messages = [];
    this.openDocuments = [];
    this.executed = [];
  },

  /** Fires a configuration change touching the given setting keys. */
  changeSettings(...keys: string[]): void {
    this.configurationChanged.fire({
      affectsConfiguration: (section) =>
        keys.some((key) => key === section || key.startsWith(`${section}.`)),
    });
  },
};

function entryType(dir: string, entry: fs.Dirent): number {
  if (entry.isSymbolicLink()) {
    try {
      const target = fs.statSync(path.join(dir, entry.name));
      return FileType.SymbolicLink | (target.isDirectory() ? FileType.Directory : FileType.File);
    } catch {
      return FileType.SymbolicLink;
    }
  }
  if (entry.isDirectory()) return FileType.Directory;
  return entry.isFile() ? FileType.File : FileType.Unknown;
}

export const workspace = {
  get workspaceFolders() {
    if (controls.folders.length === 0) return undefined;
    return controls.folders.map((folder, index) => ({
      uri: Uri.file(folder),
      name: path.basename(folder),
      index,
    }));
  },
  get textDocuments(): Array<{ uri: FakeUri }> {
    return controls.openDocuments;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const full = `${section}.${key}`;
        return controls.settings.has(full) ? (controls.settings.get(full) as T) : fallback;
      },
    };
  },
  createFileSystemWatcher(pattern: string) {
    controls.watchedPatterns.push(pattern);
    return {
      onDidCreate: controls.created.event,
      onDidDelete: controls.deleted.event,
      onDidChange: new EventEmitter<FakeUri>().event,
      dispose: () => undefined,
    };
  },
  onDidChangeWorkspaceFolders: controls.workspaceFoldersChanged.event,
  onDidChangeConfiguration: controls.configurationChanged.event,
  onDidChangeTextDocument: controls.documentChanged.event,
  onDidCloseTextDocument: controls.documentClosed.event,
  onDidSaveTextDocument: controls.documentSaved.event,
  fs: {
    async readDirectory(uri: FakeUri): Promise<[string, number][]> {
      return fs
        .readdirSync(uri.fsPath, { withFileTypes: true })
        .map((entry) => [entry.name, entryType(uri.fsPath, entry)]);
    },
    async readFile(uri: FakeUri): Promise<Uint8Array> {
      return fs.readFileSync(uri.fsPath);
    },
  },
};

export const window = {
  async showWarningMessage(message: string): Promise<undefined> {
    controls.messages.push(message);
    return undefined;
  },
  async showInformationMessage(message: string): Promise<undefined> {
    controls.messages.push(message);
    return undefined;
  },
  async showQuickPick(): Promise<undefined> {
    return undefined;
  },
};

export const commands = {
  async executeCommand(command: string, ...args: unknown[]): Promise<undefined> {
    controls.executed.push({ command, args });
    return undefined;
  },
};

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class ThemeIcon {
  constructor(readonly id: string) {}
}

/** Markdown as a hover or tooltip holds it; `value` is what VS Code renders. */
export class MarkdownString {
  supportThemeIcons = false;
  isTrusted: boolean | { enabledCommands: readonly string[] } = false;

  constructor(public value = '') {}

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    readonly label: string,
    readonly collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}

/** A text document for the change, close and save events. */
export function textDocument(fsPath: string, text: string, version = 1): FakeTextDocument {
  return { uri: Uri.file(fsPath), isDirty: true, isClosed: false, version, getText: () => text };
}
