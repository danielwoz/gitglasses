// "Suggest Change for Pull Request": turn an editor selection into a
// diff-anchored review comment with a ```suggestion block on the branch's
// open PR/MR. When the suggestion cannot anchor (lines outside the PR diff,
// or a provider without the suggestions capability), the fallback shares the
// working changes as a patch link posted in a top-level PR comment.

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  ProviderError,
  supportsPrComments,
  supportsReviewSuggestions,
  supportsSnippets,
  type PullRequest,
} from '@gitglasses/integrations';
import type { EngineClient } from '../engine/engineClient';
import type { RepositoryService } from '../model/repositoryService';
import type { ConnectedHosting, IntegrationService } from '../integrations/integrationService';
import { errorMessage } from '../commands/ui';
import { envelopeToJson, patchFileName as patchFileNameFor } from '../patches/patchLogic';
import {
  buildPatchCommentBody,
  buildSuggestionBody,
  isAnchorRejection,
  selectionToRange,
  type SuggestionRange,
} from './suggestLogic';

interface FallbackInput {
  repoId: string;
  rootPath: string;
  relativePath: string;
  range: SuggestionRange;
  replacement: string;
  comment?: string;
}

/**
 * Share-as-patch-link fallback: confirm, create a patch envelope from the
 * working changes (the engine's wip source has no per-file filter, so the
 * patch carries the whole WIP including the suggested lines), share it via
 * the provider's snippet host (or a file when snippets are unsupported), and
 * post a top-level PR comment linking it.
 */
async function sharePatchLinkFallback(
  engine: EngineClient,
  hosting: ConnectedHosting,
  pr: PullRequest,
  input: FallbackInput,
): Promise<void> {
  if (!supportsPrComments(hosting.provider)) return;

  const choice = await vscode.window.showWarningMessage(
    "Can't anchor a suggestion here — share as a patch link instead?",
    {
      modal: true,
      detail:
        'GitGlasses will create a patch from your working changes, share it, and post a ' +
        `comment with the link on ${pr.repo.owner}/${pr.repo.name}#${pr.number}.`,
    },
    'Share as Patch Link',
  );
  if (choice !== 'Share as Patch Link') return;

  const summary = `Suggestion for ${input.relativePath} (PR #${pr.number})`;
  let envelope;
  try {
    ({ envelope } = await engine.request('patch/create', {
      repoId: input.repoId,
      source: { kind: 'wip', includeUntracked: true },
      summary,
    }));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `GitGlasses: creating the patch failed: ${errorMessage(error)}`,
    );
    return;
  }
  if (envelope.patch.trim() === '') {
    void vscode.window.showInformationMessage(
      'GitGlasses: the working tree has no changes to share as a patch.',
    );
    return;
  }
  const json = envelopeToJson(envelope);

  let patchUrl: string | undefined;
  let patchFile: string | undefined;
  if (supportsSnippets(hosting.provider)) {
    try {
      ({ url: patchUrl } = await hosting.provider.createSnippet(hosting.auth, {
        filename: 'patch.ggpatch',
        content: json,
        description: summary,
        secret: true,
      }));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: sharing the patch failed: ${errorMessage(error)}`,
      );
      return;
    }
  } else {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(input.rootPath, patchFileNameFor(summary))),
      filters: { 'GitGlasses Patch': ['ggpatch'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
    patchFile = path.basename(target.fsPath);
  }

  const body = buildPatchCommentBody({
    path: input.relativePath,
    startLine: input.range.startLine,
    endLine: input.range.endLine,
    replacement: input.replacement,
    comment: input.comment,
    patchUrl,
    patchFileName: patchFile,
  });
  try {
    const { url } = await hosting.provider.createPullRequestComment(hosting.auth, pr, body);
    const open = await vscode.window.showInformationMessage(
      `GitGlasses: patch link posted as a comment on ${pr.repo.owner}/${pr.repo.name}#${pr.number}.`,
      'Open',
    );
    if (open === 'Open') void vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `GitGlasses: posting the comment failed: ${errorMessage(error)}`,
    );
  }
}

export function registerSuggestChange(
  engine: EngineClient,
  repos: RepositoryService,
  integrations: IntegrationService,
): vscode.Disposable {
  return vscode.commands.registerCommand('gitglasses.suggestChange', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage(
        'GitGlasses: select the lines to suggest a change for.',
      );
      return;
    }
    if (editor.document.isDirty) {
      void vscode.window.showWarningMessage(
        'GitGlasses: save the file first — suggestions anchor to the pull request head, and unsaved edits shift the lines.',
      );
      return;
    }

    const located = await repos.locateOrDiscover(editor.document.uri);
    if (!located) {
      void vscode.window.showWarningMessage('GitGlasses: file is not in a git repository.');
      return;
    }

    const hosting = await integrations.getConnectedHostingFor(located.rootPath, true);
    if (!hosting) {
      void vscode.window.showInformationMessage(
        'GitGlasses: no connected hosting integration for this repository.',
      );
      return;
    }
    const canSuggest = supportsReviewSuggestions(hosting.provider);
    if (!canSuggest && !supportsPrComments(hosting.provider)) {
      void vscode.window.showInformationMessage(
        `GitGlasses: ${hosting.providerId} does not support review suggestions.`,
      );
      return;
    }

    let branch = '';
    try {
      const { head } = await engine.request('repo/state', { repoId: located.repoId });
      branch = head.detached ? '' : head.branch;
    } catch {
      // Fall through to the guidance below.
    }
    if (branch === '') {
      void vscode.window.showWarningMessage(
        'GitGlasses: could not determine the current branch (detached HEAD?).',
      );
      return;
    }

    let pr;
    try {
      pr = await hosting.provider.getPullRequestForBranch(hosting.auth, hosting.repo, branch);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: looking up the pull request failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (!pr) {
      void vscode.window.showInformationMessage(
        `GitGlasses: no open pull request for branch "${branch}".`,
      );
      return;
    }

    const selection = editor.selection;
    const range = selectionToRange({
      startLine: selection.start.line,
      startCharacter: selection.start.character,
      endLine: selection.end.line,
      endCharacter: selection.end.character,
    });
    const selectedText = editor.document.getText(
      new vscode.Range(
        range.startLine - 1,
        0,
        range.endLine - 1,
        editor.document.lineAt(range.endLine - 1).text.length,
      ),
    );

    const replacement = await vscode.window.showInputBox({
      prompt: `Replacement for lines ${range.startLine}-${range.endLine}`,
      value: selectedText,
      ignoreFocusOut: true,
    });
    if (replacement === undefined) return;
    const comment = await vscode.window.showInputBox({
      prompt: 'Optional comment (leave empty for none)',
      ignoreFocusOut: true,
    });
    if (comment === undefined) return;
    const prose = comment === '' ? undefined : comment;

    const fallbackInput: FallbackInput = {
      repoId: located.repoId,
      rootPath: located.rootPath,
      relativePath: located.relativePath,
      range,
      replacement,
      comment: prose,
    };

    // Providers that can comment but not suggest go straight to the fallback.
    const provider = hosting.provider;
    if (!supportsReviewSuggestions(provider)) {
      await sharePatchLinkFallback(engine, hosting, pr, fallbackInput);
      return;
    }

    const body = buildSuggestionBody({
      replacement,
      comment: prose,
      gitlabLinesAbove:
        hosting.providerId === 'gitlab' ? range.endLine - range.startLine : undefined,
    });

    try {
      const { url } = await provider.createReviewSuggestion(hosting.auth, pr, {
        path: located.relativePath,
        startLine: range.startLine,
        endLine: range.endLine,
        body,
      });
      const open = await vscode.window.showInformationMessage(
        `GitGlasses: suggestion posted to ${pr.repo.owner}/${pr.repo.name}#${pr.number}.`,
        'Open',
      );
      if (open === 'Open') void vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      if (error instanceof ProviderError && isAnchorRejection(error.status)) {
        if (supportsPrComments(hosting.provider)) {
          await sharePatchLinkFallback(engine, hosting, pr, fallbackInput);
          return;
        }
        void vscode.window.showErrorMessage(
          'GitGlasses: the provider rejected the comment anchor — the selected lines are not ' +
            'part of the pull request diff. Your branch likely has unpushed or uncommitted ' +
            'changes on these lines; push them and try again.',
        );
        return;
      }
      void vscode.window.showErrorMessage(
        `GitGlasses: posting the suggestion failed: ${errorMessage(error)}`,
      );
    }
  });
}
