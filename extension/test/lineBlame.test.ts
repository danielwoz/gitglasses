// Where current-line blame shows (after the line, in the status bar) and what
// it asks the engine for, as the settings and VS Code's own Git blame change.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const fake = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class Emitter<T> {
    private listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
  }
  const statusBar = {
    name: '',
    text: '',
    tooltip: undefined as unknown,
    command: undefined as unknown,
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  };
  return {
    Emitter,
    statusBar,
    settings: new Map<string, unknown>(),
    gitExtensionPresent: true,
    activeTextEditor: undefined as unknown,
    selectionChanged: new Emitter<{ textEditor: unknown }>(),
    configurationChanged: new Emitter<{ affectsConfiguration(section: string): boolean }>(),
    extensionsChanged: new Emitter<void>(),
  };
});

vi.mock('vscode', async () => {
  const base = await import('./support/fakeVscode');
  class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel(): void {
      this.token.isCancellationRequested = true;
    }
    dispose(): void {}
  }
  return {
    ...base,
    CancellationTokenSource,
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    DecorationRangeBehavior: { ClosedOpen: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    window: {
      ...base.window,
      get activeTextEditor() {
        return fake.activeTextEditor;
      },
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createStatusBarItem: () => fake.statusBar,
      onDidChangeTextEditorSelection: fake.selectionChanged.event,
      onDidChangeActiveTextEditor: new fake.Emitter<unknown>().event,
    },
    workspace: {
      ...base.workspace,
      onDidChangeTextDocument: new fake.Emitter<unknown>().event,
      onDidChangeConfiguration: fake.configurationChanged.event,
      getConfiguration: () => ({ get: (key: string) => fake.settings.get(key) }),
    },
    extensions: {
      getExtension: (id: string) =>
        id === 'vscode.git' && fake.gitExtensionPresent ? { id } : undefined,
      onDidChange: fake.extensionsChanged.event,
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
  };
});

import { UNCOMMITTED_SHA } from '@gitglasses/protocol';
import { LineBlameController } from '../src/annotations/lineBlame';
import { parseBlameSettings, type BlameSettings } from '../src/annotations/blameSettings';
import type { DocumentBlameService } from '../src/annotations/documentBlame';
import type { BlameHoverRenderer } from '../src/annotations/hoverProvider';
import type { FileBlame } from '../src/model/blameModel';

const SHA = '1234567890abcdef1234567890abcdef12345678';

const blame: FileBlame = {
  hunks: [{ sha: SHA, resultLine: 1, originalLine: 1, lineCount: 2, path: 'a.txt' }],
  commits: {
    [SHA]: {
      author: { name: 'Ada', email: 'ada@example.invalid', time: 1_700_000_000 },
      committer: { name: 'Ada', email: 'ada@example.invalid', time: 1_700_000_000 },
      summary: 'add a',
      boundary: false,
    },
  },
  totalLines: 2,
  lfs: false,
} as unknown as FileBlame;

function editor() {
  const document = {
    uri: { toString: () => 'file:///w/repo/a.txt' },
    version: 1,
    lineAt: (line: number) => ({ range: { line } }),
  };
  return {
    document,
    selection: { active: { line: 0 } },
    painted: [] as string[][],
    setDecorations(
      _type: unknown,
      options: { renderOptions: { after: { contentText: string } } }[],
    ) {
      this.painted.push(options.map((o) => o.renderOptions.after.contentText));
    },
  };
}

function setup(settings: Record<string, unknown>) {
  const parsed: BlameSettings = parseBlameSettings((key) => settings[key]);
  parsed.currentLineDelay = 0;
  const changed = new fake.Emitter<void>();
  const blameDocument = vi.fn(async () => ({
    kind: 'blame' as const,
    blame,
    target: {
      documentUri: 'file:///w/repo/a.txt',
      repoId: 'r1',
      rootPath: '/w/repo',
      relativePath: 'a.txt',
    },
  }));
  const service = {
    settings: parsed,
    supports: () => true,
    blameDocument,
    onDidChangeSettings: changed.event,
  } as unknown as DocumentBlameService;
  const render = vi.fn(async () => 'tooltip');
  const renderer = { render } as unknown as BlameHoverRenderer;
  const controller = new LineBlameController(service, renderer);
  const active = editor();
  fake.activeTextEditor = active;
  return { controller, active, blameDocument, render };
}

/** Moves the cursor and waits for the annotate pass it schedules. */
async function moveCursor(active: ReturnType<typeof editor>): Promise<void> {
  fake.selectionChanged.fire({ textEditor: active as unknown as vscode.TextEditor });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  fake.settings.clear();
  fake.settings.set('git.enabled', true);
  fake.settings.set('git.blame.statusBarItem.enabled', true);
  fake.gitExtensionPresent = true;
  fake.statusBar.visible = false;
  fake.statusBar.text = '';
  fake.statusBar.tooltip = undefined;
});

describe('LineBlameController', () => {
  it('shows status bar blame alone when inline blame is off and the item is asked for', async () => {
    const { controller, active, render } = setup({
      'currentLine.enabled': false,
      'statusBar.blame': 'show',
    });
    await moveCursor(active);
    expect(fake.statusBar.visible).toBe(true);
    expect(fake.statusBar.text).toContain('Ada');
    expect(active.painted.at(-1)).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('asks for no tooltip while the status bar item is hidden', async () => {
    // auto, with VS Code's own status bar blame on: only the inline text shows.
    const { controller, active, render } = setup({});
    await moveCursor(active);
    expect(active.painted.at(-1)).toEqual([expect.stringContaining('Ada')]);
    expect(fake.statusBar.visible).toBe(false);
    expect(render).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("shows the item in auto when VS Code's own Git is turned off", async () => {
    fake.settings.set('git.enabled', false);
    const { controller, active } = setup({});
    await moveCursor(active);
    expect(fake.statusBar.visible).toBe(true);
    controller.dispose();
  });

  it('asks for nothing when neither surface is wanted', async () => {
    const { controller, active, blameDocument } = setup({
      'currentLine.enabled': false,
      'statusBar.blame': 'hide',
    });
    await moveCursor(active);
    expect(blameDocument).not.toHaveBeenCalled();
    expect(fake.statusBar.visible).toBe(false);
    controller.dispose();
  });

  it('hides the item at once when the built-in item turns on', async () => {
    fake.settings.set('git.blame.statusBarItem.enabled', false);
    const { controller, active } = setup({});
    await moveCursor(active);
    expect(fake.statusBar.visible).toBe(true);
    fake.settings.set('git.blame.statusBarItem.enabled', true);
    fake.configurationChanged.fire({
      affectsConfiguration: (section) => section === 'git.blame.statusBarItem.enabled',
    });
    expect(fake.statusBar.visible).toBe(false);
    controller.dispose();
  });

  it('keeps the uncommitted line pointing at its own document', async () => {
    const { controller, active, blameDocument } = setup({ 'statusBar.blame': 'show' });
    blameDocument.mockResolvedValueOnce({
      kind: 'blame',
      blame: {
        ...blame,
        hunks: [
          { sha: UNCOMMITTED_SHA, resultLine: 1, originalLine: 1, lineCount: 1, path: 'a.txt' },
        ],
      } as FileBlame,
      target: {
        documentUri: 'file:///w/repo/a.txt',
        repoId: 'r1',
        rootPath: '/w/repo',
        relativePath: 'a.txt',
      },
    });
    await moveCursor(active);
    expect(fake.statusBar.command).toMatchObject({
      command: 'gitglasses.diffWithHead',
      arguments: [{ uri: 'file:///w/repo/a.txt' }],
    });
    controller.dispose();
  });
});
