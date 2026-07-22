// Open Patches UI: create a shareable patch envelope from WIP / stash /
// commit / range and save, copy, or share it as a Gist/Snippet; apply an
// envelope obtained from a file, URL, or the clipboard.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PatchEnvelope, RequestParams } from '@gitglasses/protocol';
import { defaultFetch, supportsSnippets, type AuthContext } from '@gitglasses/integrations';
import type { EngineClient } from '../engine/engineClient';
import type { RepositoryService } from '../model/repositoryService';
import type { IntegrationService } from '../integrations/integrationService';
import { firstWorkspaceRepo, type ActiveRepo, type ViewNode } from '../views/viewBase';
import { errorMessage, showConflictGuidance } from '../commands/ui';
import {
  classifySnippetUrl,
  confirmDetail,
  envelopeToJson,
  extractDiffStat,
  parseEnvelope,
  patchFileName,
  snippetProviderHost,
} from './patchLogic';

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
      defaultSummary: node.commit?.summary ?? node.sha.slice(0, 7),
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
          description: commit.sha.slice(0, 7),
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

async function deliverPatch(
  integrations: IntegrationService,
  repo: ActiveRepo,
  envelope: PatchEnvelope,
): Promise<void> {
  const json = envelopeToJson(envelope);
  const hosting = await integrations.getConnectedHostingFor(repo.rootPath).catch(() => undefined);
  const snippetHost =
    hosting && supportsSnippets(hosting.provider) ? hosting : undefined;

  interface DestinationItem extends vscode.QuickPickItem {
    id: 'file' | 'snippet' | 'clipboard';
  }
  const destinations: DestinationItem[] = [
    { id: 'file', label: '$(save) Save to File…' },
  ];
  if (snippetHost) {
    destinations.push({
      id: 'snippet',
      label: `$(link) Share via ${snippetHost.providerId === 'gitlab' ? 'Snippet' : 'Gist'}`,
      description: snippetHost.host,
    });
  }
  destinations.push({ id: 'clipboard', label: '$(clippy) Copy to Clipboard' });

  const destination = await vscode.window.showQuickPick(destinations, {
    placeHolder: 'Share the patch how?',
  });
  if (!destination) return;

  if (destination.id === 'file') {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(repo.rootPath, patchFileName(envelope.summary))),
      filters: { 'GitGlasses Patch': ['ggpatch'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
    void vscode.window.showInformationMessage(`GitGlasses: patch saved to ${target.fsPath}.`);
    return;
  }

  if (destination.id === 'snippet' && snippetHost && supportsSnippets(snippetHost.provider)) {
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
  const repo = await firstWorkspaceRepo(repos);
  if (!repo) {
    void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
    return;
  }

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
      const auth: AuthContext = { token: entry.auth.token };
      return entry.provider.getSnippet(auth, url);
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

async function applyPatch(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
): Promise<void> {
  const repo = await firstWorkspaceRepo(repos);
  if (!repo) {
    void vscode.window.showWarningMessage('GitGlasses: no git repository in this workspace.');
    return;
  }

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

  const parsed = parseEnvelope(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`GitGlasses: cannot apply patch — ${parsed.error}.`);
    return;
  }
  const envelope = parsed.envelope;

  const stat = extractDiffStat(envelope.patch);
  const choice = await vscode.window.showWarningMessage(
    'Apply this patch to the repository?',
    { modal: true, detail: confirmDetail(envelope, stat) },
    'Apply',
  );
  if (choice !== 'Apply') return;

  try {
    const result = await engine.request('patch/apply', { repoId: repo.repoId, envelope });
    if (!result.applied && !result.baseFound) {
      void vscode.window.showErrorMessage(
        `GitGlasses: the patch base commit ${envelope.baseSha.slice(0, 7)} is not in this ` +
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
    void vscode.window.showErrorMessage('GitGlasses: the patch could not be applied.');
  } catch (error) {
    void vscode.window.showErrorMessage(`GitGlasses: applying patch failed: ${errorMessage(error)}`);
  }
}

export function registerPatchCommands(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gitglasses.createPatch', (node?: ViewNode) =>
      createPatch(engine, repos, integrations, node),
    ),
    vscode.commands.registerCommand('gitglasses.applyPatch', () =>
      applyPatch(engine, repos, integrations),
    ),
  ];
}
