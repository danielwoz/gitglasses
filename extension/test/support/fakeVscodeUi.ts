// A stand-in for the vscode UI the prompt and sync flows use: input boxes,
// quick picks, notifications, progress and commands. A test scripts the
// user's answers through `ui` and reads back what was shown.
//
// Use it from a test file with
//   vi.mock('vscode', () => import('./support/fakeVscodeUi'));

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

export const Uri = {
  file(fsPath: string) {
    return { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` };
  },
  joinPath(base: { fsPath: string }, ...segments: string[]) {
    return Uri.file([base.fsPath, ...segments].join('/'));
  },
};

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class TreeItem {
  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export const QuickInputButtons = { Back: { id: 'back' } };

/** A quick input the code under test opened. */
export interface ShownInput {
  kind: 'input' | 'pick';
  title?: string;
  prompt?: string;
  placeholder?: string;
  password?: boolean;
  items?: { label: string }[];
  disposed: boolean;
  accept(valueOrIndex: string | number): void;
  hide(): void;
}

/** How a scripted answer responds to a quick input or message. */
export type Answer = (shown: ShownInput) => void;

export const ui = {
  shown: [] as ShownInput[],
  messages: [] as { level: 'error' | 'warning' | 'info'; text: string; buttons: string[] }[],
  status: [] as string[],
  progress: [] as string[],
  executed: [] as { command: string; args: unknown[] }[],
  /** Answers quick inputs in order; one left unanswered stays open. */
  answers: [] as Answer[],
  /** The button each message gets, in order; undefined dismisses it. */
  messageChoices: [] as (string | undefined)[],
  /** Answers for showQuickPick, in order: an item label, or undefined. */
  quickPickChoices: [] as (string | undefined)[],
  /** When set, progress tasks see this token cancelled after `cancelAfterMs`. */
  cancelProgressAfterMs: undefined as number | undefined,
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  reset(): void {
    ui.shown = [];
    ui.messages = [];
    ui.status = [];
    ui.progress = [];
    ui.executed = [];
    ui.answers = [];
    ui.messageChoices = [];
    ui.quickPickChoices = [];
    ui.cancelProgressAfterMs = undefined;
    ui.commands.clear();
  },
};

function quickInput(kind: 'input' | 'pick') {
  const accept = new EventEmitter<void>();
  const hide = new EventEmitter<void>();
  const shown: ShownInput & { value: string; selectedItems: unknown[] } = {
    kind,
    disposed: false,
    value: '',
    selectedItems: [],
    accept(valueOrIndex) {
      if (typeof valueOrIndex === 'number') {
        shown.selectedItems = [shown.items?.[valueOrIndex]];
      } else {
        shown.value = valueOrIndex;
      }
      accept.fire();
    },
    hide() {
      hide.fire();
    },
  };
  const control = {
    set title(value: string | undefined) {
      shown.title = value;
    },
    set prompt(value: string | undefined) {
      shown.prompt = value;
    },
    set placeholder(value: string | undefined) {
      shown.placeholder = value;
    },
    set password(value: boolean) {
      shown.password = value;
    },
    set items(value: { label: string }[]) {
      shown.items = value;
    },
    get value() {
      return shown.value;
    },
    get selectedItems() {
      return shown.selectedItems;
    },
    ignoreFocusOut: false,
    buttons: [] as unknown[],
    validationMessage: undefined as string | undefined,
    onDidAccept: accept.event,
    onDidHide: hide.event,
    onDidTriggerButton: new EventEmitter<unknown>().event,
    onDidChangeValue: new EventEmitter<string>().event,
    show() {
      ui.shown.push(shown);
      const answer = ui.answers.shift();
      if (answer) queueMicrotask(() => answer(shown));
    },
    dispose() {
      shown.disposed = true;
    },
  };
  return control;
}

function message(level: 'error' | 'warning' | 'info') {
  return async (text: string, ...rest: unknown[]): Promise<string | undefined> => {
    const buttons = rest.filter((item): item is string => typeof item === 'string');
    ui.messages.push({ level, text, buttons });
    return ui.messageChoices.shift();
  };
}

export const window = {
  createInputBox: () => quickInput('input'),
  createQuickPick: () => quickInput('pick'),
  showErrorMessage: message('error'),
  showWarningMessage: message('warning'),
  showInformationMessage: message('info'),
  async showQuickPick<T extends { label: string }>(items: T[] | Promise<T[]>) {
    const resolved = await items;
    ui.shown.push({
      kind: 'pick',
      items: resolved,
      disposed: true,
      accept: () => undefined,
      hide: () => undefined,
    });
    const label = ui.quickPickChoices.shift();
    return resolved.find((item) => item.label === label);
  },
  setStatusBarMessage(text: string) {
    ui.status.push(text);
    return { dispose: () => undefined };
  },
  async withProgress<T>(
    options: { title?: string },
    task: (progress: unknown, token: unknown) => Promise<T>,
  ): Promise<T> {
    ui.progress.push(options.title ?? '');
    const cancel = new EventEmitter<void>();
    let cancelled = false;
    const token = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: cancel.event,
    };
    if (ui.cancelProgressAfterMs !== undefined) {
      setTimeout(() => {
        cancelled = true;
        cancel.fire();
      }, ui.cancelProgressAfterMs);
    }
    return task({ report: () => undefined }, token);
  },
};

export const commands = {
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    ui.executed.push({ command, args });
    return ui.commands.get(command)?.(...args);
  },
  registerCommand(command: string, callback: (...args: unknown[]) => unknown) {
    ui.commands.set(command, callback);
    return { dispose: () => ui.commands.delete(command) };
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback }),
};
