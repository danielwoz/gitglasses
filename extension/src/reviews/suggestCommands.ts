// "Suggest Change for Pull Request": turn an editor selection into a
// diff-anchored review comment with a ```suggestion block on the branch's
// open PR/MR.

import * as vscode from 'vscode';
import { ProviderError, supportsReviewSuggestions } from '@gitglasses/integrations';
import type { EngineClient } from '../engine/engineClient';
import type { RepositoryService } from '../model/repositoryService';
import type { IntegrationService } from '../integrations/integrationService';
import { errorMessage } from '../commands/ui';
import { buildSuggestionBody, isAnchorRejection, selectionToRange } from './suggestLogic';

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
    if (!supportsReviewSuggestions(hosting.provider)) {
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

    const body = buildSuggestionBody({
      replacement,
      comment: comment === '' ? undefined : comment,
      gitlabLinesAbove:
        hosting.providerId === 'gitlab' ? range.endLine - range.startLine : undefined,
    });

    try {
      const { url } = await hosting.provider.createReviewSuggestion(hosting.auth, pr, {
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
