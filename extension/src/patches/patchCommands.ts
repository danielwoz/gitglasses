// Open Patches UI: create a shareable patch envelope from WIP / stash /
// commit / range and save, copy, or share it as a Gist/Snippet; apply an
// envelope obtained from a file, URL, or the clipboard.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PatchEnvelope, PatchFileChange, RequestParams } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import { defaultFetch, supportsSnippets } from '@gitglasses/integrations';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import type { IntegrationService } from '../integrations/integrationService';
import { getSnippetText } from '../integrations/providerSetup';
import { requireRepo, type ActiveRepo, type ViewNode } from '../views/viewBase';
import { errorMessage, showConflictGuidance } from '../commands/ui';
import {
  classifySnippetUrl,
  confirmDetail,
  confirmMessage,
  envelopeToJson,
  parseEnvelope,
  patchFileName,
  snippetProviderHost,
} from './patchLogic';
import {
  EnvelopeFormatError,
  decryptEnvelope,
  encryptEnvelope,
  isEncryptedEnvelope,
} from './envelopeCrypto';

type PatchSource = RequestParams<'patch/create'>['source'];

interface SourcePick {
  source: PatchSource;
  defaultSummary: string;
}

async function pickSource(
  engine: EngineClient,
  repo: ActiveRepo,
  node?: ViewNode,
): Promise<SourcePick | undefined> {
  // Context-menu invocations carry the commit/stash node the user clicked.
  if (node?.sha && node.item.contextValue === 'gitglassesCommit') {
    return {
      source: { kind: 'commit', sha: node.sha },
      defaultSummary: node.commit?.summary ?? shortSha(node.sha),
    };
  }
  if (node?.sha && node.item.contextValue === 'gitglassesStash') {
    const { entries } = await engine.request('stash/list', { repoId: repo.repoId });
    const entry = entries.find((candidate) => candidate.sha === node.sha);
    if (entry) {
      return { source: { kind: 'stash', index: entry.index }, defaultSummary: entry.message };
    }
  }

  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Working changes', id: 'wip' as const },
      { label: '$(archive) A stash…', id: 'stash' as const },
      { label: '$(git-commit) A commit…', id: 'commit' as const },
      { label: '$(git-compare) Branch range…', id: 'range' as const },
    ],
    { placeHolder: 'Create a patch from…' },
  );
  if (!kind) return undefined;

  switch (kind.id) {
    case 'wip':
      return { source: { kind: 'wip', includeUntracked: true }, defaultSummary: 'Working changes' };
    case 'stash': {
      const { entries } = await engine.request('stash/list', { repoId: repo.repoId });
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('GitGlasses: no stashes in this repository.');
        return undefined;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.message,
          description: `stash@{${entry.index}}`,
          entry,
        })),
        { placeHolder: 'Create a patch from which stash?' },
      );
      if (!picked) return undefined;
      return {
        source: { kind: 'stash', index: picked.entry.index },
        defaultSummary: picked.entry.message,
      };
    }
    case 'commit': {
      const { commits } = await engine.request('log/commits', { repoId: repo.repoId, limit: 50 });
      const picked = await vscode.window.showQuickPick(
        commits.map((commit) => ({
          label: commit.summary,
          description: shortSha(commit.sha),
          commit,
        })),
        { placeHolder: 'Create a patch from which commit?', matchOnDescription: true },
      );
      if (!picked) return undefined;
      return {
        source: { kind: 'commit', sha: picked.commit.sha },
        defaultSummary: picked.commit.summary,
      };
    }
    case 'range': {
      const base = await vscode.window.showInputBox({
        prompt: 'Base ref (patch contains commits after this)',
        placeHolder: 'main',
      });
      if (!base) return undefined;
      const head = await vscode.window.showInputBox({ prompt: 'Head ref', value: 'HEAD' });
      if (!head) return undefined;
      return { source: { kind: 'range', base, head }, defaultSummary: `${base}..${head}` };
    }
  }
}

/** Passphrase prompt with confirmation for encrypted sharing. */
async function promptNewPassphrase(): Promise<string | undefined> {
  const passphrase = await vscode.window.showInputBox({
    prompt: 'Passphrase to encrypt the patch (share it out-of-band)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.length >= 8 ? undefined : 'At least 8 characters'),
  });
  if (passphrase === undefined) return undefined;
  const confirmation = await vscode.window.showInputBox({
    prompt: 'Confirm the passphrase',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value === passphrase ? undefined : 'Passphrases do not match'),
  });
  if (confirmation === undefined) return undefined;
  return passphrase;
}

async function deliverPatch(
  integrations: IntegrationService,
  repo: ActiveRepo,
  envelope: PatchEnvelope,
): Promise<void> {
  const hosting = await integrations.getConnectedHostingFor(repo.rootPath).catch(() => undefined);
  const snippetHost =
    hosting && supportsSnippets(hosting.provider) ? hosting : undefined;
  const snippetLabel = snippetHost?.providerId === 'gitlab' ? 'Snippet' : 'Gist';

  interface DestinationItem extends vscode.QuickPickItem {
    id: 'file' | 'snippet' | 'encrypted' | 'clipboard';
  }
  const destinations: DestinationItem[] = [
    { id: 'file', label: '$(save) Save to File…' },
  ];
  if (snippetHost) {
    destinations.push({
      id: 'snippet',
      label: `$(link) Share via ${snippetLabel}`,
      description: snippetHost.host,
    });
  }
  destinations.push({
    id: 'encrypted',
    label: '$(lock) Share Encrypted…',
    description: 'passphrase-protected (scrypt + AES-256-GCM)',
  });
  destinations.push({ id: 'clipboard', label: '$(clippy) Copy to Clipboard' });

  const destination = await vscode.window.showQuickPick(destinations, {
    placeHolder: 'Share the patch how?',
  });
  if (!destination) return;

  // Encrypted sharing wraps the envelope, then reuses the gist/file paths.
  let json = envelopeToJson(envelope);
  let target: 'file' | 'snippet' | 'clipboard' = destination.id === 'encrypted' ? 'file' : destination.id;
  if (destination.id === 'encrypted') {
    const passphrase = await promptNewPassphrase();
    if (passphrase === undefined) return;
    json = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitGlasses: encrypting patch…' },
      () => encryptEnvelope(json, passphrase),
    );
    if (snippetHost) {
      const how = await vscode.window.showQuickPick(
        [
          { id: 'snippet' as const, label: `$(link) Share via ${snippetLabel}`, description: snippetHost.host },
          { id: 'file' as const, label: '$(save) Save to File…' },
        ],
        { placeHolder: 'Share the encrypted patch how?' },
      );
      if (!how) return;
      target = how.id;
    }
  }

  if (target === 'file') {
    const saved = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(repo.rootPath, patchFileName(envelope.summary))),
      filters: { 'GitGlasses Patch': ['ggpatch'] },
    });
    if (!saved) return;
    await vscode.workspace.fs.writeFile(saved, new TextEncoder().encode(json));
    void vscode.window.showInformationMessage(`GitGlasses: patch saved to ${saved.fsPath}.`);
    return;
  }

  if (target === 'snippet' && snippetHost && supportsSnippets(snippetHost.provider)) {
    try {
      const { url } = await snippetHost.provider.createSnippet(snippetHost.auth, {
        filename: 'patch.ggpatch',
        content: json,
        description: envelope.summary,
        secret: true,
      });
      await vscode.env.clipboard.writeText(url);
      const open = await vscode.window.showInformationMessage(
        `GitGlasses: patch shared — URL copied to the clipboard.`,
        'Open',
      );
      if (open === 'Open') void vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: sharing the patch failed: ${errorMessage(error)}`,
      );
    }
    return;
  }

  await vscode.env.clipboard.writeText(json);
  void vscode.window.showInformationMessage('GitGlasses: patch envelope copied to the clipboard.');
}

async function createPatch(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
  node?: ViewNode,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;

  let picked: SourcePick | undefined;
  try {
    picked = await pickSource(engine, repo, node);
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: creating patch failed: ${errorMessage(error)}`);
    return;
  }
  if (!picked) return;

  const summary = await vscode.window.showInputBox({
    prompt: 'Patch summary',
    value: picked.defaultSummary,
  });
  if (summary === undefined) return;

  let envelope: PatchEnvelope;
  try {
    ({ envelope } = await engine.request('patch/create', {
      repoId: repo.repoId,
      source: picked.source,
      summary: summary === '' ? undefined : summary,
    }));
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: creating patch failed: ${errorMessage(error)}`);
    return;
  }
  if (envelope.patch.trim() === '') {
    void vscode.window.showInformationMessage('GitGlasses: the selected source has no changes.');
    return;
  }
  await deliverPatch(integrations, repo, envelope);
}

/** Fetch the envelope text behind a URL, via a connected snippet host when possible. */
async function fetchPatchText(integrations: IntegrationService, url: string): Promise<string> {
  const cls = classifySnippetUrl(url);
  if (!cls) throw new Error('not an http(s) URL');
  const wantedHost = snippetProviderHost(cls);
  if (wantedHost) {
    for (const entry of await integrations.getConnectedHostingEntries()) {
      if (entry.host !== wantedHost || !supportsSnippets(entry.provider)) continue;
      return getSnippetText(entry.provider, entry.auth, entry.host, url);
    }
  }
  // No connected provider serves this host: fetch the raw URL directly.
  const response = await defaultFetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`fetching the URL failed with status ${response.status}`);
  return response.text();
}

async function obtainEnvelopeText(
  integrations: IntegrationService,
): Promise<string | undefined> {
  const source = await vscode.window.showQuickPick(
    [
      { label: '$(file) From File…', id: 'file' as const },
      { label: '$(link) From URL…', id: 'url' as const },
      { label: '$(clippy) From Clipboard', id: 'clipboard' as const },
    ],
    { placeHolder: 'Apply a patch from…' },
  );
  if (!source) return undefined;

  if (source.id === 'file') {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'GitGlasses Patch': ['ggpatch', 'json'], 'All Files': ['*'] },
    });
    if (!picked?.[0]) return undefined;
    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    return new TextDecoder().decode(bytes);
  }

  if (source.id === 'url') {
    const url = await vscode.window.showInputBox({
      prompt: 'Patch URL (gist, snippet, or raw envelope URL)',
      validateInput: (value) =>
        /^https?:\/\//i.test(value.trim()) ? undefined : 'Enter an http(s) URL',
    });
    if (!url) return undefined;
    return fetchPatchText(integrations, url.trim());
  }

  return vscode.env.clipboard.readText();
}

const PATCH_SCHEME = 'gitglasses-patch';

/** Read-only documents showing a patch before it is applied. */
class PatchDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private next = 1;

  async show(envelope: PatchEnvelope): Promise<void> {
    const name = patchFileName(envelope.summary).replace(/\.ggpatch$/, '.diff');
    const uri = vscode.Uri.from({ scheme: PATCH_SCHEME, path: `/${this.next++}/${name}` });
    // Only the latest few stay; an older tab shows a note instead.
    if (this.contents.size >= 8) {
      const oldest = this.contents.keys().next().value;
      if (oldest !== undefined) this.contents.delete(oldest);
    }
    this.contents.set(uri.toString(), envelope.patch);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'diff');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? 'This patch is no longer available.\n';
  }

  dispose(): void {
    this.contents.clear();
  }
}

/** Asks for the passphrase of an encrypted envelope, three attempts, and
 *  returns the decrypted envelope text. Undefined when the user gives up. */
async function decryptWithPrompt(text: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const passphrase = await vscode.window.showInputBox({
      prompt:
        attempt === 1
          ? 'This patch is encrypted — enter its passphrase'
          : `Wrong passphrase — try again (attempt ${attempt} of 3)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) return undefined;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GitGlasses: decrypting patch…' },
        () => decryptEnvelope(text, passphrase),
      );
    } catch (error) {
      if (attempt === 3 || error instanceof EnvelopeFormatError) {
        void vscode.window.showErrorMessage(`GitGlasses: ${errorMessage(error)}.`);
        return undefined;
      }
    }
  }
  return undefined;
}

async function applyPatch(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
  patchDocuments: PatchDocuments,
): Promise<void> {
  const repo = await requireRepo(repos);
  if (!repo) return;

  let text: string | undefined;
  try {
    text = await obtainEnvelopeText(integrations);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `GitGlasses: fetching the patch failed: ${errorMessage(error)}`,
    );
    return;
  }
  if (text === undefined) return;

  if (isEncryptedEnvelope(text)) {
    const decrypted = await decryptWithPrompt(text);
    if (decrypted === undefined) return;
    text = decrypted;
  }

  const parsed = parseEnvelope(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`GitGlasses: cannot apply patch — ${parsed.error}.`);
    return;
  }
  const envelope = parsed.envelope;

  // The confirmation lists what git apply itself reads in the patch, so a
  // plain diff or a mislabelled envelope cannot understate what it changes.
  let files: PatchFileChange[];
  try {
    const preview = await engine.request('patch/apply', {
      repoId: repo.repoId,
      envelope,
      dryRun: true,
    });
    files = preview.files ?? [];
  } catch (error) {
    void vscode.window.showErrorMessage(
      `GitGlasses: cannot apply patch — git cannot read it: ${errorMessage(error)}`,
    );
    return;
  }
  if (files.length === 0) {
    void vscode.window.showErrorMessage('GitGlasses: cannot apply patch — it changes no files.');
    return;
  }

  const message = confirmMessage(files);
  const detail = confirmDetail(envelope, files);
  let choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    'Apply',
    'Show Patch',
  );
  if (choice === 'Show Patch') {
    await patchDocuments.show(envelope);
    // Not modal, so the patch can be read and scrolled while this waits.
    choice = await vscode.window.showWarningMessage(
      `${message} (${files.length} ${files.length === 1 ? 'file' : 'files'}, shown in the editor)`,
      'Apply',
    );
  }
  if (choice !== 'Apply') return;

  try {
    const result = await engine.request('patch/apply', { repoId: repo.repoId, envelope });
    if (!result.applied && !result.baseFound) {
      void vscode.window.showErrorMessage(
        `GitGlasses: the patch base commit ${shortSha(envelope.baseSha)} is not in this ` +
          'repository, so a 3-way apply was not possible. Fetch from the remote the patch ' +
          'was created against, then try again.',
      );
      return;
    }
    if (result.conflicts) {
      showConflictGuidance('Apply patch');
      return;
    }
    if (result.applied) {
      void vscode.window.showInformationMessage(
        `GitGlasses: patch applied${result.baseFound ? '' : ' (3-way merge; base commit not present locally)'}.`,
      );
      return;
    }
    void vscode.window.showErrorMessage(
      `GitGlasses: the patch could not be applied${result.message ? `: ${result.message}` : '.'}`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: applying patch failed: ${errorMessage(error)}`);
  }
}

export function registerPatchCommands(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
): vscode.Disposable[] {
  const patchDocuments = new PatchDocuments();
  return [
    patchDocuments,
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, patchDocuments),
    vscode.commands.registerCommand('gitglasses.createPatch', (node?: ViewNode) =>
      createPatch(engine, repos, integrations, node),
    ),
    vscode.commands.registerCommand('gitglasses.applyPatch', () =>
      applyPatch(engine, repos, integrations, patchDocuments),
    ),
  ];
}
