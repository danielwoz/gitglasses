// Picker for the revision a rebase replays onto: the current branch's
// upstream, other branches and tags, or any revision the user types.

import * as vscode from 'vscode';
import type { EngineClient } from '@gitglasses/rpc';
import { shortSha } from '@gitglasses/protocol/sha';
import type { ActiveRepo } from './viewBase';
import { RefTarget, rebaseTargets } from './refActionsLogic';

const ICONS: Record<RefTarget['kind'], string> = {
  upstream: '$(arrow-up)',
  branch: '$(git-branch)',
  remoteBranch: '$(cloud)',
  tag: '$(tag)',
};

interface TargetItem extends vscode.QuickPickItem {
  value: string;
}

/** Resolves with the chosen revision, or undefined when dismissed. */
export async function pickRebaseTarget(
  engine: EngineClient,
  repo: ActiveRepo,
): Promise<string | undefined> {
  const refs = await engine.request('refs/list', { repoId: repo.repoId });
  const known: TargetItem[] = rebaseTargets(refs).map((target) => ({
    label: `${ICONS[target.kind]} ${target.value}`,
    description: `${shortSha(target.sha)}${target.kind === 'upstream' ? ' · upstream' : ''}`,
    value: target.value,
  }));
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<TargetItem>();
    picker.title = 'Interactive Rebase';
    picker.placeholder = 'Rebase the current branch onto… (or type any revision)';
    picker.items = known;
    picker.matchOnDescription = true;
    let settled = false;
    const settle = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      picker.dispose();
    };
    // A typed revision that names no listed ref is offered as is.
    picker.onDidChangeValue((value) => {
      const typed = value.trim();
      const listed = known.some((item) => item.value === typed);
      picker.items =
        typed && !listed
          ? [
              { label: `$(edit) ${typed}`, description: 'Use this revision', value: typed },
              ...known,
            ]
          : known;
    });
    picker.onDidAccept(() => settle(picker.selectedItems[0]?.value));
    picker.onDidHide(() => settle(undefined));
    picker.show();
  });
}
