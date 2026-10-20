// Git Graph's public settings and what they become in GitGlasses (no vscode
// imports). The table lists every setting Git Graph 1.30.0 contributes,
// deprecated spellings included, so a migration can say what happened to
// each one the user had set.

/** How a Git Graph setting carries over. */
export type GitGraphMapping =
  /** Copied into a GitGlasses setting, converted by `convert`. */
  | { kind: 'setting'; target: string; convert: (value: unknown) => unknown | undefined }
  /** No GitGlasses setting; `note` says what GitGlasses does instead. */
  | { kind: 'note'; note: string }
  /** No GitGlasses equivalent. */
  | { kind: 'none' };

/** A whole number within bounds, or undefined when it cannot be one. */
function clampedInteger(min: number, max: number): (value: unknown) => unknown | undefined {
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
}

const GRAPH_PAGE = {
  kind: 'setting',
  target: 'gitglasses.graph.pageSize',
  convert: clampedInteger(50, 5000),
} as const;

const SIGNING = {
  kind: 'note',
  note: 'GitGlasses commits and tags with git, which signs them when commit.gpgSign or tag.gpgSign is set in your git config.',
} as const;

const SCM_BUTTON = {
  kind: 'note',
  note: 'GitGlasses puts a Show Commit Graph button in the Source Control title bar, and the Commit Graph opens from the GitGlasses views and the command palette.',
} as const;

const FETCH_PRUNE = {
  kind: 'note',
  note: 'GitGlasses: Git Commands offers Fetch and Fetch (prune) each time.',
} as const;

const NONE = { kind: 'none' } as const;

/** Every Git Graph 1.30.0 setting, by key without the `git-graph.` prefix. */
export const GIT_GRAPH_SETTINGS: Readonly<Record<string, GitGraphMapping>> = {
  'commitDetailsView.autoCenter': NONE,
  'commitDetailsView.fileView.fileTree.compactFolders': NONE,
  'commitDetailsView.fileView.type': NONE,
  'commitDetailsView.location': NONE,
  contextMenuActionsVisibility: NONE,
  customBranchGlobPatterns: NONE,
  customEmojiShortcodeMappings: NONE,
  customPullRequestProviders: {
    kind: 'note',
    note: 'GitGlasses finds pull requests through its integrations: GitGlasses: Connect Integration… sets up GitHub, GitLab, Bitbucket, Azure DevOps and self-hosted servers.',
  },
  'date.format': NONE,
  'date.type': NONE,
  defaultColumnVisibility: NONE,
  'dialog.addTag.pushToRemote': NONE,
  'dialog.addTag.type': NONE,
  'dialog.applyStash.reinstateIndex': NONE,
  'dialog.cherryPick.noCommit': NONE,
  'dialog.cherryPick.recordOrigin': NONE,
  'dialog.createBranch.checkOut': NONE,
  'dialog.deleteBranch.forceDelete': NONE,
  'dialog.fetchIntoLocalBranch.forceFetch': NONE,
  'dialog.fetchRemote.prune': FETCH_PRUNE,
  'dialog.fetchRemote.pruneTags': NONE,
  'dialog.general.referenceInputSpaceSubstitution': NONE,
  'dialog.merge.noCommit': NONE,
  'dialog.merge.noFastForward': NONE,
  'dialog.merge.squashCommits': NONE,
  'dialog.merge.squashMessageFormat': NONE,
  'dialog.popStash.reinstateIndex': NONE,
  'dialog.pullBranch.noFastForward': NONE,
  'dialog.pullBranch.squashCommits': NONE,
  'dialog.pullBranch.squashMessageFormat': NONE,
  'dialog.rebase.ignoreDate': NONE,
  'dialog.rebase.launchInteractiveRebase': {
    kind: 'note',
    note: 'GitGlasses: Interactive Rebase… opens the rebase editor; rebasing from GitGlasses: Git Commands opens it as well.',
  },
  'dialog.resetCurrentBranchToCommit.mode': NONE,
  'dialog.resetUncommittedChanges.mode': NONE,
  'dialog.stashUncommittedChanges.includeUntracked': NONE,
  enhancedAccessibility: NONE,
  fileEncoding: NONE,
  'graph.colours': NONE,
  'graph.style': NONE,
  'graph.uncommittedChanges': NONE,
  integratedTerminalShell: NONE,
  'keyboardShortcut.find': NONE,
  'keyboardShortcut.refresh': NONE,
  'keyboardShortcut.scrollToHead': NONE,
  'keyboardShortcut.scrollToStash': NONE,
  markdown: NONE,
  maxDepthOfRepoSearch: {
    kind: 'note',
    note: 'GitGlasses finds repositories the way VS Code’s Git extension does, following git.repositoryScanMaxDepth.',
  },
  openNewTabEditorGroup: NONE,
  openToTheRepoOfTheActiveTextEditorDocument: NONE,
  'referenceLabels.alignment': NONE,
  'referenceLabels.combineLocalAndRemoteBranchLabels': NONE,
  'repository.commits.fetchAvatars': NONE,
  'repository.commits.initialLoad': GRAPH_PAGE,
  'repository.commits.loadMore': NONE,
  'repository.commits.loadMoreAutomatically': NONE,
  'repository.commits.mute.commitsThatAreNotAncestorsOfHead': NONE,
  'repository.commits.mute.mergeCommits': NONE,
  'repository.commits.order': NONE,
  'repository.commits.showSignatureStatus': NONE,
  'repository.fetchAndPrune': FETCH_PRUNE,
  'repository.fetchAndPruneTags': NONE,
  'repository.includeCommitsMentionedByReflogs': NONE,
  'repository.onLoad.scrollToHead': NONE,
  'repository.onLoad.showCheckedOutBranch': NONE,
  'repository.onLoad.showSpecificBranches': NONE,
  'repository.onlyFollowFirstParent': NONE,
  'repository.showCommitsOnlyReferencedByTags': NONE,
  'repository.showRemoteBranches': NONE,
  'repository.showRemoteHeads': NONE,
  'repository.showStashes': NONE,
  'repository.showTags': NONE,
  'repository.showUncommittedChanges': NONE,
  'repository.showUntrackedFiles': NONE,
  'repository.sign.commits': SIGNING,
  'repository.sign.tags': SIGNING,
  'repository.useMailmap': NONE,
  repositoryDropdownOrder: NONE,
  retainContextWhenHidden: NONE,
  showStatusBarItem: SCM_BUTTON,
  sourceCodeProviderIntegrationLocation: SCM_BUTTON,
  tabIconColourTheme: NONE,
  // Spellings Git Graph deprecated but still reads.
  autoCenterCommitDetailsView: NONE,
  combineLocalAndRemoteBranchLabels: NONE,
  commitDetailsViewFileTreeCompactFolders: NONE,
  commitDetailsViewLocation: NONE,
  commitOrdering: NONE,
  dateFormat: NONE,
  dateType: NONE,
  defaultFileViewType: NONE,
  fetchAndPrune: FETCH_PRUNE,
  fetchAvatars: NONE,
  graphColours: NONE,
  graphStyle: NONE,
  includeCommitsMentionedByReflogs: NONE,
  initialLoadCommits: GRAPH_PAGE,
  loadMoreCommits: NONE,
  loadMoreCommitsAutomatically: NONE,
  muteCommitsThatAreNotAncestorsOfHead: NONE,
  muteMergeCommits: NONE,
  onlyFollowFirstParent: NONE,
  openDiffTabLocation: NONE,
  openRepoToHead: NONE,
  referenceLabelAlignment: NONE,
  showCommitsOnlyReferencedByTags: NONE,
  showCurrentBranchByDefault: NONE,
  showSignatureStatus: NONE,
  showTags: NONE,
  showUncommittedChanges: NONE,
  showUntrackedFiles: NONE,
  useMailmap: NONE,
};

/** Where a value is set; the migration writes the copy at the same level. */
export type SettingLevel = 'user' | 'workspace';

/** A Git Graph value the user set, as the settings report it. */
export interface SetValue {
  key: string;
  level: SettingLevel;
  value: unknown;
}

export interface MigrationPlan {
  /** Values to copy into GitGlasses settings. */
  apply: Array<{ from: string; to: string; level: SettingLevel; value: unknown }>;
  /** Set values with no GitGlasses setting, with what to know about each. */
  unmapped: Array<{ from: string; level: SettingLevel; value: unknown; note?: string }>;
}

/**
 * What a migration does with the Git Graph values the user set. A mapping
 * counts only when its target is a setting this build contributes
 * (`ourSettings`); otherwise the value is reported as having no equivalent.
 * When a setting and its deprecated spelling map to one target at the same
 * level, the current spelling wins.
 */
export function planGitGraphMigration(
  values: readonly SetValue[],
  ourSettings: ReadonlySet<string>,
): MigrationPlan {
  const plan: MigrationPlan = { apply: [], unmapped: [] };
  const ordered = [...values].sort(
    (a, b) => Number(isDeprecated(a.key)) - Number(isDeprecated(b.key)),
  );
  for (const { key, level, value } of ordered) {
    const from = `git-graph.${key}`;
    const mapping = GIT_GRAPH_SETTINGS[key] ?? NONE;
    if (mapping.kind === 'setting' && ourSettings.has(mapping.target)) {
      const converted = mapping.convert(value);
      const taken = plan.apply.some(
        (entry) => entry.to === mapping.target && entry.level === level,
      );
      if (converted !== undefined && !taken) {
        plan.apply.push({ from, to: mapping.target, level, value: converted });
        continue;
      }
      if (converted !== undefined && taken) continue;
    }
    plan.unmapped.push({
      from,
      level,
      value,
      note: mapping.kind === 'note' ? mapping.note : undefined,
    });
  }
  return plan;
}

const DEPRECATED = new Set([
  'autoCenterCommitDetailsView',
  'combineLocalAndRemoteBranchLabels',
  'commitDetailsViewFileTreeCompactFolders',
  'commitDetailsViewLocation',
  'commitOrdering',
  'dateFormat',
  'dateType',
  'defaultFileViewType',
  'fetchAndPrune',
  'fetchAvatars',
  'graphColours',
  'graphStyle',
  'includeCommitsMentionedByReflogs',
  'initialLoadCommits',
  'loadMoreCommits',
  'loadMoreCommitsAutomatically',
  'muteCommitsThatAreNotAncestorsOfHead',
  'muteMergeCommits',
  'onlyFollowFirstParent',
  'openDiffTabLocation',
  'openRepoToHead',
  'referenceLabelAlignment',
  'showCommitsOnlyReferencedByTags',
  'showCurrentBranchByDefault',
  'showSignatureStatus',
  'showTags',
  'showUncommittedChanges',
  'showUntrackedFiles',
  'useMailmap',
]);

function isDeprecated(key: string): boolean {
  return DEPRECATED.has(key);
}

function formatValue(value: unknown): string {
  return '`' + JSON.stringify(value) + '`';
}

/** The migration report, as Markdown. */
export function renderMigrationReport(plan: MigrationPlan, applied: boolean): string {
  const lines = ['# Coming from Git Graph', ''];
  if (plan.apply.length === 0 && plan.unmapped.length === 0) {
    lines.push(
      'None of your settings are Git Graph settings, so there was nothing to carry over.',
      '',
    );
  }
  if (plan.apply.length > 0) {
    lines.push(applied ? '## Copied to GitGlasses' : '## Not copied (cancelled)', '');
    for (const entry of plan.apply) {
      lines.push(
        `- \`${entry.from}\` → \`${entry.to}\` = ${formatValue(entry.value)} (${entry.level} settings)`,
      );
    }
    lines.push('');
  }
  if (plan.unmapped.length > 0) {
    lines.push('## No GitGlasses setting', '');
    for (const entry of plan.unmapped) {
      lines.push(
        `- \`${entry.from}\` = ${formatValue(entry.value)}` + (entry.note ? `: ${entry.note}` : ''),
      );
    }
    lines.push('');
  }
  lines.push(
    '## Where things are',
    '',
    '- **GitGlasses: Show Commit Graph** opens the graph in an editor tab; the Source Control view’s title bar has a button for it too.',
    '- GitGlasses keyboard shortcuts are off until you turn on `gitglasses.keyboardShortcuts.enabled`; they then start with Ctrl+Alt+G (⌥⌘G on macOS).',
    '- Your Git Graph settings are left as they were.',
    '',
  );
  return lines.join('\n');
}
