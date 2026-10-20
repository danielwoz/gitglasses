// What each sidebar view shows instead of an empty tree (no vscode imports):
// no repository in the workspace, an engine that does not answer, or a view
// with nothing in it yet. They render as tree items, not as contributed
// welcome content: Eclipse Theia shows a view's welcome content in place of
// its tree for good when the view is created before its data provider
// registers, which is the norm for a view container that is not open at
// startup, so a view with welcome content never shows its data there.

export type ViewState = 'ready' | 'noRepository' | 'engineUnavailable';

export interface StateLine {
  label: string;
  /** Codicon id. */
  icon: string;
  /** Command run on click; a line without one is a message. */
  command?: string;
  description?: string;
  tooltip?: string;
}

/** What the host offers, which decides the actions worth showing. */
export interface StateHost {
  /** VS Code's Git extension is installed, so git.clone and the like exist. */
  hasBuiltinGit: boolean;
  /** The workspace is trusted, so commands that run git are enabled. */
  trusted: boolean;
}

const NO_REPOSITORY = 'No git repository in this workspace';

function noRepository(host: StateHost): StateLine[] {
  const lines: StateLine[] = [
    { label: NO_REPOSITORY, icon: 'info' },
    { label: 'Open Folder…', icon: 'folder-opened', command: 'workbench.action.files.openFolder' },
  ];
  if (host.hasBuiltinGit) {
    lines.push({ label: 'Clone Repository…', icon: 'repo-clone', command: 'git.clone' });
  }
  return lines;
}

function engineUnavailable(): StateLine[] {
  return [
    {
      label: 'The GitGlasses engine is not responding',
      icon: 'warning',
      tooltip:
        'Nothing can be read from git until it restarts. The GitGlasses output channel says why.',
    },
    { label: 'Restart Engine', icon: 'debug-restart', command: 'gitglasses.restartEngine' },
  ];
}

/** A ready view with nothing to list. */
function empty(viewId: string, host: StateHost): StateLine[] {
  switch (viewId) {
    case 'gitglasses.views.home':
      return [
        { label: 'Show Commit Graph', icon: 'git-branch', command: 'gitglasses.showGraph' },
        { label: 'Get Started', icon: 'star', command: 'gitglasses.openWalkthrough' },
      ];
    case 'gitglasses.views.commits':
    case 'gitglasses.views.contributors':
      return [{ label: 'No commits yet', icon: 'info' }];
    case 'gitglasses.views.branches':
      return [
        {
          label: 'No branches yet',
          icon: 'info',
          tooltip: 'The first commit creates the branch HEAD names.',
        },
      ];
    case 'gitglasses.views.remotes':
      return host.hasBuiltinGit
        ? [
            { label: 'No remotes configured', icon: 'info' },
            { label: 'Add Remote…', icon: 'add', command: 'git.addRemote' },
          ]
        : [{ label: 'No remotes configured', icon: 'info' }];
    case 'gitglasses.views.stashes':
      return [{ label: 'No stashes', icon: 'info', tooltip: 'Stashes you create appear here.' }];
    case 'gitglasses.views.tags':
      return [{ label: 'No tags yet', icon: 'info' }];
    case 'gitglasses.views.fileHistory':
      return host.trusted
        ? [
            { label: 'Open a file to see its history', icon: 'info' },
            {
              label: 'Show Visual File History',
              icon: 'graph-scatter',
              command: 'gitglasses.showFileHistory',
            },
          ]
        : [{ label: 'Open a file to see its history', icon: 'info' }];
    case 'gitglasses.views.searchCompare':
      return [
        {
          label: 'Search Commits…',
          icon: 'search',
          command: 'gitglasses.searchCommits',
          tooltip: 'Search commits by message, author, code change, file or date.',
        },
        {
          label: 'AI Search Commits…',
          icon: 'sparkle',
          command: 'gitglasses.ai.nlSearch',
          tooltip: 'Describe the change you are looking for in plain language.',
        },
      ];
    case 'gitglasses.views.worktrees':
      return host.trusted
        ? [
            {
              label: 'Add Worktree…',
              icon: 'add',
              command: 'gitglasses.worktrees.add',
              tooltip: 'Worktrees check out several branches at once, without stashing.',
            },
          ]
        : [{ label: 'No other worktrees', icon: 'info' }];
    default:
      return [];
  }
}

/** The lines a view shows when its tree is empty, for the workspace's state
 *  (undefined before any view has resolved a repository). */
export function stateLines(
  viewId: string,
  state: ViewState | undefined,
  host: StateHost,
): StateLine[] {
  if (state === 'noRepository') return noRepository(host);
  if (state === 'engineUnavailable') return engineUnavailable();
  return empty(viewId, host);
}

/** Why a view could not list its contents. */
export interface ViewFailure {
  /** The engine refused the request because the workspace is not trusted. */
  restricted: boolean;
  message: string;
}

/** The lines a view shows when its own request failed. */
export function failureLines(failure: ViewFailure): StateLine[] {
  if (failure.restricted) {
    return [
      {
        label: 'Needs a trusted workspace',
        icon: 'shield',
        tooltip: 'GitGlasses runs no git commands in Restricted Mode, and this view needs git.',
      },
      {
        label: 'Manage Workspace Trust',
        icon: 'workspace-trusted',
        command: 'workbench.trust.manage',
      },
    ];
  }
  return [
    { label: 'Could not load this view', icon: 'warning', tooltip: failure.message },
    { label: 'Retry', icon: 'refresh', command: 'gitglasses.refreshViews' },
  ];
}
