// The AI commands end to end against the real engine and a scripted editor,
// with Ollama answering through a stubbed fetch: Explain Commit sends the
// commit's own diff (from git, or computed from the file versions where git
// may not run, and only the files that fit for a very large commit), its
// result never carries an image, and Generate Commit Message writes into the
// Source Control box, or commits from an editor that keeps its line breaks.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '@gitglasses/rpc';
import { createProcessTransportFactory } from '@gitglasses/rpc/node';

const fake = vi.hoisted(() => {
  interface Doc {
    content: string;
    language?: string;
    getText(): string;
  }
  const state = {
    settings: new Map<string, unknown>(),
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    executed: [] as { command: string; args: unknown[] }[],
    contentProviders: new Map<string, { provideTextDocumentContent(uri: unknown): string }>(),
    messages: [] as string[],
    messageChoices: [] as (string | undefined)[],
    inputs: [] as (string | undefined)[],
    documents: [] as Doc[],
    gitRepositories: undefined as { rootUri: unknown; inputBox: { value: string } }[] | undefined,
    clipboard: '',
    reset(): void {
      this.settings = new Map([['gitglasses.ai.provider', 'ollama']]);
      this.executed = [];
      this.messages = [];
      this.messageChoices = [];
      this.inputs = [];
      this.documents = [];
      this.gitRepositories = undefined;
      this.clipboard = '';
    },
  };
  class EventEmitter<T> {
    private listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
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
  const uri = (scheme: string, fsPath: string) => ({
    scheme,
    fsPath,
    path: fsPath,
    toString: () => `${scheme}:${fsPath}`,
  });
  const message = async (text: string): Promise<string | undefined> => {
    state.messages.push(text);
    return state.messageChoices.shift();
  };
  const vscode = {
    EventEmitter,
    Uri: {
      from: (parts: { scheme: string; path?: string }) => uri(parts.scheme, parts.path ?? ''),
      file: (fsPath: string) => uri('file', fsPath),
      joinPath: (base: { fsPath: string }, ...segments: string[]) =>
        uri('file', [base.fsPath, ...segments].join('/')),
      parse: (value: string) => uri('https', value),
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        state.commands.set(id, handler);
        return { dispose: () => state.commands.delete(id) };
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        state.executed.push({ command, args });
      },
    },
    workspace: {
      workspaceFolders: undefined,
      registerTextDocumentContentProvider: (
        scheme: string,
        provider: { provideTextDocumentContent(uri: unknown): string },
      ) => {
        state.contentProviders.set(scheme, provider);
        return { dispose: () => state.contentProviders.delete(scheme) };
      },
      openTextDocument: async (options: { content: string; language?: string }) => {
        const doc = { ...options, getText: () => doc.content };
        state.documents.push(doc);
        return doc;
      },
      getConfiguration: (section: string) => ({
        get: <T>(name: string, fallback?: T): T | undefined =>
          (state.settings.has(`${section}.${name}`)
            ? state.settings.get(`${section}.${name}`)
            : fallback) as T | undefined,
        inspect: (name: string) => ({
          key: name,
          globalValue: state.settings.get(`${section}.${name}`),
        }),
        update: async () => undefined,
      }),
    },
    window: {
      withProgress: async <T>(
        _options: unknown,
        task: (progress: unknown, token: unknown) => Promise<T>,
      ) =>
        task(
          { report: () => undefined },
          {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined }),
          },
        ),
      showInputBox: async () => state.inputs.shift(),
      showQuickPick: async () => undefined,
      showInformationMessage: message,
      showWarningMessage: message,
      showErrorMessage: message,
      showTextDocument: async () => undefined,
      setStatusBarMessage: () => ({ dispose: () => undefined }),
    },
    extensions: {
      getExtension: (id: string) =>
        id === 'vscode.git' && state.gitRepositories
          ? {
              isActive: true,
              exports: { enabled: true, getAPI: () => ({ repositories: state.gitRepositories }) },
            }
          : undefined,
    },
    env: {
      clipboard: {
        writeText: async (text: string) => {
          state.clipboard = text;
        },
      },
      openExternal: async () => true,
    },
    lm: { selectChatModels: async () => [] },
  };
  return { state, vscode };
});

vi.mock('vscode', () => fake.vscode);

import { registerAiFeatures } from '../src/ai/features';
import { setActiveRepoResolver } from '../src/views/viewBase';

const { state } = fake;

const repoRoot = path.resolve(__dirname, '..', '..');
const engineExe = process.platform === 'win32' ? 'gitglasses-engine.exe' : 'gitglasses-engine';
const enginePath = ['release', 'debug']
  .map((p) => path.join(repoRoot, 'build', p, 'engine', engineExe))
  .find(existsSync);

if (!enginePath) {
  throw new Error('engine binary not built; run: cmake --build --preset debug');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const LONG_FILE = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n';

/** A repository whose last commit changes one line near the end of each of
 *  three long files, under a subject written to smuggle in an image. */
function makeRepo(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gg-ai-features-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(path.join(root, name), LONG_FILE);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    writeFileSync(
      path.join(root, name),
      LONG_FILE.replace('const line450 = 450;', `const line450 = 'changed in ${name}';`),
    );
  }
  git(root, 'add', '-A');
  git(
    root,
    'commit',
    '-q',
    '-m',
    'fix: tidy \\`![x](https://evil.example/t.png)`',
    '-m',
    'The values were off by one.\n\nRefs: #12',
  );
  return root;
}

/** Ollama on localhost, answering every chat with `answer`. */
function stubOllama(answer: string): { prompts: string[] } {
  const prompts: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    let body: unknown = { models: [{ name: 'gemma4:latest' }] };
    if (url.endsWith('/api/chat')) {
      const request = JSON.parse(init?.body ?? '{}') as { messages: { content: string }[] };
      prompts.push(request.messages.map((m) => m.content).join('\n---\n'));
      body = { message: { content: answer }, done_reason: 'stop' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  return { prompts };
}

/** Records every method the commands ask the engine for. */
function recording(engine: EngineClient): { engine: EngineClient; methods: string[] } {
  const methods: string[] = [];
  const proxy = new Proxy(engine, {
    get(target, property, receiver) {
      if (property === 'request') {
        return (method: string, ...rest: unknown[]) => {
          methods.push(method);
          return (target.request as (...args: unknown[]) => unknown).call(target, method, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy, methods };
}

const context = {
  secrets: {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  },
  globalState: { get: () => undefined, update: async () => undefined },
} as never;

let root: string;
const clients: EngineClient[] = [];

async function startEngine(restricted: boolean): Promise<EngineClient> {
  const client = new EngineClient(
    createProcessTransportFactory({ enginePath: enginePath!, restricted }),
  );
  await client.start();
  clients.push(client);
  return client;
}

async function register(engine: EngineClient, repoPath = root) {
  const { repoId } = await engine.request('repo/discover', { path: repoPath });
  setActiveRepoResolver(async () => ({ repoId, rootPath: repoPath }));
  const repos = {
    locateOrDiscover: async () => ({ repoId, rootPath: repoPath }),
    rootOf: () => repoPath,
    isRootOf: (_id: string, candidate: string) => realpathSync(candidate) === repoPath,
  } as never;
  const disposables = registerAiFeatures(context, engine, repos);
  return {
    run: (command: string, ...args: unknown[]) => state.commands.get(command)!(...args),
    dispose: () => disposables.forEach((disposable) => disposable.dispose()),
  };
}

/** The last AI result shown, as the Markdown preview receives it. */
function shownResult(): string {
  const preview = state.executed.filter((call) => call.command === 'markdown.showPreview').pop();
  expect(preview).toBeDefined();
  return state.contentProviders.get('gitglasses-ai')!.provideTextDocumentContent(preview!.args[0]);
}

beforeAll(() => {
  root = makeRepo();
});

beforeEach(() => state.reset());

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveRepoResolver(undefined);
});

afterAll(() => {
  for (const client of clients) client.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('Explain Commit', () => {
  const answer =
    'Changes one value per file. ![p](https://evil.example/p.png) <img src="https://evil.example/q.png">';

  it("sends the commit's own diff and whole message, and shows no image", async () => {
    const ollama = stubOllama(answer);
    const { engine, methods } = recording(await startEngine(false));
    const ai = await register(engine);
    await ai.run('gitglasses.ai.explainCommit', { sha: 'HEAD' });
    const shown = shownResult();
    ai.dispose();

    expect(methods).toContain('patch/create');
    expect(ollama.prompts).toHaveLength(1);
    const prompt = ollama.prompts[0];
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      expect(prompt).toContain(`+const line450 = 'changed in ${name}';`);
    }
    expect(prompt).toContain('-const line450 = 450;');
    expect(prompt).toContain('The values were off by one.');
    expect(prompt).toContain('Refs: #12');
    // Unchanged lines far from the change are not sent.
    expect(prompt).not.toContain('const line10 = 10;');

    expect(shown).toContain('Changes one value per file.');
    expect(shown).not.toMatch(/!\[|<[A-Za-z]/);
    expect(shown).toContain('fix\\: tidy');
  });

  it('computes the same diff from the file versions in Restricted Mode', async () => {
    const ollama = stubOllama(answer);
    const { engine, methods } = recording(await startEngine(true));
    const ai = await register(engine);
    await ai.run('gitglasses.ai.explainCommit', { sha: 'HEAD' });
    ai.dispose();

    expect(methods).toContain('rev/fileAtRev');
    expect(state.messages).toEqual([]);
    const prompt = ollama.prompts[0];
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      expect(prompt).toContain(`+const line450 = 'changed in ${name}';`);
    }
    expect(prompt).toContain('-const line450 = 450;');
    expect(prompt).not.toContain('const line10 = 10;');
  });

  it('reads only the files that fit from a very large commit', async () => {
    const big = realpathSync(mkdtempSync(path.join(tmpdir(), 'gg-ai-big-')));
    try {
      git(big, 'init', '-q', '-b', 'main');
      git(big, 'config', 'commit.gpgsign', 'false');
      git(big, 'config', 'user.name', 'Fixture');
      git(big, 'config', 'user.email', 'fixture@example.invalid');
      for (let i = 0; i < 400; i++)
        writeFileSync(path.join(big, `m${i}.js`), `export const a${i} = ${i};\n`);
      git(big, 'add', '-A');
      git(big, 'commit', '-q', '-m', 'vendor drop');

      const ollama = stubOllama('A vendor drop.');
      const { engine, methods } = recording(await startEngine(false));
      const ai = await register(engine, big);
      await ai.run('gitglasses.ai.explainCommit', { sha: 'HEAD' });
      ai.dispose();

      expect(methods).not.toContain('patch/create');
      expect(methods.filter((method) => method === 'rev/fileAtRev').length).toBeLessThanOrEqual(30);
      expect(ollama.prompts[0]).toContain('+export const a0 = 0;');
      expect(ollama.prompts[0]).toContain('in 400 files (not all shown)');
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('Generate Commit Message', () => {
  const message = 'feat: greet the user\n\n- add a greeting\n- keep the old one';
  let work: string;

  beforeEach(() => {
    work = realpathSync(mkdtempSync(path.join(tmpdir(), 'gg-ai-message-')));
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'config', 'user.name', 'Fixture');
    git(work, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(work, 'greet.txt'), 'hello\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    writeFileSync(path.join(work, 'greet.txt'), 'hello\nhi there\n');
    git(work, 'add', 'greet.txt');
  });

  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('writes the message into the Source Control box of that repository', async () => {
    const ollama = stubOllama(message);
    const box = { rootUri: fake.vscode.Uri.file(work), inputBox: { value: '' } };
    state.gitRepositories = [box];
    const { engine, methods } = recording(await startEngine(false));
    const ai = await register(engine, work);
    await ai.run('gitglasses.ai.generateCommitMessage', { rootUri: box.rootUri });
    ai.dispose();

    expect(ollama.prompts[0]).toContain('+hi there');
    expect(box.inputBox.value).toBe(message);
    expect(state.executed.map((call) => call.command)).toContain('workbench.view.scm');
    expect(methods).not.toContain('mutate/commit');
    expect(git(work, 'log', '-1', '--format=%s')).toBe('base\n');
  });

  it('commits from an editor that keeps the line breaks without the Git extension', async () => {
    stubOllama(message);
    state.messageChoices.push('Commit Staged Changes');
    const ai = await register(await startEngine(false), work);
    await ai.run('gitglasses.ai.generateCommitMessage');
    ai.dispose();

    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]).toMatchObject({ content: message, language: 'git-commit' });
    expect(git(work, 'log', '-1', '--format=%B').trim()).toBe(message);
  });
});
