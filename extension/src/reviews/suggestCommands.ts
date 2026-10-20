// "Suggest Change for Pull Request": turn an editor selection into a
// diff-anchored review comment with a ```suggestion block on the branch's
// open PR/MR. When the suggestion cannot anchor (lines outside the PR diff,
// or a provider without the suggestions capability), the fallback posts the
// replacement as a top-level PR comment with a patch of just those lines.

import * as vscode from 'vscode';
import {
  ProviderError,
  supportsPrComments,
  supportsReviewSuggestions,
  supportsSnippets,
  type PullRequest,
} from '@gitglasses/integrations';
import { shortSha } from '@gitglasses/protocol/sha';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import type { ConnectedHosting, IntegrationService } from '../integrations/integrationService';
import { toAuthContext } from '../integrations/providerSetup';
import { errorMessage } from '../commands/ui';
import { envelopeToJson } from '../patches/patchLogic';
import {
  buildPatchCommentBody,
  buildSuggestionBody,
  buildSuggestionEnvelope,
  buildSuggestionPatch,
  fallbackConfirmDetail,
  firstMismatchedLine,
  isAnchorRejection,
  patchUploadFor,
  selectionToRange,
  type SuggestionRange,
} from './suggestLogic';

interface FallbackInput {
  relativePath: string;
  range: SuggestionRange;
  replacement: string;
  comment?: string;
  /** The file at the pull request head, which the patch applies to. */
  headText: string;
}

/** A full commit sha, the only base a patch envelope accepts. */
function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Patch-link fallback: show what will be shared and with whom, then post a
 * top-level PR comment with the replacement and a patch of only the
 * suggested lines, uploaded as a secret gist where the provider has one and
 * the user chooses it, and folded into the comment otherwise.
 */
async function sharePatchFallback(
  integrations: IntegrationService,
  hosting: ConnectedHosting,
  pr: PullRequest,
  input: FallbackInput,
): Promise<void> {
  if (!supportsPrComments(hosting.provider)) return;

  const patch = buildSuggestionPatch({
    path: input.relativePath,
    headText: input.headText,
    startLine: input.range.startLine,
    endLine: input.range.endLine,
    replacement: input.replacement,
  });
  const summary = `Suggestion for ${input.relativePath} (PR #${pr.number})`;
  const envelope =
    patch &&
    buildSuggestionEnvelope({
      headSha: pr.headSha,
      headRef: pr.headRef,
      summary,
      patch,
      createdAtIso: new Date().toISOString(),
    });
  const json = envelope ? envelopeToJson(envelope) : undefined;
  const upload =
    json && supportsSnippets(hosting.provider)
      ? patchUploadFor(hosting.providerId, hosting.host)
      : undefined;

  const detail = fallbackConfirmDetail({
    pr,
    path: input.relativePath,
    startLine: input.range.startLine,
    endLine: input.range.endLine,
    patch: envelope ? patch : undefined,
    upload,
  });
  const commentOnly = upload ? 'Comment Only' : 'Post Comment';
  const preview = 'Preview Patch';
  const buttons = [...(upload ? [upload.action] : []), commentOnly, ...(json ? [preview] : [])];

  let choice: string | undefined;
  for (;;) {
    choice = await vscode.window.showWarningMessage(
      "Can't anchor a suggestion here — post it as a comment with a patch instead?",
      { modal: true, detail },
      ...buttons,
    );
    if (choice !== preview || !json) break;
    // Exactly the text that would be uploaded or folded into the comment.
    const document = await vscode.workspace.openTextDocument({ content: json, language: 'json' });
    await vscode.window.showTextDocument(document, { preview: true });
  }
  if (choice === undefined) return;

  let patchUrl: string | undefined;
  if (upload && choice === upload.action && json && supportsSnippets(hosting.provider)) {
    // Creating a gist on github.com takes the gist scope, which the session
    // used for pull requests does not carry.
    let auth = hosting.auth;
    if (hosting.providerId === 'github' && hosting.host === 'github.com') {
      const gistSession = await integrations.auth.getAuth('github', 'github.com', {
        interactive: true,
        extraScopes: ['gist'],
      });
      if (!gistSession) return;
      auth = toAuthContext(gistSession, hosting.host);
    }
    try {
      ({ url: patchUrl } = await hosting.provider.createSnippet(auth, {
        filename: 'suggestion.ggpatch',
        content: json,
        description: summary,
        secret: true,
      }));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: uploading the patch failed: ${errorMessage(error)}`,
      );
      return;
    }
  }

  const body = buildPatchCommentBody({
    path: input.relativePath,
    startLine: input.range.startLine,
    endLine: input.range.endLine,
    replacement: input.replacement,
    comment: input.comment,
    patchUrl,
    inlineEnvelope: patchUrl === undefined ? json : undefined,
  });
  try {
    const { url } = await hosting.provider.createPullRequestComment(hosting.auth, pr, body);
    const open = await vscode.window.showInformationMessage(
      `GitGlasses: suggestion posted as a comment on ${pr.repo.owner}/${pr.repo.name}#${pr.number}.`,
      'Open',
    );
    if (open === 'Open') void vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `GitGlasses: posting the comment failed: ${errorMessage(error)}`,
    );
  }
}

/**
 * The file at the pull request head, or a message saying why the selection
 * cannot be checked against it.
 */
async function readAtHead(
  engine: EngineClient,
  repoId: string,
  relativePath: string,
  pr: PullRequest,
  localHead: string,
): Promise<{ text: string } | { problem: string }> {
  const prHead = shortSha(pr.headSha);
  const notLocal =
    `your branch is at ${shortSha(localHead) || 'no commit'} and the pull request head ` +
    `${prHead} is not in this repository. Pull (or push) so they match, then try again.`;
  if (!isFullSha(pr.headSha)) {
    return { problem: 'the pull request did not report its head commit.' };
  }
  try {
    const file = await engine.request('rev/fileAtRev', {
      repoId,
      path: relativePath,
      rev: pr.headSha,
    });
    if (file.binary) return { problem: `${relativePath} is a binary file at the pull request head.` };
    if (file.truncated) {
      return { problem: `${relativePath} is too large to check against the pull request head.` };
    }
    return { text: file.contents };
  } catch (error) {
    return localHead.toLowerCase() === pr.headSha.toLowerCase()
      ? { problem: `reading ${relativePath} at ${prHead} failed: ${errorMessage(error)}` }
      : { problem: notLocal };
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

    let branch = '';
    let localHead = '';
    try {
      const { head } = await engine.request('repo/state', { repoId: located.repoId });
      branch = head.detached ? '' : head.branch;
      localHead = head.oid;
    } catch {
      // Fall through to the guidance below.
    }
    if (branch === '') {
      void vscode.window.showWarningMessage(
        'GitGlasses: could not determine the current branch (detached HEAD?).',
      );
      return;
    }

    let found;
    try {
      found = await integrations.findPullRequestForBranch(located.rootPath, branch, true);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `GitGlasses: looking up the pull request failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (!found) {
      void vscode.window.showInformationMessage(
        `GitGlasses: no open pull request from branch "${branch}" (or no connected integration for its remote).`,
      );
      return;
    }
    const { hosting, pr } = found;
    const canSuggest = supportsReviewSuggestions(hosting.provider);
    if (!canSuggest && !supportsPrComments(hosting.provider)) {
      void vscode.window.showInformationMessage(
        `GitGlasses: ${hosting.providerId} does not support review suggestions.`,
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

    // Line numbers come from this file and are posted against the pull
    // request head, so the file has to read the same there down to the end of
    // the selection; otherwise the suggestion would replace different lines.
    const head = await readAtHead(engine, located.repoId, located.relativePath, pr, localHead);
    if ('problem' in head) {
      void vscode.window.showWarningMessage(
        `GitGlasses: can't suggest a change on ${pr.repo.owner}/${pr.repo.name}#${pr.number}: ${head.problem}`,
      );
      return;
    }
    const mismatch = firstMismatchedLine(editor.document.getText(), head.text, range.endLine);
    if (mismatch !== undefined) {
      void vscode.window.showWarningMessage(
        `GitGlasses: line ${mismatch} of ${located.relativePath} differs from the pull request head ` +
          `(${shortSha(pr.headSha)}), so the suggestion would land on different lines. Commit and ` +
          'push your changes, or pull the latest, then try again.',
      );
      return;
    }

    const selectedText = editor.document.getText(
      new vscode.Range(
        range.startLine - 1,
        0,
        range.endLine - 1,
        editor.document.lineAt(range.endLine - 1).text.length,
      ),
    );

    const replacement = await vscode.window.showInputBox({
      prompt: `Replacement for lines ${range.startLine}-${range.endLine} on #${pr.number} "${pr.title}"`,
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
      relativePath: located.relativePath,
      range,
      replacement,
      comment: prose,
      headText: head.text,
    };

    // Providers that can comment but not suggest go straight to the fallback.
    const provider = hosting.provider;
    if (!supportsReviewSuggestions(provider)) {
      await sharePatchFallback(integrations, hosting, pr, fallbackInput);
      return;
    }

    const lines =
      range.startLine === range.endLine
        ? `line ${range.startLine}`
        : `lines ${range.startLine}-${range.endLine}`;
    const behind =
      localHead.toLowerCase() === pr.headSha.toLowerCase()
        ? ''
        : `\n\nYour branch is at ${shortSha(localHead)} and the pull request head is ` +
          `${shortSha(pr.headSha)}; ${located.relativePath} reads the same at both down to ` +
          'the selection.';
    const confirm = await vscode.window.showInformationMessage(
      `Post a suggestion on ${pr.repo.owner}/${pr.repo.name}#${pr.number}?`,
      {
        modal: true,
        detail: `"${pr.title}"\n\n${located.relativePath}, ${lines}${behind}`,
      },
      'Post Suggestion',
    );
    if (confirm !== 'Post Suggestion') return;

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
          await sharePatchFallback(integrations, hosting, pr, fallbackInput);
          return;
        }
        void vscode.window.showErrorMessage(
          'GitGlasses: the provider rejected the comment anchor — the selected lines are not ' +
            'part of the pull request diff.',
        );
        return;
      }
      void vscode.window.showErrorMessage(
        `GitGlasses: posting the suggestion failed: ${errorMessage(error)}`,
      );
    }
  });
}
