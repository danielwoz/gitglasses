// Pure text and decisions for push, pull, fetch and for operations that stop
// half-way (no vscode imports): what a git failure means for the user and
// which next steps to offer, from the GitErrorData the engine attaches.

import type { GitErrorData, SequencerOperation } from '@gitglasses/protocol';

/** The GitErrorData an engine error carries, if any. */
export function gitErrorData(error: unknown): GitErrorData | undefined {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  return typeof (data as { kind?: unknown }).kind === 'string' ? (data as GitErrorData) : undefined;
}

/** git's own words from an engine error, without the noise around them:
 *  the "git push failed (128):" prefix, hints, and the askpass shim's
 *  complaint about a prompt that was not answered. */
export function gitMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const body = raw.replace(/^git [\w-]+(?: --?[\w-]+)? failed \(-?\d+\): /, '');
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('hint:') &&
        !line.startsWith('[GNUPG:]') &&
        !/unable to read askpass response/.test(line),
    );
  const text = lines.join(' ');
  return text.length > 400 ? `${text.slice(0, 397)}…` : text || raw;
}

const OPERATION_LABELS: Record<Exclude<SequencerOperation, 'none'>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
};

export function operationLabel(operation: SequencerOperation | undefined): string | undefined {
  return operation && operation !== 'none' ? OPERATION_LABELS[operation] : undefined;
}

/** A next step offered with a failure. */
export type FailureAction =
  'retry' | 'showLog' | 'pull' | 'publish' | 'continue' | 'skip' | 'abort' | 'openConflicts';

export interface FailurePresentation {
  message: string;
  actions: { label: string; action: FailureAction }[];
  /** The user dismissed a prompt: there is nothing to report. */
  silent: boolean;
}

const SHOW_LOG = { label: 'Show Log', action: 'showLog' as const };
const RETRY = { label: 'Retry', action: 'retry' as const };

/** The continue/skip/abort steps for an operation left in progress. */
export function operationActions(
  operation: SequencerOperation | undefined,
  options: { canContinue?: boolean } = {},
): FailurePresentation['actions'] {
  const label = operationLabel(operation);
  if (!label) return [];
  const actions: FailurePresentation['actions'] = [];
  if (options.canContinue !== false) actions.push({ label: 'Continue', action: 'continue' });
  if (operation !== 'merge') actions.push({ label: 'Skip Commit', action: 'skip' });
  actions.push({ label: `Abort ${label}`, action: 'abort' });
  return actions;
}

/**
 * What to tell the user about a failed `label` (Push, Pull, Commit, …) and
 * which next steps to offer. `canRetry` says whether the caller can run the
 * same action again.
 */
export function describeFailure(
  label: string,
  error: unknown,
  options: { canRetry?: boolean } = {},
): FailurePresentation {
  const data = gitErrorData(error);
  const where = data?.host ?? 'the remote';
  const retry = options.canRetry ? [RETRY] : [];
  const stoppedIn = operationLabel(data?.operation);
  const present = (
    message: string,
    actions: FailurePresentation['actions'],
  ): FailurePresentation => ({ message, actions, silent: false });

  if (data?.sshProgram === 'plink' && data.kind !== 'cancelled') {
    return present(
      `${label} failed: git uses PuTTY's plink for ssh, and plink cannot ask for passwords or ` +
        'passphrases here. Load your key into Pageant, or let git use OpenSSH.',
      [...retry, SHOW_LOG],
    );
  }
  switch (data?.kind) {
    case 'cancelled':
      return { message: `${label} cancelled.`, actions: [], silent: true };
    case 'auth':
      return present(
        data.partialClone
          ? `${where} did not accept the credentials needed to download objects this partial clone left out.`
          : `${label} failed: ${where} did not accept the credentials.`,
        [...retry, SHOW_LOG],
      );
    case 'hostKey':
      return present(
        `${label} failed: the ssh host key of ${where} could not be verified. If the server's ` +
          'key changed on purpose, remove its old entry from known_hosts; otherwise do not connect.',
        [SHOW_LOG],
      );
    case 'publickey':
      return present(
        `${label} failed: the ssh server accepted none of your keys. Add your key to ssh-agent, ` +
          'or register it with the server.',
        [...retry, SHOW_LOG],
      );
    case 'signing':
      return present(
        `${label} failed: the commit could not be signed. For a gpg key with a passphrase, set ` +
          'up a graphical pinentry (pinentry-program in gpg-agent.conf) or unlock the key in ' +
          'gpg-agent; for an ssh key, add it to ssh-agent.',
        [...operationActions(data.operation), ...(data.operation ? [] : retry), SHOW_LOG],
      );
    case 'rejected':
      return present(
        `${label} was rejected: the remote branch has commits you do not have. Pull them, then ` +
          'push again.',
        [{ label: 'Pull', action: 'pull' }, SHOW_LOG],
      );
    case 'noUpstream':
      return present(`${label} failed: the branch tracks no remote branch. Publish it first.`, [
        { label: 'Publish Branch', action: 'publish' },
      ]);
    case 'noRemote':
      return present(
        'This repository has no remote to publish to. Add one with `git remote add`, then try ' +
          'again.',
        [],
      );
    case 'network':
      return present(`${label} failed: could not reach ${where}.`, [...retry, SHOW_LOG]);
    case 'timeout':
      return present(`${label} took too long and was stopped.`, [...retry, SHOW_LOG]);
    case 'divergent':
      return present(`${label} failed: your branch and its remote branch have diverged.`, [
        { label: 'Pull', action: 'pull' },
        SHOW_LOG,
      ]);
    case 'emptyCommit':
      return present(
        `${stoppedIn ?? label} stopped: the commit is already applied, so picking it would ` +
          'change nothing.',
        [...operationActions(data.operation, { canContinue: false }), SHOW_LOG],
      );
    default:
      break;
  }
  if (stoppedIn) {
    return present(`${stoppedIn} stopped: ${gitMessage(error)}`, [
      ...operationActions(data?.operation),
      SHOW_LOG,
    ]);
  }
  return present(`${label} failed: ${gitMessage(error)}`, [...retry, SHOW_LOG]);
}

/** A way to reconcile a diverged branch, as the pull picker offers it. */
export interface PullChoice {
  label: string;
  description: string;
  detail?: string;
  strategy: 'merge' | 'rebase' | 'ff-only';
  remember: boolean;
}

/** The choices offered when a pull found the branches diverged. */
export function divergedPullChoices(): PullChoice[] {
  return [
    {
      label: '$(git-merge) Merge',
      description: 'git pull --no-rebase',
      detail: 'Combine both histories with a merge commit.',
      strategy: 'merge',
      remember: false,
    },
    {
      label: '$(git-commit) Rebase',
      description: 'git pull --rebase',
      detail: 'Replay your commits on top of the remote branch.',
      strategy: 'rebase',
      remember: false,
    },
    {
      label: 'Always Merge in This Repository',
      description: 'sets pull.rebase false',
      strategy: 'merge',
      remember: true,
    },
    {
      label: 'Always Rebase in This Repository',
      description: 'sets pull.rebase true',
      strategy: 'rebase',
      remember: true,
    },
  ];
}

/** The pull variants the Git Commands palette offers. */
export function pullVariants(): (Omit<PullChoice, 'strategy'> & {
  strategy?: PullChoice['strategy'];
})[] {
  return [
    {
      label: 'Pull',
      description: 'git pull --autostash',
      detail: "Uses the repository's configured way of reconciling a diverged branch.",
      remember: false,
    },
    {
      label: 'Pull (Merge)',
      description: 'git pull --no-rebase',
      strategy: 'merge',
      remember: false,
    },
    {
      label: 'Pull (Rebase)',
      description: 'git pull --rebase',
      strategy: 'rebase',
      remember: false,
    },
    {
      label: 'Pull (Fast-forward Only)',
      description: 'git pull --ff-only',
      detail: 'Stops instead of merging or rebasing when the branches diverged.',
      strategy: 'ff-only',
      remember: false,
    },
  ];
}
