// GitGlasses: Fetch git-ai Notes with Every Fetch…: git does not fetch notes
// by default, so a clone never sees the provenance git-ai records in
// refs/notes/ai unless the remote's fetch refspecs bring it. The command adds
// that refspec to the repository's own git config, after the user confirms.
// The notes land in a ref of the remote's own (refs/notes/ai-remote/<remote>,
// as git-ai names it), so fetches never replace the local refs/notes/ai and
// the notes written there for commits not yet pushed; the engine reads both.

import * as vscode from 'vscode';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import { requireRepo } from '../views/viewBase';
import { errorMessage } from '../commands/ui';
import { fetch } from '../sync/syncCommands';

export const FETCH_NOTES_COMMAND = 'gitglasses.provenance.fetchNotes';

export const GIT_AI_NOTES_REF = 'refs/notes/ai';

/** The ref a remote's git-ai notes are fetched into, as the engine and git-ai
 *  name it: other characters than letters, digits, '-' and '_' become '_'. */
export function remoteNotesRef(remote: string): string {
  return `${GIT_AI_NOTES_REF}-remote/${remote.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The remote to offer first: origin when there is one. */
export function preferredRemotes(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
}

export function registerProvenanceCommands(
  engine: EngineClient,
  repos: RepositoryService,
  log: (line: string) => void,
): vscode.Disposable[] {
  const fetchNotes = async (): Promise<void> => {
    const repo = await requireRepo(repos);
    if (!repo) return;
    try {
      const { remotes } = await engine.request('remote/list', { repoId: repo.repoId });
      const names = preferredRemotes(remotes.map((remote) => remote.name));
      if (names.length === 0) {
        void vscode.window.showInformationMessage(
          'GitGlasses: this repository has no remote to fetch git-ai notes from.',
        );
        return;
      }
      const remote =
        names.length === 1
          ? names[0]
          : (
              await vscode.window.showQuickPick(
                names.map((name) => ({ label: name })),
                { placeHolder: 'Remote whose fetches should bring git-ai notes' },
              )
            )?.label;
      if (!remote) return;

      const add = 'Add Refspec';
      const addAndFetch = 'Add and Fetch Now';
      const tracking = remoteNotesRef(remote);
      const choice = await vscode.window.showInformationMessage(
        `Fetch git-ai notes from ${remote}?`,
        {
          modal: true,
          detail:
            `Adds +${GIT_AI_NOTES_REF}:${tracking} to remote.${remote}.fetch in this ` +
            "repository's git config, so every fetch from it, in GitGlasses or in a terminal, " +
            'also brings the AI provenance notes git-ai records for commits. They are stored in ' +
            `${tracking}, so this repository's own ${GIT_AI_NOTES_REF} is never overwritten. ` +
            'GitGlasses reads both and shows what they declare.',
        },
        add,
        addAndFetch,
      );
      if (choice !== add && choice !== addAndFetch) return;

      const { added, trackingRef } = await engine.request('notes/addFetchRefspec', {
        repoId: repo.repoId,
        remote,
        ref: GIT_AI_NOTES_REF,
      });
      log(
        added
          ? `provenance: remote ${remote} now fetches ${GIT_AI_NOTES_REF} into ${trackingRef}`
          : `provenance: remote ${remote} already fetches ${GIT_AI_NOTES_REF} into ${trackingRef}`,
      );
      if (choice === addAndFetch) {
        await fetch(engine, repo, false);
        return;
      }
      void vscode.window.showInformationMessage(
        added
          ? `GitGlasses: fetches from ${remote} now bring git-ai notes.`
          : `GitGlasses: fetches from ${remote} already bring git-ai notes.`,
      );
    } catch (error) {
      log(`provenance: adding the git-ai notes refspec failed: ${errorMessage(error)}`);
      void vscode.window.showErrorMessage(
        `GitGlasses: could not set up fetching git-ai notes: ${errorMessage(error)}`,
      );
    }
  };
  return [vscode.commands.registerCommand(FETCH_NOTES_COMMAND, fetchNotes)];
}
