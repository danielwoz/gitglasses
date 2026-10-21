// Actions on the Branches, Remotes, Tags and Stashes views: switching,
// creating, renaming, deleting, merging, rebasing, pushing and comparing
// branches; creating, pushing and deleting tags; applying, popping, dropping,
// showing and creating stashes; fetching, pruning, adding, removing and
// opening remotes. Each acts on the repository its node came from, or on the
// active repository when run from a view's title bar.

import * as vscode from 'vscode';
import type { EngineClient } from '@gitglasses/rpc';
import type { RepositoryService } from '../model/repositoryService';
import type { IntegrationService } from '../integrations/integrationService';
import { hostingForUrl, type HostingEntry } from '../integrations/providerSetup';
import { buildRemoteUrl, type RemoteTarget } from '../integrations/remoteUrls';
import { encodeRevisionUri } from '../scm/revisionContentProvider';
import { allowedDespiteConflicts } from '../commands/conflictGuard';
import { confirmMerge, confirmStashDrop } from '../commands/confirmations';
import {
  confirmDestructive,
  setStatus,
  showConflictGuidance,
  showInput,
  showPick,
} from '../commands/ui';
import { ActiveRepo, requireRepo } from './viewBase';
import { RefNode, SHOW_STASH_COMMAND, isRefNode, refLabel, refRevision } from './refsViews';
import {
  CompareEntry,
  canOfferPublish,
  compareEntries,
  confirmRemoteRemove,
  splitRemoteBranch,
  workingTreeCompareEntries,
} from './refActionsLogic';
import { LogFn, reportGitError } from './errorReport';
import * as refs from './refOperations';

export interface RefCommandDeps {
  engine: EngineClient;
  repos: RepositoryService;
  integrations: IntegrationService;
  log: LogFn;
  /** Re-renders the views after a change; the watcher may lag behind. */
  refresh(): void;
  /** Opens the interactive rebase editor onto `upstream`. */
  openRebase(upstream: string): void | Promise<void>;
}

/** Revision side of a comparison that is the working tree. */
const WORKING_TREE = Symbol('working tree');
type Side = string | typeof WORKING_TREE;

export function registerRefCommands(deps: RefCommandDeps): vscode.Disposable[] {
  const { engine, log } = deps;

  const repoOf = async (node?: unknown): Promise<ActiveRepo | undefined> =>
    isRefNode(node) ? node.repo : requireRepo(deps.repos);

  // Runs one action, reporting a failure with git's whole explanation.
  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      reportGitError(label, error, log);
    }
  };

  // Same, for an action that changes the repository: the views re-render
  // afterwards whether it succeeded or stopped part-way.
  const mutate = async (label: string, action: () => Promise<void>): Promise<void> => {
    await run(label, action);
    deps.refresh();
  };

  const remoteNames = (repo: ActiveRepo): Promise<string[]> =>
    refs.remoteNames(engine, repo.repoId);

  const currentBranchName = async (repo: ActiveRepo): Promise<string> => {
    const { head } = await engine.request('repo/state', { repoId: repo.repoId });
    return head.detached || !head.branch ? 'HEAD' : head.branch;
  };

  // --- Comparisons -----------------------------------------------------------

  const workingTreeUri = (repo: ActiveRepo, path: string): vscode.Uri =>
    vscode.Uri.joinPath(vscode.Uri.file(repo.workspacePath ?? repo.rootPath), path);

  const sideUri = (repo: ActiveRepo, side: Side, path: string): vscode.Uri =>
    side === WORKING_TREE ? workingTreeUri(repo, path) : encodeRevisionUri(repo.repoId, path, side);

  // Opens the files in one multi-file diff editor, or lets the user pick one
  // file at a time on hosts without it.
  const openComparison = async (
    repo: ActiveRepo,
    title: string,
    entries: readonly CompareEntry[],
    left: Side,
    right: Side,
  ): Promise<void> => {
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(`GitGlasses: ${title}: no differences.`);
      return;
    }
    const resources = entries.map((entry) => [
      workingTreeUri(repo, entry.path),
      entry.left === undefined ? undefined : sideUri(repo, left, entry.left),
      entry.right === undefined ? undefined : sideUri(repo, right, entry.right),
    ]);
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
      return;
    } catch (error) {
      log(`multi-file diff unavailable, listing files instead: ${String(error)}`);
    }
    const picked = await showPick(
      entries.map((entry) => ({ label: entry.path, entry })),
      { title, placeholder: 'File to compare' },
    );
    if (picked === 'back' || !picked) return;
    const { entry } = picked;
    const leftUri = sideUri(repo, left, entry.left ?? entry.path);
    const rightUri = sideUri(repo, right, entry.right ?? entry.path);
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `${entry.path} (${title})`,
    );
  };

  const compareWithHead = (node?: unknown) =>
    run('Compare', async () => {
      if (!isRefNode(node)) return;
      const revision = refRevision(node.ref);
      if (!revision) return;
      const { files } = await engine.request('diff/refs', {
        repoId: node.repo.repoId,
        base: 'HEAD',
        head: revision,
      });
      await openComparison(
        node.repo,
        `HEAD ↔ ${refLabel(node.ref)}`,
        compareEntries(files),
        'HEAD',
        revision,
      );
    });

  const compareWithWorkingTree = (node?: unknown) =>
    run('Compare', async () => {
      if (!isRefNode(node)) return;
      const revision = refRevision(node.ref);
      if (!revision) return;
      const repoId = node.repo.repoId;
      const [{ files }, status] = await Promise.all([
        engine.request('diff/refs', { repoId, base: revision, head: 'HEAD' }),
        engine.request('status/summary', { repoId }),
      ]);
      await openComparison(
        node.repo,
        `${refLabel(node.ref)} ↔ Working Tree`,
        workingTreeCompareEntries(files, status),
        revision,
        WORKING_TREE,
      );
    });

  // --- Remote URLs -----------------------------------------------------------

  const openRemoteTarget = async (
    repo: ActiveRepo,
    remote: string,
    target: RemoteTarget,
  ): Promise<void> => {
    const { remotes } = await engine.request('remote/list', { repoId: repo.repoId });
    const url = remotes.find((r) => r.name === remote)?.fetchUrl;
    if (!url) {
      void vscode.window.showInformationMessage(`GitGlasses: remote '${remote}' has no URL.`);
      return;
    }
    const entries = new Map<string, HostingEntry>(
      deps.integrations.getHostingEntries().map((entry) => [entry.host, entry]),
    );
    const hosting = hostingForUrl(entries, url);
    const web = hosting && buildRemoteUrl(hosting.providerId, hosting.repo, target);
    if (web) {
      await vscode.env.openExternal(vscode.Uri.parse(web));
      return;
    }
    // An unrecognised host still has a web page when its URL is http(s).
    if (target.kind === 'repo' && /^https?:\/\//i.test(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(url.replace(/\.git$/, '')));
      return;
    }
    void vscode.window.showInformationMessage(
      `GitGlasses: no known web page for ${remote} (${url}).`,
    );
  };

  const openBranchOnRemote = (node?: unknown) =>
    run('Open on remote', async () => {
      if (!isRefNode(node)) return;
      const { ref, repo } = node;
      if (ref.kind === 'remoteBranch') {
        await openRemoteTarget(repo, ref.remote, { kind: 'branch', branch: ref.name });
        return;
      }
      if (ref.kind !== 'branch') return;
      const tracked = ref.upstream && splitRemoteBranch(ref.upstream, await remoteNames(repo));
      if (!tracked) {
        const message = `GitGlasses: '${ref.name}' is not on a remote yet.`;
        if (!canOfferPublish(vscode.workspace.isTrusted, engine.capabilities())) {
          void vscode.window.showInformationMessage(message);
          return;
        }
        const choice = await vscode.window.showInformationMessage(message, 'Publish Branch');
        if (choice) await vscode.commands.executeCommand('gitglasses.branch.push', node);
        return;
      }
      await openRemoteTarget(repo, tracked.remote, { kind: 'branch', branch: tracked.branch });
    });

  // --- Branches --------------------------------------------------------------

  const checkoutBranch = (node?: unknown) =>
    mutate('Switch branch', async () => {
      if (!isRefNode(node)) return;
      const { ref, repo } = node;
      if (!(await allowedDespiteConflicts(engine, repo.repoId, 'switch'))) return;
      if (ref.kind === 'branch') {
        await engine.request('mutate/switch', { repoId: repo.repoId, ref: ref.name });
        setStatus(`Switched to '${ref.name}'`);
        return;
      }
      if (ref.kind !== 'remoteBranch') return;
      // A remote branch is checked out as a local branch tracking it.
      const tracking = `${ref.remote}/${ref.name}`;
      const { branches } = await engine.request('refs/list', { repoId: repo.repoId });
      let local = ref.name;
      const existing = branches.find((branch) => branch.name === local);
      if (existing?.upstream === tracking) {
        await engine.request('mutate/switch', { repoId: repo.repoId, ref: local });
        setStatus(`Switched to '${local}'`);
        return;
      }
      if (existing) {
        const name = await showInput({
          title: `Switch to ${tracking}`,
          prompt: `A local '${local}' already exists and does not track ${tracking}. Name for a new local branch that does:`,
          value: `${ref.remote}-${ref.name}`,
          validate: (value) => {
            const trimmed = value.trim();
            if (!trimmed) return 'Branch name is required';
            return branches.some((branch) => branch.name === trimmed)
              ? `'${trimmed}' already exists`
              : undefined;
          },
        });
        if (name === 'back' || name === undefined) return;
        local = name.trim();
      }
      await engine.request('mutate/branchCreate', {
        repoId: repo.repoId,
        name: local,
        startPoint: tracking,
        checkout: true,
      });
      await engine.request('branch/setUpstream', {
        repoId: repo.repoId,
        name: local,
        upstream: tracking,
      });
      setStatus(`Switched to new branch '${local}' tracking ${tracking}`);
    });

  const createBranch = (node?: unknown) =>
    mutate('Create branch', async () => {
      const repo = await repoOf(node);
      if (!repo) return;
      const startPoint = isRefNode(node) ? refRevision(node.ref) : undefined;
      const from = isRefNode(node) ? refLabel(node.ref) : 'HEAD';
      const name = await showInput({
        title: `Create Branch from ${from}`,
        prompt: 'Branch name',
        validate: (value) =>
          !value.trim()
            ? 'Branch name is required'
            : /\s/.test(value.trim())
              ? 'Branch names cannot contain spaces'
              : undefined,
      });
      if (name === 'back' || name === undefined) return;
      const picked = await showPick(
        [
          { label: 'Create and Switch', checkout: true },
          { label: 'Create Only', checkout: false },
        ],
        { title: `Create Branch '${name.trim()}'`, placeholder: `From ${from}` },
      );
      if (picked === 'back' || !picked) return;
      await engine.request('mutate/branchCreate', {
        repoId: repo.repoId,
        name: name.trim(),
        startPoint,
        checkout: picked.checkout,
      });
      setStatus(`Created branch '${name.trim()}'`);
    });

  const renameBranch = (node?: unknown) =>
    mutate('Rename branch', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'branch') return;
      await refs.renameBranch(deps, node.repo.repoId, node.ref.name);
    });

  const deleteBranch = (node?: unknown) =>
    mutate('Delete branch', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'branch') return;
      await refs.deleteBranch(deps, node.repo.repoId, node.ref.name);
    });

  const mergeIntoCurrent = (node?: unknown) =>
    mutate('Merge', async () => {
      if (!isRefNode(node)) return;
      const revision = refRevision(node.ref);
      if (!revision) return;
      const repoId = node.repo.repoId;
      if (!(await allowedDespiteConflicts(engine, repoId, 'merge'))) return;
      const into = await currentBranchName(node.repo);
      const label = refLabel(node.ref);
      if (!(await confirmDestructive(confirmMerge(label, into)))) return;
      const { conflicts } = await engine.request('mutate/merge', { repoId, ref: revision });
      if (conflicts) showConflictGuidance('Merge');
      else setStatus(`Merged '${label}' into '${into}'`);
    });

  const rebaseCurrentOnto = (node?: unknown) =>
    run('Rebase', async () => {
      if (!isRefNode(node)) return;
      const revision = node.ref.kind === 'branch' ? node.ref.name : refRevision(node.ref);
      if (revision) await deps.openRebase(revision);
    });

  const pushBranch = (node?: unknown) =>
    mutate('Push', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'branch') return;
      await refs.pushBranch(deps, node.repo.repoId, node.ref);
    });

  const setUpstream = (node?: unknown) =>
    mutate('Set upstream', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'branch') return;
      const { name, upstream } = node.ref;
      const { remotes } = await engine.request('refs/list', { repoId: node.repo.repoId });
      const candidates = remotes.flatMap((remote) =>
        remote.branches.map((branch) => `${remote.name}/${branch.name}`),
      );
      const unset = { label: '$(close) Stop Tracking', description: upstream, value: undefined };
      const items = [
        ...candidates.map((candidate) => ({
          label: candidate,
          description: candidate === upstream ? '(current)' : undefined,
          value: candidate as string | undefined,
        })),
        ...(upstream ? [unset] : []),
      ];
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          'GitGlasses: no remote branches to track; fetch or publish first.',
        );
        return;
      }
      const picked = await showPick(items, {
        title: `Upstream for '${name}'`,
        placeholder: 'Remote branch to track',
      });
      if (picked === 'back' || !picked) return;
      await engine.request('branch/setUpstream', {
        repoId: node.repo.repoId,
        name,
        upstream: picked.value,
      });
      setStatus(picked.value ? `'${name}' now tracks ${picked.value}` : `'${name}' tracks nothing`);
    });

  // --- Tags ------------------------------------------------------------------

  const createTag = (node?: unknown) =>
    mutate('Create tag', async () => {
      const repo = await repoOf(node);
      if (!repo) return;
      const revision = isRefNode(node) ? refRevision(node.ref) : undefined;
      await refs.createTag(
        deps,
        repo.repoId,
        isRefNode(node) && revision ? { revision, label: refLabel(node.ref) } : undefined,
      );
    });

  const deleteTag = (node?: unknown) =>
    mutate('Delete tag', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'tag') return;
      await refs.deleteTag(deps, node.repo.repoId, node.ref.name);
    });

  const pushTag = (node?: unknown, remove = false) =>
    mutate(remove ? 'Delete remote tag' : 'Push tag', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'tag') return;
      await refs.pushTag(deps, node.repo.repoId, node.ref.name, remove);
    });

  const checkoutTag = (node?: unknown) =>
    mutate('Check out tag', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'tag') return;
      if (!(await allowedDespiteConflicts(engine, node.repo.repoId, 'switch'))) return;
      await engine.request('mutate/switch', {
        repoId: node.repo.repoId,
        ref: `refs/tags/${node.ref.name}`,
      });
      void vscode.window.showInformationMessage(
        `GitGlasses: checked out '${node.ref.name}'. HEAD is detached; create a branch to keep new commits.`,
      );
    });

  // --- Stashes ---------------------------------------------------------------

  // A stash's position moves as stashes are added or dropped, so the entry
  // is found again by its commit before acting on it.
  const currentStashIndex = async (node: RefNode): Promise<number | undefined> => {
    const { entries } = await engine.request('stash/list', { repoId: node.repo.repoId });
    const entry = entries.find((candidate) => candidate.sha === node.sha);
    if (!entry) {
      void vscode.window.showWarningMessage(`GitGlasses: ${refLabel(node.ref)} no longer exists.`);
    }
    return entry?.index;
  };

  const applyStash = (node?: unknown, pop = false) =>
    mutate(pop ? 'Stash pop' : 'Stash apply', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'stash') return;
      const repoId = node.repo.repoId;
      if (!(await allowedDespiteConflicts(engine, repoId, 'stash'))) return;
      const index = await currentStashIndex(node);
      if (index === undefined) return;
      const { conflicts } = await engine.request('stash/apply', { repoId, index, pop });
      if (conflicts) showConflictGuidance(pop ? 'Stash pop' : 'Stash apply');
      else setStatus(`${pop ? 'Popped' : 'Applied'} stash@{${index}}`);
    });

  const dropStash = (node?: unknown) =>
    mutate('Stash drop', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'stash') return;
      const index = await currentStashIndex(node);
      if (index === undefined) return;
      if (!(await confirmDestructive(confirmStashDrop(index, node.ref.message)))) return;
      await engine.request('stash/drop', { repoId: node.repo.repoId, index });
      setStatus(`Dropped stash@{${index}}`);
    });

  const showStash = (node?: unknown) =>
    run('Show stash', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'stash' || !node.sha) return;
      const repoId = node.repo.repoId;
      const stashSha = node.sha;
      const details = await engine.request('commit/details', { repoId, sha: stashSha });
      const [base, , untrackedCommit] = details.parents;
      const tracked = compareEntries(details.files);
      // Untracked files a stash saved live in its third parent.
      const untracked = untrackedCommit
        ? (await engine.request('diff/commit', { repoId, sha: untrackedCommit })).files.map(
            (file) => ({ path: file.path, untracked: true }),
          )
        : [];
      const title = `stash@{${node.ref.index}}: ${node.ref.message}`;
      if (untracked.length === 0) {
        await openComparison(node.repo, title, tracked, base, stashSha);
        return;
      }
      // Tracked changes compare against the stash's base; untracked files
      // exist only in the untracked commit.
      const resources = [
        ...tracked.map((entry) => [
          workingTreeUri(node.repo, entry.path),
          entry.left === undefined ? undefined : encodeRevisionUri(repoId, entry.left, base),
          entry.right === undefined ? undefined : encodeRevisionUri(repoId, entry.right, stashSha),
        ]),
        ...untracked.map((file) => [
          workingTreeUri(node.repo, file.path),
          undefined,
          encodeRevisionUri(repoId, file.path, untrackedCommit),
        ]),
      ];
      try {
        await vscode.commands.executeCommand('vscode.changes', title, resources);
      } catch (error) {
        log(`multi-file diff unavailable, listing tracked files only: ${String(error)}`);
        await openComparison(node.repo, title, tracked, base, stashSha);
      }
    });

  const createStash = (includeUntracked: boolean) =>
    mutate('Stash', async () => {
      const repo = await requireRepo(deps.repos);
      if (!repo) return;
      if (!(await allowedDespiteConflicts(engine, repo.repoId, 'stash'))) return;
      const status = await engine.request('status/summary', { repoId: repo.repoId });
      const changed =
        status.staged.length +
        status.unstaged.length +
        (includeUntracked ? status.untracked.length : 0);
      if (changed === 0) {
        void vscode.window.showInformationMessage(
          includeUntracked || status.untracked.length === 0
            ? 'GitGlasses: no local changes to stash.'
            : 'GitGlasses: only untracked files changed; use Stash Including Untracked.',
        );
        return;
      }
      const message = await showInput({
        title: includeUntracked ? 'Stash Including Untracked Files' : 'Stash Changes',
        prompt: 'Stash message (optional)',
      });
      if (message === 'back' || message === undefined) return;
      await engine.request('stash/push', {
        repoId: repo.repoId,
        message: message.trim() || undefined,
        includeUntracked: includeUntracked || undefined,
      });
      setStatus('Stashed changes');
    });

  // --- Remotes ---------------------------------------------------------------

  const fetchRemote = (node?: unknown, prune = false) =>
    mutate(prune ? 'Fetch and prune' : 'Fetch', async () => {
      const repo = await repoOf(node);
      if (!repo) return;
      const remotes =
        isRefNode(node) && node.ref.kind === 'remote' ? [node.ref.name] : await remoteNames(repo);
      if (remotes.length === 0) {
        void vscode.window.showInformationMessage('GitGlasses: this repository has no remotes.');
        return;
      }
      await refs.withProgress(`Fetching ${remotes.join(', ')}…`, async (token) => {
        for (const remote of remotes) {
          if (token.isCancellationRequested) return;
          await engine.request('mutate/fetch', { repoId: repo.repoId, remote, prune }, token);
        }
      });
      setStatus(`Fetched ${remotes.join(', ')}${prune ? ' (pruned)' : ''}`);
    });

  const addRemote = () =>
    mutate('Add remote', async () => {
      const repo = await requireRepo(deps.repos);
      if (!repo) return;
      const existing = await remoteNames(repo);
      const name = await showInput({
        title: 'Add Remote',
        prompt: 'Remote name',
        value: existing.includes('origin') ? 'upstream' : 'origin',
        validate: (value) =>
          !value.trim()
            ? 'Remote name is required'
            : existing.includes(value.trim())
              ? `'${value.trim()}' already exists`
              : undefined,
      });
      if (name === 'back' || name === undefined) return;
      const url = await showInput({
        title: `Add Remote '${name.trim()}'`,
        prompt: 'URL (https://… or git@host:owner/repo.git)',
        validate: (value) => (value.trim() ? undefined : 'URL is required'),
      });
      if (url === 'back' || url === undefined) return;
      await engine.request('remote/add', {
        repoId: repo.repoId,
        name: name.trim(),
        url: url.trim(),
      });
      setStatus(`Added remote '${name.trim()}'`);
      deps.refresh();
      // A new remote shows nothing until it is fetched.
      await refs.withProgress(`Fetching ${name.trim()}…`, (token) =>
        engine.request('mutate/fetch', { repoId: repo.repoId, remote: name.trim() }, token),
      );
    });

  const removeRemote = (node?: unknown) =>
    mutate('Remove remote', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'remote') return;
      const { name } = node.ref;
      if (!(await confirmDestructive(confirmRemoteRemove(name)))) return;
      await engine.request('remote/remove', { repoId: node.repo.repoId, name });
      setStatus(`Removed remote '${name}'`);
    });

  const openRemoteOnHost = (node?: unknown) =>
    run('Open on remote', async () => {
      if (!isRefNode(node) || node.ref.kind !== 'remote') return;
      await openRemoteTarget(node.repo, node.ref.name, { kind: 'repo' });
    });

  const copyRefName = async (node?: unknown): Promise<void> => {
    if (!isRefNode(node)) return;
    const label = refLabel(node.ref);
    await vscode.env.clipboard.writeText(label);
    setStatus(`Copied ${label}`);
  };

  const command = (id: string, handler: (node?: unknown) => unknown) =>
    vscode.commands.registerCommand(id, handler);

  return [
    command('gitglasses.branch.checkout', checkoutBranch),
    command('gitglasses.branch.create', createBranch),
    command('gitglasses.branch.rename', renameBranch),
    command('gitglasses.branch.delete', deleteBranch),
    command('gitglasses.branch.merge', mergeIntoCurrent),
    command('gitglasses.branch.rebase', rebaseCurrentOnto),
    command('gitglasses.branch.push', pushBranch),
    command('gitglasses.branch.setUpstream', setUpstream),
    command('gitglasses.branch.openOnRemote', openBranchOnRemote),
    command('gitglasses.ref.compareWithHead', compareWithHead),
    command('gitglasses.ref.compareWithWorkingTree', compareWithWorkingTree),
    command('gitglasses.ref.copyName', copyRefName),
    command('gitglasses.tag.create', createTag),
    command('gitglasses.tag.delete', deleteTag),
    command('gitglasses.tag.push', (node) => pushTag(node, false)),
    command('gitglasses.tag.deleteRemote', (node) => pushTag(node, true)),
    command('gitglasses.tag.checkout', checkoutTag),
    command('gitglasses.stash.apply', (node) => applyStash(node, false)),
    command('gitglasses.stash.pop', (node) => applyStash(node, true)),
    command('gitglasses.stash.drop', dropStash),
    command(SHOW_STASH_COMMAND, showStash),
    command('gitglasses.stash.create', () => createStash(false)),
    command('gitglasses.stash.createIncludeUntracked', () => createStash(true)),
    command('gitglasses.remote.fetch', (node) => fetchRemote(node, false)),
    command('gitglasses.remote.prune', (node) => fetchRemote(node, true)),
    command('gitglasses.remote.add', addRemote),
    command('gitglasses.remote.remove', removeRemote),
    command('gitglasses.remote.openOnHost', openRemoteOnHost),
  ];
}
